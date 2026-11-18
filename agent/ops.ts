// The operations the agent accepts. Each takes plain JSON arguments, checks them, and
// returns plain JSON. Adding a feature to Webcpl means adding a narrow operation here.
import { readFileSync, statfsSync } from 'node:fs'
import os from 'node:os'
import { componentList, DEFAULT_CHOICE, type ComponentChoice } from '../shared/components.ts'
import { vpsOps } from './vps.ts'
import { consoleOps } from './console.ts'
import { dataOps } from './data.ts'
import { fileOps } from './files.ts'
import { hostingOps } from './hosting.ts'
import { serviceOps } from './services.ts'

type Args = Record<string, unknown>
type Operation = (args: Args) => Promise<unknown> | unknown

const CONFIG_DIR = process.env.WEBCPL_CONFIG ?? '/etc/webcpl'

async function run(cmd: string[], timeout = 30_000) {
  const proc = Bun.spawn(cmd, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { ok: code === 0, code, stdout, stderr }
}

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function choice(): ComponentChoice {
  try {
    return { ...DEFAULT_CHOICE, ...JSON.parse(readText(`${CONFIG_DIR}/components.json`)) }
  } catch {
    return { ...DEFAULT_CHOICE, php: [], web: false, mariadb: false, dns: false, vps: false }
  }
}

function osName() {
  return readText('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]*)"?/m)?.[1] ?? 'Linux'
}

/** Addresses others can reach the server on: everything but loopback, link-local and container bridges. */
function addresses() {
  const out: { address: string; family: 4 | 6; interface: string }[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|lxdbr|incusbr|cni|flannel)/.test(name)) continue
    for (const entry of list ?? []) {
      if (entry.internal || entry.address.startsWith('fe80')) continue
      out.push({ address: entry.address, family: entry.family === 'IPv6' ? 6 : 4, interface: name })
    }
  }
  return out
}

function disk(path: string) {
  try {
    const stat = statfsSync(path)
    return { total: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize }
  } catch {
    return null
  }
}

async function serviceStates(names: string[]) {
  if (!names.length) return {}
  const result = await run(['systemctl', 'is-active', ...names])
  const states = result.stdout.split('\n')
  return Object.fromEntries(names.map((name, index) => [name, states[index]?.trim() || 'unknown']))
}

/** Services the panel may act on: only those of installed components. */
function managedServices() {
  return new Set(componentList(choice()).filter((item) => item.installed).flatMap((item) => item.services))
}

const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart', 'reload'])

export const operations: Record<string, Operation> = {
  ...hostingOps,
  ...serviceOps,
  ...fileOps,
  ...vpsOps,
  ...consoleOps,
  ...dataOps,

  'agent.ping': () => ({ pong: true, version: process.env.WEBCPL_VERSION ?? null }),

  /** PHP versions installed on the server, and the server's main addresses for new DNS zones. */
  'hosting.info': () => ({
    php: choice().php,
    addresses: addresses(),
    components: choice(),
  }),

  'system.info': () => {
    const cpus = os.cpus()
    return {
      hostname: os.hostname(),
      os: osName(),
      kernel: os.release(),
      arch: os.arch(),
      uptime: os.uptime(),
      cpu: { count: cpus.length, model: cpus[0]?.model ?? '', load: os.loadavg() },
      memory: { total: os.totalmem(), free: os.freemem() },
      disk: disk('/'),
      addresses: addresses(),
    }
  },

  'components.status': async () => {
    const list = componentList(choice())
    const states = await serviceStates([...new Set(list.filter((item) => item.installed).flatMap((item) => item.services))])
    return list.map((item) => ({
      ...item,
      services: item.services.map((name) => ({ name, state: item.installed ? (states[name] ?? 'unknown') : 'not-installed' })),
    }))
  },

  'service.action': async (args) => {
    const name = String(args.name ?? '')
    const action = String(args.action ?? '')
    if (!SERVICE_ACTIONS.has(action)) throw new Error('Unknown action.')
    if (!managedServices().has(name)) throw new Error('That service is not managed by Webcpl.')
    const result = await run(['systemctl', action, name], 120_000)
    if (!result.ok) throw new Error(result.stderr.trim().split('\n').at(-1) || `systemctl ${action} failed.`)
    return { name, action, state: (await serviceStates([name]))[name] }
  },
}
