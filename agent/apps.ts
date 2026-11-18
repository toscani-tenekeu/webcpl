// Node.js, Python and Ruby apps. Each one is a systemd service that runs as its account,
// inside the account's slice, on a private port that nginx proxies to.
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { type Args, homePath, must, removeFile, run, username, writeAtomic } from './lib.ts'

const CONF = '/etc/webcpl/apps'
const NODE = '/opt/webcpl-runtimes/node'
const APP_NAME = /^[a-z][a-z0-9-]{1,30}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const unit = (user: string, name: string) => `webcpl-app-${user}-${name}.service`

function appName(value: unknown) {
  const name = String(value ?? '')
  if (!APP_NAME.test(name)) throw new Error('Invalid app name.')
  return name
}

async function version(cmd: string[]) {
  const r = await run(cmd).catch(() => null)
  return r?.ok ? (r.stdout + r.stderr).match(/(\d+\.\d+(\.\d+)?)/)?.[1] ?? null : null
}

async function runtimes() {
  const node = existsSync(NODE) ? readdirSync(NODE).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(a) - Number(b)) : []
  return {
    node,
    python: existsSync('/usr/bin/python3') ? await version(['/usr/bin/python3', '--version']) : null,
    ruby: existsSync('/usr/bin/ruby') ? await version(['/usr/bin/ruby', '--version']) : null,
  }
}

/** The PATH an app runs with: its runtime first, then its own tools. */
function pathFor(user: string, root: string, runtime: string, ver: string) {
  const parts: string[] = []
  if (runtime === 'node') {
    if (!/^\d+$/.test(ver) || !existsSync(`${NODE}/${ver}/bin`)) throw new Error('That Node.js version is not installed.')
    parts.push(`${root}/node_modules/.bin`, `${NODE}/${ver}/bin`)
  } else if (runtime === 'python') {
    parts.push(`${root}/.venv/bin`)
  } else if (runtime === 'ruby') {
    parts.push(`/home/${user}/.gem/bin`)
  } else throw new Error('Unknown runtime.')
  return [...parts, '/usr/local/bin', '/usr/bin', '/bin'].join(':')
}

function envLine(key: string, value: string) {
  if (!ENV_KEY.test(key)) throw new Error(`Invalid variable name: ${key}`)
  if (/[\0\n\r]/.test(value)) throw new Error(`Invalid value for ${key}.`)
  // systemd EnvironmentFile: double quotes with backslash escapes.
  return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

interface AppSpec { user: string; name: string; runtime: string; version: string; root: string; command: string; port: number; env: Record<string, string> }

function spec(args: Args): AppSpec {
  const user = username(args)
  const name = appName(args.name)
  const runtime = String(args.runtime ?? '')
  const root = homePath(user, args.root)
  const command = String(args.command ?? '').trim()
  if (!command || command.length > 500 || /[\0\n\r]/.test(command)) throw new Error('Invalid start command.')
  const port = Number(args.port)
  if (!Number.isInteger(port) || port < 30000 || port > 39999) throw new Error('Invalid port.')
  const env = (args.env && typeof args.env === 'object' ? args.env : {}) as Record<string, unknown>
  if (Object.keys(env).length > 100) throw new Error('Too many variables.')
  return { user, name, runtime, version: String(args.version ?? ''), root, command, port, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) }
}

function baseEnv(s: AppSpec) {
  const defaults: Record<string, string> = {
    HOME: `/home/${s.user}`,
    USER: s.user,
    PATH: pathFor(s.user, s.root, s.runtime, s.version),
    PORT: String(s.port),
    HOST: '127.0.0.1',
    LANG: 'C.UTF-8',
  }
  if (s.runtime === 'node') defaults.NODE_ENV = 'production'
  if (s.runtime === 'python') defaults.PYTHONUNBUFFERED = '1'
  if (s.runtime === 'ruby') {
    defaults.GEM_HOME = `/home/${s.user}/.gem`
    defaults.RACK_ENV = 'production'
    defaults.RAILS_ENV = 'production'
  }
  return defaults
}

async function owned(path: string, user: string) {
  // The app folder must stay inside the home after links are resolved.
  const real = realpathSync(path)
  if (real !== `/home/${user}` && !real.startsWith(`/home/${user}/`)) throw new Error('That folder is outside the account.')
  return real
}

export const appOps: Record<string, (args: Args) => Promise<unknown>> = {
  'apps.runtimes': async () => runtimes(),

  /** Writes the service and its environment, then (re)starts it unless told not to. */
  'app.write': async (args) => {
    const s = spec(args)
    if (!existsSync(s.root)) await must(['runuser', '-u', s.user, '--', 'mkdir', '-p', s.root], 'Could not create the app folder')
    const root = await owned(s.root, s.user)
    const env = { ...s.env, ...baseEnv({ ...s, root }) }
    writeAtomic(`${CONF}/${s.user}-${s.name}.env`, Object.entries(env).map(([k, v]) => envLine(k, v)).join('\n') + '\n', 0o640)
    await must(['chown', `root:${s.user}`, `${CONF}/${s.user}-${s.name}.env`], 'chown env')
    // The command runs as the account; the script itself stays root's so it cannot be swapped.
    writeAtomic(`${CONF}/${s.user}-${s.name}.sh`, `#!/bin/sh\nexec ${s.command}\n`, 0o755)
    writeAtomic(`/etc/systemd/system/${unit(s.user, s.name)}`, `[Unit]
Description=${s.runtime} app ${s.name} of ${s.user} (Webcpl)
After=network.target

[Service]
User=${s.user}
Group=${s.user}
Slice=webcpl-${s.user}.slice
WorkingDirectory=${root}
EnvironmentFile=${CONF}/${s.user}-${s.name}.env
ExecStart=${CONF}/${s.user}-${s.name}.sh
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/home/${s.user}
SyslogIdentifier=app-${s.user}-${s.name}

[Install]
WantedBy=multi-user.target
`)
    await must(['systemctl', 'daemon-reload'], 'systemd reload')
    await must(['systemctl', 'enable', unit(s.user, s.name)], 'enable app')
    if (args.start !== false) await run(['systemctl', 'restart', unit(s.user, s.name)])
    return { ok: true }
  },

  'app.power': async (args) => {
    const user = username(args)
    const name = appName(args.name)
    const action = String(args.action)
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unknown action.')
    if (!existsSync(`/etc/systemd/system/${unit(user, name)}`)) throw new Error('That app does not exist.')
    await must(['systemctl', action, unit(user, name)], `Could not ${action} the app`)
    return { ok: true }
  },

  'app.delete': async (args) => {
    const user = username(args)
    const name = appName(args.name)
    await run(['systemctl', 'disable', '--now', unit(user, name)])
    for (const f of [`/etc/systemd/system/${unit(user, name)}`, `${CONF}/${user}-${name}.env`, `${CONF}/${user}-${name}.sh`]) removeFile(f)
    await run(['systemctl', 'daemon-reload'])
    return { ok: true }
  },

  'app.status': async (args) => {
    const user = username(args)
    const names = ((args.names ?? []) as unknown[]).map(appName)
    const out: Record<string, { state: string; memoryBytes: number | null; since: number | null; restarts: number }> = {}
    for (const name of names) {
      const r = await run(['systemctl', 'show', unit(user, name), '-p', 'ActiveState', '-p', 'MemoryCurrent', '-p', 'ActiveEnterTimestampMonotonic', '-p', 'ExecMainStartTimestamp', '-p', 'NRestarts'])
      const props = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      const memory = Number(props.MemoryCurrent)
      const since = Date.parse(props.ExecMainStartTimestamp ?? '')
      out[name] = {
        state: props.ActiveState ?? 'unknown',
        memoryBytes: Number.isFinite(memory) && memory < 2 ** 62 ? memory : null,
        since: Number.isFinite(since) ? since : null,
        restarts: Number(props.NRestarts) || 0,
      }
    }
    return out
  },

  'app.logs': async (args) => {
    const user = username(args)
    const name = appName(args.name)
    const lines = Math.min(1000, Math.max(10, Number(args.lines) || 200))
    const r = await run(['journalctl', '-u', unit(user, name), '-n', String(lines), '--no-pager', '-o', 'short-iso'], { timeout: 20_000 })
    return { text: r.stdout }
  },

  /** Installs the app's dependencies as the account, the way its runtime expects. */
  'app.install': async (args) => {
    const s = spec({ ...args, command: 'true', port: 30000 })
    const root = await owned(s.root, s.user)
    const path = pathFor(s.user, root, s.runtime, s.version)
    const script =
      s.runtime === 'node'
        ? 'if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f package.json ]; then npm install --no-audit --no-fund; else echo "No package.json in this folder."; exit 1; fi'
        : s.runtime === 'python'
          ? '[ -d .venv ] || /usr/bin/python3 -m venv .venv || exit 1; .venv/bin/pip install --upgrade pip -q; if [ -f requirements.txt ]; then .venv/bin/pip install -r requirements.txt; else echo "No requirements.txt in this folder."; exit 1; fi'
          : 'if [ -f Gemfile ]; then command -v bundle >/dev/null 2>&1 || gem install --conservative bundler || exit 1; bundle config set --local path vendor/bundle && bundle install; else echo "No Gemfile in this folder."; exit 1; fi'
    const r = await run(
      ['runuser', '-u', s.user, '--', 'env', '-i', `HOME=/home/${s.user}`, `USER=${s.user}`, `PATH=${path}`, `GEM_HOME=/home/${s.user}/.gem`, 'LANG=C.UTF-8',
        '/bin/sh', '-c', `cd "$1" && ${script}`, 'sh', root],
      { timeout: 15 * 60_000 },
    )
    const output = (r.stdout + r.stderr).slice(-20_000)
    return { ok: r.ok, output }
  },
}
