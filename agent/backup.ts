// Account backups: the home folder (files, mail, apps), database dumps and a description of
// the account, in one zstd-compressed tar file. Readable by the panel's group for downloads.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { type Args, DB_NAME, must, run, username, writeAtomic } from './lib.ts'

const ROOT = '/var/backups/webcpl'
const FILE = /^[a-z0-9]+-\d{8}-\d{6}(-[a-z]+)?\.tar\.zst$/

function backupFile(user: string, value: unknown) {
  const name = String(value ?? '')
  if (!FILE.test(name) || !name.startsWith(`${user}-`)) throw new Error('Invalid backup name.')
  const path = `${ROOT}/${user}/${name}`
  if (!existsSync(path)) throw new Error('That backup does not exist.')
  return path
}

interface Database { name: string; engine: 'mariadb' | 'postgresql' }

function databases(input: unknown, user: string): Database[] {
  return ((input ?? []) as Record<string, unknown>[]).map((d) => {
    const name = String(d.name ?? '')
    if (!DB_NAME.test(name) || !name.startsWith(`${user}_`)) throw new Error('Invalid database.')
    return { name, engine: d.engine === 'postgresql' ? 'postgresql' : 'mariadb' }
  })
}

/** Remote copies go through rclone, configured entirely from environment variables. */
function rcloneEnv(remote: Record<string, unknown>) {
  const type = String(remote.type ?? '')
  const env: Record<string, string> = { RCLONE_CONFIG_WCPL_TYPE: type }
  if (type === 'sftp') {
    env.RCLONE_CONFIG_WCPL_HOST = String(remote.host ?? '')
    env.RCLONE_CONFIG_WCPL_PORT = String(remote.port ?? 22)
    env.RCLONE_CONFIG_WCPL_USER = String(remote.user ?? '')
  } else if (type === 's3') {
    env.RCLONE_CONFIG_WCPL_PROVIDER = 'Other'
    env.RCLONE_CONFIG_WCPL_ENDPOINT = String(remote.endpoint ?? '')
    env.RCLONE_CONFIG_WCPL_ACCESS_KEY_ID = String(remote.accessKey ?? '')
    env.RCLONE_CONFIG_WCPL_SECRET_ACCESS_KEY = String(remote.secretKey ?? '')
    env.RCLONE_CONFIG_WCPL_REGION = String(remote.region || 'us-east-1')
  } else throw new Error('Unknown remote type.')
  for (const v of Object.values(env)) if (/[\0\n]/.test(v)) throw new Error('Invalid remote settings.')
  return env
}

function remotePath(remote: Record<string, unknown>, user: string) {
  const base = String(remote.path ?? '').replace(/^\/+|\/+$/g, '')
  if (/(^|\/)\.\.(\/|$)/.test(base) || /[\0\n]/.test(base)) throw new Error('Invalid remote path.')
  return `wcpl:${base ? `${base}/` : ''}${user}`
}

export const backupOps: Record<string, (args: Args) => Promise<unknown>> = {
  'backup.create': async (args) => {
    const user = username(args)
    const dbs = databases(args.databases, user)
    const label = String(args.label ?? '')
    if (label && !/^[a-z]+$/.test(label)) throw new Error('Invalid label.')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const name = `${user}-${stamp}${label ? `-${label}` : ''}.tar.zst`
    const work = `${ROOT}/.work/${user}-${stamp}`
    mkdirSync(`${work}/databases`, { recursive: true, mode: 0o700 })
    mkdirSync(`${ROOT}/${user}`, { recursive: true, mode: 0o750 })
    await run(['chgrp', 'webcpl', `${ROOT}/${user}`])
    try {
      writeAtomic(`${work}/account.json`, JSON.stringify(args.meta ?? {}, null, 2), 0o600)
      for (const d of dbs) {
        if (d.engine === 'postgresql') {
          await must(['sh', '-c', 'runuser -u postgres -- pg_dump -Fc "$1" > "$2"', 'sh', d.name, `${work}/databases/${d.name}.pgdump`], `Could not dump ${d.name}`, { timeout: 60 * 60_000 })
        } else {
          await must(['sh', '-c', 'mariadb-dump --single-transaction --quick --routines --triggers --events "$1" > "$2"', 'sh', d.name, `${work}/databases/${d.name}.sql`], `Could not dump ${d.name}`, { timeout: 60 * 60_000 })
        }
      }
      const out = `${ROOT}/${user}/${name}`
      // Caches are left out; everything else in the home goes in, with owners and modes.
      await must(['tar', '--zstd', '-cpf', `${out}.part`, '--exclude', `home/${user}/.cache`, '--exclude', `home/${user}/tmp/*`,
        '-C', '/', `home/${user}`, '-C', work, 'account.json', 'databases'], 'Could not write the backup', { timeout: 6 * 60 * 60_000 })
      await must(['mv', `${out}.part`, out], 'Could not save the backup')
      await must(['chown', 'root:webcpl', out], 'chown backup')
      await must(['chmod', '0640', out], 'chmod backup')
      return { name, size: statSync(out).size }
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(`${ROOT}/${user}/${name}.part`, { force: true })
    }
  },

  'backup.list': async (args) => {
    const user = username(args)
    const dir = `${ROOT}/${user}`
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => FILE.test(f)).map((f) => {
      const s = statSync(`${dir}/${f}`)
      return { name: f, size: s.size, createdAt: s.mtimeMs }
    }).sort((a, b) => b.createdAt - a.createdAt)
  },

  'backup.delete': async (args) => {
    const user = username(args)
    rmSync(backupFile(user, args.name), { force: true })
    return { ok: true }
  },

  /** Puts files and/or databases back from a backup, into the existing account. */
  'backup.restore': async (args) => {
    const user = username(args)
    const file = backupFile(user, args.name)
    const parts = (args.parts ?? {}) as { files?: boolean; databases?: boolean }
    const dbs = databases(args.databases, user)
    const work = `${ROOT}/.work/restore-${user}-${Date.now()}`
    mkdirSync(work, { recursive: true, mode: 0o700 })
    try {
      if (parts.files) {
        // Extracted by name: owners map to this server's account even if its ID differs.
        await must(['tar', '--zstd', '-xpf', file, '-C', '/', `home/${user}`], 'Could not restore the files', { timeout: 6 * 60 * 60_000 })
      }
      const restored: string[] = []
      if (parts.databases && dbs.length) {
        await run(['tar', '--zstd', '-xf', file, '-C', work, 'databases'], { timeout: 60 * 60_000 })
        for (const d of dbs) {
          if (d.engine === 'postgresql' && existsSync(`${work}/databases/${d.name}.pgdump`)) {
            await must(['sh', '-c', 'runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role="$1" -d "$1" < "$2"', 'sh', d.name, `${work}/databases/${d.name}.pgdump`], `Could not restore ${d.name}`, { timeout: 60 * 60_000 })
            restored.push(d.name)
          } else if (d.engine === 'mariadb' && existsSync(`${work}/databases/${d.name}.sql`)) {
            await must(['sh', '-c', 'mariadb "$1" < "$2"', 'sh', d.name, `${work}/databases/${d.name}.sql`], `Could not restore ${d.name}`, { timeout: 60 * 60_000 })
            restored.push(d.name)
          }
        }
      }
      return { ok: true, databases: restored }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  },

  /** Reads the account description stored in a backup. */
  'backup.meta': async (args) => {
    const user = username(args)
    const file = backupFile(user, args.name)
    const r = await run(['tar', '--zstd', '-xOf', file, 'account.json'], { timeout: 10 * 60_000 })
    if (!r.ok) throw new Error('The backup has no account description.')
    return JSON.parse(r.stdout)
  },

  /** Copies a backup to the off-site target and keeps the newest there too. */
  'backup.upload': async (args) => {
    const user = username(args)
    const file = backupFile(user, args.name)
    const remote = (args.remote ?? {}) as Record<string, unknown>
    const env = rcloneEnv(remote)
    if (remote.type === 'sftp' && remote.password) {
      const obscured = await run(['rclone', 'obscure', '-'], { input: String(remote.password) })
      env.RCLONE_CONFIG_WCPL_PASS = obscured.stdout.trim()
    }
    const r = await run(['rclone', 'copy', file, remotePath(remote, user), '--retries', '3'], { env: { ...env, PATH: '/usr/bin:/bin' }, timeout: 6 * 60 * 60_000 })
    if (!r.ok) throw new Error(`The off-site copy failed: ${r.stderr.trim().split('\n').at(-1)}`)
    return { ok: true }
  },

  'backup.remote.test': async (args) => {
    const remote = (args.remote ?? {}) as Record<string, unknown>
    const env = rcloneEnv(remote)
    if (remote.type === 'sftp' && remote.password) env.RCLONE_CONFIG_WCPL_PASS = (await run(['rclone', 'obscure', '-'], { input: String(remote.password) })).stdout.trim()
    const r = await run(['rclone', 'mkdir', remotePath(remote, '.webcpl-test')], { env: { ...env, PATH: '/usr/bin:/bin' }, timeout: 60_000 })
    if (!r.ok) throw new Error(`Could not reach the off-site storage: ${r.stderr.trim().split('\n').at(-1)}`)
    await run(['rclone', 'rmdir', remotePath(remote, '.webcpl-test')], { env: { ...env, PATH: '/usr/bin:/bin' }, timeout: 60_000 })
    return { ok: true }
  },
}
