// PostgreSQL databases and a private Redis per account.
import { existsSync, mkdirSync } from 'node:fs'
import { type Args, DB_NAME, must, removeFile, run, runAs, username, writeAtomic } from './lib.ts'

function pgName(value: unknown) {
  const name = String(value ?? '')
  if (!DB_NAME.test(name)) throw new Error('Invalid database name.')
  return name
}

/** Runs SQL as the postgres superuser; statements come on stdin, never on the command line. */
async function psql(statements: string, database = 'postgres') {
  const result = await run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', database], { input: statements, timeout: 120_000 })
  if (!result.ok) throw new Error(`PostgreSQL refused: ${result.stderr.trim().split('\n').at(-1)}`)
  return result.stdout
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`

function password(value: unknown) {
  const text = String(value ?? '')
  if (text.length < 10 || text.length > 200 || /[\0\n]/.test(text)) throw new Error('Invalid password.')
  return text
}

const REDIS_CONF = '/etc/webcpl/redis'
const unit = (user: string) => `webcpl-redis-${user}.service`

export const dataOps: Record<string, (args: Args) => Promise<unknown>> = {
  'pg.create': async (args) => {
    const name = pgName(args.name)
    const pass = password(args.password)
    // Role and database share the name; nobody else may connect to it.
    await psql(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(name)}) THEN CREATE ROLE "${name}" LOGIN PASSWORD ${literal(pass)}; END IF; END $$;`)
    const exists = (await psql(`SELECT 1 FROM pg_database WHERE datname = ${literal(name)}`)).trim()
    if (!exists) await psql(`CREATE DATABASE "${name}" OWNER "${name}" ENCODING 'UTF8' TEMPLATE template0`)
    // Accounts reach their own databases only, not the system ones either.
    await psql(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC; GRANT ALL ON DATABASE "${name}" TO "${name}"; REVOKE CONNECT ON DATABASE postgres FROM PUBLIC; REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;`)
    return { ok: true }
  },
  'pg.password': async (args) => {
    const name = pgName(args.name)
    await psql(`ALTER ROLE "${name}" PASSWORD ${literal(password(args.password))}`)
    return { ok: true }
  },
  'pg.delete': async (args) => {
    const name = pgName(args.name)
    await psql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await psql(`DROP ROLE IF EXISTS "${name}"`)
    return { ok: true }
  },
  'pg.sizes': async (args) => {
    const user = username(args)
    const out = await psql(`SELECT datname || '|' || pg_database_size(datname) FROM pg_database WHERE datname LIKE ${literal(`${user}\\_%`)}`)
    return Object.fromEntries(out.trim().split('\n').filter(Boolean).map((line) => {
      const [name, size] = line.split('|')
      return [name!, Number(size)]
    }))
  },

  /** Starts (or reconfigures) the account's Redis: a Unix socket in its home, inside its slice. */
  'redis.enable': async (args) => {
    const user = username(args)
    const memory = Math.max(16, Math.min(65536, Math.floor(Number(args.memory_mb) || 64)))
    const dir = `/home/${user}/.redis`
    if (!existsSync(dir)) await must(['runuser', '-u', user, '--', 'mkdir', '-m', '0700', dir], 'Could not create the Redis folder')
    mkdirSync(REDIS_CONF, { recursive: true })
    writeAtomic(`${REDIS_CONF}/${user}.conf`, [
      'port 0',
      `unixsocket ${dir}/redis.sock`,
      'unixsocketperm 700',
      `dir ${dir}`,
      'daemonize no',
      'supervised systemd',
      `maxmemory ${memory}mb`,
      'maxmemory-policy allkeys-lru',
      'save 900 1',
      'appendonly no',
      'databases 16',
      '',
    ].join('\n'))
    await must(['chown', `root:${user}`, `${REDIS_CONF}/${user}.conf`], 'chown redis config')
    await must(['chmod', '0640', `${REDIS_CONF}/${user}.conf`], 'chmod redis config')
    writeAtomic(`/etc/systemd/system/${unit(user)}`, `[Unit]
Description=Redis for ${user} (Webcpl)
After=network.target

[Service]
Type=notify
User=${user}
Group=${user}
Slice=webcpl-${user}.slice
ExecStart=/usr/bin/redis-server ${REDIS_CONF}/${user}.conf
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
`)
    await must(['systemctl', 'daemon-reload'], 'systemd reload')
    await must(['systemctl', 'enable', unit(user)], 'enable redis')
    await must(['systemctl', 'restart', unit(user)], 'Redis did not start')
    return { ok: true, socket: `${dir}/redis.sock` }
  },
  'redis.disable': async (args) => {
    const user = username(args)
    await run(['systemctl', 'disable', '--now', unit(user)])
    removeFile(`/etc/systemd/system/${unit(user)}`)
    removeFile(`${REDIS_CONF}/${user}.conf`)
    await run(['systemctl', 'daemon-reload'])
    return { ok: true }
  },
  'redis.power': async (args) => {
    const user = username(args)
    if (!existsSync(`/etc/systemd/system/${unit(user)}`)) return { ok: true }
    await run(['systemctl', args.on ? 'start' : 'stop', unit(user)])
    return { ok: true }
  },
  'redis.status': async (args) => {
    const user = username(args)
    if (!existsSync(`/etc/systemd/system/${unit(user)}`)) return { enabled: false }
    const active = (await run(['systemctl', 'is-active', unit(user)])).stdout.trim() === 'active'
    let used = 0
    if (active) {
      const info = await runAs(user, ['redis-cli', '-s', `/home/${user}/.redis/redis.sock`, 'info', 'memory'])
      used = Number(info.stdout.match(/used_memory:(\d+)/)?.[1] ?? 0)
    }
    return { enabled: true, active, usedBytes: used, socket: `/home/${user}/.redis/redis.sock` }
  },
}
