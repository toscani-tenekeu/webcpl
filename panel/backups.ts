// Backups: one job at a time, on demand or on the admin's schedule, with retention and an
// optional off-site copy.
import { agent } from './agent.ts'
import { db, getSetting, logActivity, planById, setSetting, type UserRow } from './db.ts'
import { HttpError } from './errors.ts'

export interface BackupSettings {
  schedule: 'off' | 'daily' | 'weekly'
  hour: number
  keep: number
  remote: { type: 'none' | 'sftp' | 's3'; host?: string; port?: number; user?: string; password?: string; endpoint?: string; accessKey?: string; secretKey?: string; region?: string; path?: string }
}

const DEFAULTS: BackupSettings = { schedule: 'daily', hour: 3, keep: 7, remote: { type: 'none' } }
const MANUAL_KEEP = 3

export function backupSettings(): BackupSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(getSetting('backups', '{}')) }
  } catch {
    return DEFAULTS
  }
}

/** The settings as the admin sees them: secrets are only said to be set. */
export function publicSettings() {
  const s = backupSettings()
  const { password, secretKey, ...remote } = s.remote
  return { ...s, remote: { ...remote, passwordSet: !!password, secretKeySet: !!secretKey } }
}

export function saveSettings(input: Record<string, unknown>) {
  const current = backupSettings()
  const schedule = String(input.schedule ?? current.schedule)
  if (!['off', 'daily', 'weekly'].includes(schedule)) throw new HttpError(400, 'Choose off, daily or weekly.', 'bad_schedule')
  const hour = Number(input.hour ?? current.hour)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new HttpError(400, 'The hour is from 0 to 23.', 'bad_hour')
  const keep = Number(input.keep ?? current.keep)
  if (!Number.isInteger(keep) || keep < 1 || keep > 90) throw new HttpError(400, 'Keep from 1 to 90 backups.', 'bad_keep')
  const r = (input.remote ?? current.remote) as Record<string, unknown>
  const type = String(r.type ?? 'none')
  if (!['none', 'sftp', 's3'].includes(type)) throw new HttpError(400, 'Choose SFTP, S3 or none.', 'bad_remote')
  const text = (key: string) => String(r[key] ?? '').trim()
  const remote: BackupSettings['remote'] = { type: type as BackupSettings['remote']['type'] }
  if (type === 'sftp') {
    Object.assign(remote, { host: text('host'), port: Number(r.port) || 22, user: text('user'), path: text('path'), password: text('password') || current.remote.password })
    if (!remote.host || !remote.user) throw new HttpError(400, 'Give the SFTP server and user.', 'bad_remote')
  } else if (type === 's3') {
    Object.assign(remote, { endpoint: text('endpoint'), accessKey: text('accessKey'), region: text('region'), path: text('path'), secretKey: text('secretKey') || current.remote.secretKey })
    if (!remote.endpoint || !remote.accessKey || !remote.secretKey || !remote.path) throw new HttpError(400, 'Give the endpoint, the keys and a bucket in the path.', 'bad_remote')
  }
  setSetting('backups', JSON.stringify({ schedule, hour, keep, remote }))
}

/** Everything needed to rebuild the account elsewhere, stored inside its backup. */
function describe(u: UserRow) {
  const all = <T>(sql: string) => db.query<T, [number]>(sql).all(u.id)
  return {
    version: 1,
    account: { username: u.username, email: u.email, hostingPlan: u.hosting_plan_id ? planById(u.hosting_plan_id)?.name : null, phpSettings: JSON.parse(u.php_settings || '{}'), redis: !!u.redis_enabled },
    domains: all('SELECT name, parent_id, docroot, php_version, aliases, force_https FROM domains WHERE user_id = ?'),
    databases: all('SELECT name, engine, remote FROM databases WHERE user_id = ?'),
    cron: all('SELECT schedule, command FROM cron_jobs WHERE user_id = ?'),
    mailboxes: all('SELECT address, password_hash, quota_mb FROM mailboxes WHERE user_id = ?'),
    forwarders: all('SELECT source, destinations FROM forwarders WHERE user_id = ?'),
    apps: all('SELECT name, runtime, version, root, command, env FROM apps WHERE user_id = ?'),
  }
}

const dbsOf = (u: UserRow) => db.query<{ name: string; engine: string }, [number]>('SELECT name, engine FROM databases WHERE user_id = ?').all(u.id)

// ---- the job queue -----------------------------------------------------------------------------------

type Job = { kind: 'backup' | 'restore'; user: string; state: 'queued' | 'running' | 'done' | 'failed'; detail: string; at: number }
const jobs = new Map<string, Job>()
let chain: Promise<unknown> = Promise.resolve()

export const jobFor = (u: UserRow) => jobs.get(u.username) ?? null

function enqueue(u: UserRow, kind: Job['kind'], work: () => Promise<string>) {
  const current = jobs.get(u.username)
  if (current && (current.state === 'queued' || current.state === 'running')) throw new HttpError(409, 'A backup or restore is already running for this account.', 'busy')
  const job: Job = { kind, user: u.username, state: 'queued', detail: '', at: Date.now() }
  jobs.set(u.username, job)
  chain = chain.then(async () => {
    job.state = 'running'
    try {
      job.detail = await work()
      job.state = 'done'
    } catch (error) {
      job.state = 'failed'
      job.detail = (error as Error).message
    }
    job.at = Date.now()
  })
}

async function prune(u: UserRow, label: 'auto' | 'manual', keep: number) {
  const list = await agent<{ name: string }[]>('backup.list', { user: u.username })
  for (const b of list.filter((x) => x.name.endsWith(`-${label}.tar.zst`)).slice(keep)) await agent('backup.delete', { user: u.username, name: b.name })
}

async function backupNow(u: UserRow, label: 'auto' | 'manual') {
  const result = await agent<{ name: string; size: number }>('backup.create', { user: u.username, label, databases: dbsOf(u), meta: describe(u) }, 7 * 60 * 60_000)
  const settings = backupSettings()
  await prune(u, label, label === 'auto' ? settings.keep : MANUAL_KEEP)
  if (label === 'auto' && settings.remote.type !== 'none') await agent('backup.upload', { user: u.username, name: result.name, remote: settings.remote }, 7 * 60 * 60_000)
  return result.name
}

export function startBackup(u: UserRow, actorId: number, ip: string) {
  enqueue(u, 'backup', () => backupNow(u, 'manual'))
  logActivity({ actorId, subjectId: u.id, action: 'started a backup', ip })
}

export function startRestore(u: UserRow, name: string, parts: { files: boolean; databases: boolean }, actorId: number, ip: string) {
  enqueue(u, 'restore', async () => {
    await agent('backup.restore', { user: u.username, name, parts, databases: dbsOf(u) }, 7 * 60 * 60_000)
    return name
  })
  logActivity({ actorId, subjectId: u.id, action: 'started a restore', detail: name, ip })
}

// ---- schedule -----------------------------------------------------------------------------------------

function due(settings: BackupSettings, now = new Date()) {
  if (settings.schedule === 'off' || now.getHours() !== settings.hour) return false
  if (settings.schedule === 'weekly' && now.getDay() !== 0) return false
  const last = Number(getSetting('backups_last_run', '0'))
  return Date.now() - last > 20 * 60 * 60_000
}

export function runAll() {
  setSetting('backups_last_run', String(Date.now()))
  const users = db.query<UserRow, []>('SELECT * FROM users WHERE linux_user = 1 ORDER BY id').all()
  for (const u of users) {
    try {
      enqueue(u, 'backup', () => backupNow(u, 'auto'))
    } catch {
      // Already busy: it gets the next run.
    }
  }
  return users.length
}

export function startSchedule() {
  setInterval(() => {
    if (due(backupSettings())) runAll()
  }, 5 * 60_000)
}
