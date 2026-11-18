// Keeps the server in step with the panel for hosting accounts: the Linux user, its limits,
// PHP services, websites and DNS. The panel's database is the source of truth; these
// functions push it to the server through the agent.
import { generatePassword } from './auth.ts'
import { parseLimits } from './access.ts'
import { agent } from './agent.ts'
import { db, getSetting, planById, userById, type DomainRow, type UserRow } from './db.ts'
import { HttpError } from './errors.ts'

export const hasHosting = (u: UserRow) => !!u.hosting_plan_id && u.role !== 'admin'

export function hostingLimits(u: UserRow) {
  return parseLimits(planById(u.hosting_plan_id ?? 0))
}

/** CPU, memory and processes as the agent applies them, plus the shell. */
function systemLimits(u: UserRow) {
  const l = hostingLimits(u)
  return {
    limits: { cpu_percent: l.cpu_percent ?? null, memory_mb: l.memory_mb ?? null, processes: l.processes ?? null },
    ssh: l.ssh === true,
  }
}

export interface ServerInfo {
  php: string[]
  addresses: { address: string; family: 4 | 6; interface: string }[]
  components: Record<string, unknown>
}

let infoCache: { at: number; value: ServerInfo } | null = null
export async function serverInfo() {
  if (infoCache && Date.now() - infoCache.at < 60_000) return infoCache.value
  const value = await agent<ServerInfo>('hosting.info')
  infoCache = { at: Date.now(), value }
  return value
}

/** The address websites and DNS records point to: set in Panel settings, or found by the installer. */
export async function publicAddress() {
  const set = getSetting('public_ip') || process.env.WEBCPL_PUBLIC_IP || ''
  if (set) return set
  const info = await serverInfo()
  return info.addresses.find((a) => a.family === 4)?.address ?? ''
}

// ---- account lifecycle ----------------------------------------------------------------------------

/** Creates the Linux user if the account has a hosting plan and none yet. */
export async function provision(u: UserRow, password?: string) {
  if (!hasHosting(u) || u.linux_user) return
  const { limits, ssh } = systemLimits(u)
  await agent('account.create', { user: u.username, password: password || generatePassword(24), limits, ssh })
  db.query('UPDATE users SET linux_user = 1 WHERE id = ?').run(u.id)
}

export async function syncLimits(u: UserRow) {
  if (!u.linux_user) return
  const { limits, ssh } = systemLimits(u)
  await agent('account.limits', { user: u.username, limits, ssh })
  await syncPhp(u)
  if (u.redis_enabled) await agent('redis.enable', { user: u.username, memory_mb: redisMemory(u) }).catch(() => null)
}

export async function syncPassword(u: UserRow, password: string) {
  if (u.linux_user) await agent('account.password', { user: u.username, password })
}

/** Redis memory for the account: 0 means none, an empty limit means 64 MB. */
export function redisMemory(u: UserRow) {
  const value = hostingLimits(u).redis_mb
  return typeof value === 'number' ? value : 64
}

export async function suspend(u: UserRow) {
  if (!u.linux_user) return
  if (u.redis_enabled) await agent('redis.power', { user: u.username, on: false }).catch(() => null)
  for (const app of db.query<{ name: string }, [number]>('SELECT name FROM apps WHERE user_id = ?').all(u.id)) {
    await agent('app.power', { user: u.username, name: app.name, action: 'stop' }).catch(() => null)
  }
  await agent('account.suspend', { user: u.username })
  await writeAllSites(userById(u.id)!)
}

export async function unsuspend(u: UserRow) {
  if (!u.linux_user) return
  await agent('account.unsuspend', { user: u.username })
  if (u.redis_enabled) await agent('redis.power', { user: u.username, on: true }).catch(() => null)
  for (const app of db.query<{ name: string }, [number]>('SELECT name FROM apps WHERE user_id = ?').all(u.id)) {
    await agent('app.power', { user: u.username, name: app.name, action: 'start' }).catch(() => null)
  }
  await writeAllSites(userById(u.id)!)
}

/** Removes everything the account has on the server. */
export async function deprovision(u: UserRow) {
  if (!u.linux_user) return
  const domains = db.query<DomainRow, [number]>('SELECT * FROM domains WHERE user_id = ?').all(u.id)
  for (const d of domains) {
    if (!d.parent_id) await agent('dns.zone.delete', { zone: d.name }).catch(() => null)
    if (d.ssl_cert) await agent('ssl.delete', { name: d.name }).catch(() => null)
  }
  for (const database of db.query<{ name: string; engine: string }, [number]>('SELECT name, engine FROM databases WHERE user_id = ?').all(u.id)) {
    if (database.engine === 'postgresql') {
      await agent('pg.delete', { name: database.name }).catch(() => null)
      continue
    }
    await agent('db.delete', { name: database.name }).catch(() => null)
    await agent('db.user.delete', { name: database.name }).catch(() => null)
  }
  if (u.redis_enabled) await agent('redis.disable', { user: u.username }).catch(() => null)
  for (const app of db.query<{ name: string }, [number]>('SELECT name FROM apps WHERE user_id = ?').all(u.id)) {
    await agent('app.delete', { user: u.username, name: app.name }).catch(() => null)
  }
  db.query('DELETE FROM apps WHERE user_id = ?').run(u.id)
  await agent('account.delete', { user: u.username })
  db.query('DELETE FROM domains WHERE user_id = ?').run(u.id)
  db.query('DELETE FROM databases WHERE user_id = ?').run(u.id)
  db.query('DELETE FROM cron_jobs WHERE user_id = ?').run(u.id)
  db.query('UPDATE users SET linux_user = 0 WHERE id = ?').run(u.id)
}

// ---- PHP and websites -------------------------------------------------------------------------------

export async function syncPhp(u: UserRow) {
  if (!u.linux_user) return
  const versions = db.query<{ php_version: string }, [number]>('SELECT DISTINCT php_version FROM domains WHERE user_id = ?').all(u.id).map((r) => r.php_version)
  const processes = Number(hostingLimits(u).processes) || 20
  await agent('php.sync', {
    user: u.username,
    versions,
    settings: JSON.parse(u.php_settings || '{}'),
    maxChildren: Math.max(2, Math.min(50, Math.floor(processes / 2))),
  })
}

export function siteFor(u: UserRow, d: DomainRow) {
  const aliases: string[] = JSON.parse(d.aliases)
  return {
    name: d.name,
    // The www name follows every top-level domain.
    aliases: d.parent_id ? aliases : [`www.${d.name}`, ...aliases],
    docroot: d.docroot,
    php: d.php_version,
    ssl: d.ssl_cert && d.ssl_key ? { cert: d.ssl_cert, key: d.ssl_key } : null,
    forceHttps: !!d.force_https,
    suspended: !!u.suspended,
    appPort: db.query<{ port: number }, [number]>('SELECT port FROM apps WHERE domain_id = ?').get(d.id)?.port ?? null,
  }
}

export async function writeSite(u: UserRow, d: DomainRow) {
  await agent('site.write', { user: u.username, site: siteFor(u, d) })
}

export async function writeAllSites(u: UserRow) {
  for (const d of db.query<DomainRow, [number]>('SELECT * FROM domains WHERE user_id = ?').all(u.id)) await writeSite(u, d)
  await writePreview(u)
}

/** http://IP/~user shows the account's first website. */
export async function writePreview(u: UserRow) {
  const first = db.query<DomainRow, [number]>('SELECT * FROM domains WHERE user_id = ? AND parent_id IS NULL ORDER BY id LIMIT 1').get(u.id)
  await agent('preview.write', first && !u.suspended ? { user: u.username, docroot: first.docroot, php: first.php_version } : { user: u.username })
}

export async function nameservers(zone: string) {
  const ns = [getSetting('nameserver1'), getSetting('nameserver2')].filter(Boolean)
  return ns.length ? ns : [`ns1.${zone}`, `ns2.${zone}`]
}

/** The records a new domain starts with: the site, www, mail and name servers. */
export async function defaultRecords(zone: string, address: string, ns: string[]) {
  const v6 = (await serverInfo()).addresses.find((a) => a.family === 6 && !a.address.startsWith('fd'))?.address
  const sets: { name: string; type: string; ttl: number; records: string[] }[] = [
    { name: `${zone}.`, type: 'A', ttl: 3600, records: [address] },
    { name: `www.${zone}.`, type: 'CNAME', ttl: 3600, records: [`${zone}.`] },
    { name: `mail.${zone}.`, type: 'A', ttl: 3600, records: [address] },
    { name: `${zone}.`, type: 'MX', ttl: 3600, records: [`10 mail.${zone}.`] },
    { name: `${zone}.`, type: 'TXT', ttl: 3600, records: [`"v=spf1 a mx ip4:${address} ~all"`] },
  ]
  if (v6) sets.push({ name: `${zone}.`, type: 'AAAA', ttl: 3600, records: [v6] })
  // Name servers inside the zone get their address here.
  for (const name of ns.filter((n) => n.endsWith(`.${zone}`))) sets.push({ name: `${name}.`, type: 'A', ttl: 3600, records: [address] })
  return sets
}

export function requireHosting(u: UserRow) {
  if (!hasHosting(u) || !u.linux_user) throw new HttpError(404, 'This account has no hosting.', 'no_hosting')
}
