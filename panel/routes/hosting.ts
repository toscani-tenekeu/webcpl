import { generatePassword } from '../auth.ts'
import { agent } from '../agent.ts'
import { db, getSetting, logActivity, now, userById, type DomainRow, type UserRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import * as hosting from '../hosting.ts'
import * as mail from '../mail.ts'
import { route, type Ctx } from '../http.ts'

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** The hosting account acting: the signed-in account itself (admins and resellers use "log in as"). */
function me(ctx: Ctx) {
  const u = userById(ctx.user!.id)!
  hosting.requireHosting(u)
  if (u.suspended && !ctx.impersonatorId) throw new HttpError(403, 'This account is suspended.', 'suspended')
  return u
}

const count = (sql: string, ...args: number[]) => db.query<{ n: number }, number[]>(sql).get(...args)!.n

function within(u: UserRow, key: string, used: number, label: string) {
  const limit = hosting.hostingLimits(u)[key]
  if (limit !== null && limit !== undefined && used >= Number(limit)) throw new HttpError(403, `Your plan allows ${limit} ${label}.`, 'plan_limit')
}

function ownDomain(u: UserRow, id: unknown) {
  const d = db.query<DomainRow, [number, number]>('SELECT * FROM domains WHERE id = ? AND user_id = ?').get(Number(id), u.id)
  if (!d) throw new HttpError(404, 'Website not found.', 'not_found')
  return d
}

const period = () => new Date().toISOString().slice(0, 7)

function publicDomain(d: DomainRow) {
  return {
    id: d.id,
    name: d.name,
    parentId: d.parent_id,
    docroot: d.docroot,
    php: d.php_version,
    aliases: JSON.parse(d.aliases) as string[],
    ssl: d.ssl_cert ? { expiresAt: d.ssl_expires_at } : null,
    forceHttps: !!d.force_https,
    redirect: d.redirect ? (JSON.parse(d.redirect) as { to: string; code: number; keepPath: boolean }) : null,
    errorPages: JSON.parse(d.error_pages || '{}') as Record<string, string>,
    protected: (JSON.parse(d.protected || '[]') as { id: number; path: string; users: { name: string }[] }[]).map((p) => ({ id: p.id, path: p.path, users: p.users.map((x) => x.name) })),
    createdAt: d.created_at,
  }
}

// ---- overview -------------------------------------------------------------------------------------

route('GET', '/api/hosting', async (ctx) => {
  const u = me(ctx)
  const info = await hosting.serverInfo()
  const address = await hosting.publicAddress()
  const bandwidth = db.query<{ bandwidth: number }, [number, string]>('SELECT bandwidth FROM usage WHERE user_id = ? AND period = ?').get(u.id, period())?.bandwidth ?? 0
  return {
    username: u.username,
    address,
    hostname: getSetting('hostname') || null,
    previewUrl: `http://${address}/~${u.username}/`,
    sftp: { host: getSetting('hostname') || address, port: 22, username: u.username, ssh: hosting.hostingLimits(u).ssh === true },
    ftp: info.components.ftp === true,
    overBandwidth: !!u.over_bandwidth,
    phpVersions: info.php,
    phpSettings: JSON.parse(u.php_settings || '{}'),
    limits: hosting.hostingLimits(u),
    usage: {
      diskBytes: u.disk_used,
      diskMeasuredAt: u.disk_measured_at,
      bandwidthBytes: bandwidth,
      domains: count('SELECT COUNT(*) AS n FROM domains WHERE user_id = ? AND parent_id IS NULL', u.id),
      subdomains: count('SELECT COUNT(*) AS n FROM domains WHERE user_id = ? AND parent_id IS NOT NULL', u.id),
      databases: count('SELECT COUNT(*) AS n FROM databases WHERE user_id = ?', u.id),
      cron_jobs: count('SELECT COUNT(*) AS n FROM cron_jobs WHERE user_id = ?', u.id),
    },
  }
})

// ---- websites ------------------------------------------------------------------------------------

route('GET', '/api/domains', (ctx) => {
  const u = me(ctx)
  return { domains: db.query<DomainRow, [number]>('SELECT * FROM domains WHERE user_id = ? ORDER BY COALESCE(parent_id, id), parent_id IS NOT NULL, name').all(u.id).map(publicDomain) }
})

route('POST', '/api/domains', async (ctx) => {
  const u = me(ctx)
  const name = String(ctx.body.name ?? '').trim().toLowerCase().replace(/^www\./, '')
  if (!DOMAIN.test(name)) throw new HttpError(400, 'Enter a domain like example.com.', 'bad_domain')
  if (db.query('SELECT 1 FROM domains WHERE name = ?').get(name)) throw new HttpError(409, 'That domain is already on this server.', 'taken')
  within(u, 'domains', count('SELECT COUNT(*) AS n FROM domains WHERE user_id = ? AND parent_id IS NULL', u.id), 'domains')
  const info = await hosting.serverInfo()
  const php = String(ctx.body.php || info.php[info.php.length - 1] || '')
  if (!info.php.includes(php)) throw new HttpError(400, 'Choose an installed PHP version.', 'bad_php')

  const result = db
    .query('INSERT INTO domains(user_id, name, docroot, php_version, created_at) VALUES(?,?,?,?,?)')
    .run(u.id, name, `domains/${name}/public_html`, php, now())
  const d = db.query<DomainRow, [number]>('SELECT * FROM domains WHERE id = ?').get(Number(result.lastInsertRowid))!
  try {
    await hosting.syncPhp(u)
    await hosting.writeSite(u, d)
    await hosting.writePreview(u)
    const components = info.components as { dns?: boolean }
    if (components.dns) {
      const address = await hosting.publicAddress()
      const ns = await hosting.nameservers(name)
      await agent('dns.zone.create', { zone: name, nameservers: ns, rrsets: [...(await hosting.defaultRecords(name, address, ns)), ...(await mail.mailRecords(name))] })
    }
  } catch (error) {
    db.query('DELETE FROM domains WHERE id = ?').run(d.id)
    await agent('site.delete', { user: u.username, name }).catch(() => null)
    await hosting.syncPhp(u).catch(() => null)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'added website', detail: name, ip: ctx.ip })
  return { domain: publicDomain(d) }
})

route('POST', '/api/domains/:id/subdomains', async (ctx) => {
  const u = me(ctx)
  const parent = ownDomain(u, ctx.params.id)
  if (parent.parent_id) throw new HttpError(400, 'Add subdomains to the main domain.', 'nested')
  const label = String(ctx.body.label ?? '').trim().toLowerCase()
  if (!LABEL.test(label) || label === 'www') throw new HttpError(400, 'Use letters, digits and hyphens, like blog.', 'bad_label')
  const name = `${label}.${parent.name}`
  if (db.query('SELECT 1 FROM domains WHERE name = ?').get(name)) throw new HttpError(409, 'That subdomain already exists.', 'taken')
  within(u, 'subdomains', count('SELECT COUNT(*) AS n FROM domains WHERE user_id = ? AND parent_id IS NOT NULL', u.id), 'subdomains')
  const result = db
    .query('INSERT INTO domains(user_id, name, parent_id, docroot, php_version, created_at) VALUES(?,?,?,?,?,?)')
    .run(u.id, name, parent.id, `${parent.docroot}/${label}`, parent.php_version, now())
  const d = db.query<DomainRow, [number]>('SELECT * FROM domains WHERE id = ?').get(Number(result.lastInsertRowid))!
  try {
    await hosting.writeSite(u, d)
    if ((await hosting.serverInfo()).components.dns) {
      await agent('dns.rrsets.set', { zone: parent.name, rrsets: [{ name: `${name}.`, type: 'A', ttl: 3600, records: [await hosting.publicAddress()] }] }).catch(() => null)
    }
  } catch (error) {
    db.query('DELETE FROM domains WHERE id = ?').run(d.id)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'added subdomain', detail: name, ip: ctx.ip })
  return { domain: publicDomain(d) }
})

route('PATCH', '/api/domains/:id', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  const info = await hosting.serverInfo()
  const php = ctx.body.php === undefined ? d.php_version : String(ctx.body.php)
  if (!info.php.includes(php)) throw new HttpError(400, 'Choose an installed PHP version.', 'bad_php')
  let aliases: string[] = JSON.parse(d.aliases)
  if (Array.isArray(ctx.body.aliases)) {
    aliases = [...new Set(ctx.body.aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean))]
    for (const a of aliases) {
      if (!DOMAIN.test(a)) throw new HttpError(400, `${a} is not a valid domain.`, 'bad_alias')
      const clash = db.query<{ id: number }, [string]>('SELECT id FROM domains WHERE name = ?').get(a)
      if (clash) throw new HttpError(409, `${a} is already a website on this server.`, 'taken')
    }
    if (aliases.length > 20) throw new HttpError(400, 'Up to 20 aliases per website.', 'too_many')
  }
  const forceHttps = ctx.body.forceHttps === undefined ? !!d.force_https : ctx.body.forceHttps === true
  if (forceHttps && !d.ssl_cert) throw new HttpError(400, 'Get a certificate first.', 'no_ssl')
  db.query('UPDATE domains SET php_version = ?, aliases = ?, force_https = ? WHERE id = ?').run(php, JSON.stringify(aliases), forceHttps ? 1 : 0, d.id)
  const updated = ownDomain(u, d.id)
  try {
    await hosting.syncPhp(u)
    await hosting.writeSite(u, updated)
    await hosting.writePreview(u)
  } catch (error) {
    db.query('UPDATE domains SET php_version = ?, aliases = ?, force_https = ? WHERE id = ?').run(d.php_version, d.aliases, d.force_https, d.id)
    await hosting.syncPhp(u).catch(() => null)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'updated website', detail: d.name, ip: ctx.ip })
  return { domain: publicDomain(updated) }
})

/** Redirect and error pages: website settings that only change the web server's config. */
route('PATCH', '/api/domains/:id/rules', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  let redirect = d.redirect
  if (ctx.body.redirect !== undefined) {
    const r = ctx.body.redirect as Record<string, unknown> | null
    if (!r || !r.to) redirect = null
    else {
      const to = String(r.to).trim()
      if (!/^https?:\/\/[^\s"'`$\\{};<>]+$/.test(to) || to.length > 500) throw new HttpError(400, 'Give a full address that starts with https:// or http://.', 'bad_redirect')
      if (new URL(to).hostname === d.name) throw new HttpError(400, 'A website cannot redirect to itself.', 'bad_redirect')
      redirect = JSON.stringify({ to, code: r.code === 302 ? 302 : 301, keepPath: r.keepPath !== false })
    }
  }
  let errorPages = d.error_pages
  if (ctx.body.errorPages !== undefined) {
    const pages: Record<string, string> = {}
    for (const [code, page] of Object.entries((ctx.body.errorPages ?? {}) as Record<string, unknown>)) {
      const path = String(page ?? '').trim()
      if (!path) continue
      if (!['403', '404', '500', '503'].includes(code)) throw new HttpError(400, 'Error pages can be set for 403, 404, 500 and 503.', 'bad_code')
      if (!/^\/[A-Za-z0-9._~\/-]{0,200}$/.test(path) || path.split('/').includes('..')) throw new HttpError(400, 'Give a page of this website, like /404.html.', 'bad_page')
      pages[code] = path
    }
    errorPages = JSON.stringify(pages)
  }
  db.query('UPDATE domains SET redirect = ?, error_pages = ? WHERE id = ?').run(redirect, errorPages, d.id)
  try {
    await hosting.writeSite(u, ownDomain(u, d.id))
  } catch (error) {
    db.query('UPDATE domains SET redirect = ?, error_pages = ? WHERE id = ?').run(d.redirect, d.error_pages, d.id)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'updated website', detail: d.name, ip: ctx.ip })
  return { domain: publicDomain(ownDomain(u, d.id)) }
})

// ---- protected folders ---------------------------------------------------------------------------

type Protected = { id: number; path: string; users: { name: string; hash: string }[] }

async function saveProtected(u: UserRow, d: DomainRow, list: Protected[], before: Protected[]) {
  for (const p of list) await agent('htpasswd.write', { user: u.username, file: hosting.htpasswdFile(u, d, p.id), entries: p.users })
  db.query('UPDATE domains SET protected = ? WHERE id = ?').run(JSON.stringify(list), d.id)
  await hosting.writeSite(u, ownDomain(u, d.id))
  for (const old of before) if (!list.some((p) => p.id === old.id)) await agent('htpasswd.delete', { user: u.username, file: hosting.htpasswdFile(u, d, old.id) }).catch(() => null)
}

route('POST', '/api/domains/:id/protected', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  const path = '/' + String(ctx.body.path ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!/^\/[A-Za-z0-9._~\/-]{0,200}$/.test(path) || path.split('/').includes('..')) throw new HttpError(400, 'Give a folder of the website, like /admin.', 'bad_path')
  const name = String(ctx.body.username ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) throw new HttpError(400, 'Use up to 32 letters, digits, dots, dashes or underscores for the username.', 'bad_username')
  const password = String(ctx.body.password ?? '')
  if (password.length < 8 || password.length > 72) throw new HttpError(400, 'Use 8 to 72 characters for the password.', 'bad_password')
  // Apache reads bcrypt with the $2y$ prefix.
  const hash = (await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 })).replace(/^\$2[ab]\$/, '$2y$')
  const before = JSON.parse(d.protected || '[]') as Protected[]
  const list = before.map((p) => ({ ...p, users: [...p.users] }))
  let folder = list.find((p) => p.path === path)
  if (!folder) {
    if (list.length >= 50) throw new HttpError(400, 'Up to 50 protected folders per website.', 'too_many')
    folder = { id: Math.max(0, ...list.map((p) => p.id)) + 1, path, users: [] }
    list.push(folder)
  }
  folder.users = [...folder.users.filter((x) => x.name !== name), { name, hash }]
  await saveProtected(u, d, list, before)
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'protected a folder', detail: `${d.name}${path}`, ip: ctx.ip })
  return { domain: publicDomain(ownDomain(u, d.id)) }
})

route('DELETE', '/api/domains/:id/protected', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  const before = JSON.parse(d.protected || '[]') as Protected[]
  const path = String(ctx.body.path ?? '')
  const name = ctx.body.username ? String(ctx.body.username) : null
  const list = before
    .map((p) => (p.path === path && name ? { ...p, users: p.users.filter((x) => x.name !== name) } : p))
    .filter((p) => p.path !== path || (name && p.users.length))
  await saveProtected(u, d, list, before)
  return { domain: publicDomain(ownDomain(u, d.id)) }
})

// ---- visitor statistics --------------------------------------------------------------------------

route('GET', '/api/domains/:id/stats', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  const { html } = await agent<{ html: string }>('stats.report', { user: u.username, name: d.name }, 150_000)
  // Opened in its own tab, sandboxed away from the panel: it may run its own scripts, nothing else.
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:",
      'Cache-Control': 'no-store',
    },
  })
})

route('POST', '/api/domains/:id/ssl', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  const site = hosting.siteFor(u, d)
  const cert = await agent<{ cert: string; key: string; expiresAt: number | null }>('ssl.issue', {
    names: [d.name, ...site.aliases],
    email: u.email || getSetting('support_email'),
  }, 330_000)
  db.query('UPDATE domains SET ssl_cert = ?, ssl_key = ?, ssl_expires_at = ? WHERE id = ?').run(cert.cert, cert.key, cert.expiresAt, d.id)
  await hosting.writeSite(u, ownDomain(u, d.id))
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'got a certificate', detail: d.name, ip: ctx.ip })
  return { domain: publicDomain(ownDomain(u, d.id)) }
})

route('DELETE', '/api/domains/:id', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  if (String(ctx.body.confirm ?? '') !== d.name) throw new HttpError(400, 'Type the domain to confirm.', 'confirm')
  const children = db.query<DomainRow, [number]>('SELECT * FROM domains WHERE parent_id = ?').all(d.id)
  for (const site of [...children, d]) {
    await agent('site.delete', { user: u.username, name: site.name })
    if (site.ssl_cert) await agent('ssl.delete', { name: site.name }).catch(() => null)
  }
  if (!d.parent_id) {
    await agent('dns.zone.delete', { zone: d.name }).catch(() => null)
    await mail.removeDomainMail(u, d.name)
  } else {
    const parent = db.query<DomainRow, [number]>('SELECT * FROM domains WHERE id = ?').get(d.parent_id)
    if (parent) await agent('dns.rrsets.set', { zone: parent.name, rrsets: [{ name: `${d.name}.`, type: 'A', ttl: 3600, records: [] }] }).catch(() => null)
  }
  db.query('DELETE FROM domains WHERE id = ? OR parent_id = ?').run(d.id, d.id)
  if (!d.parent_id) await mail.syncMail().catch(() => null)
  await hosting.syncPhp(u)
  await hosting.writePreview(u)
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'deleted website', detail: d.name, ip: ctx.ip })
  return { ok: true }
})

// ---- DNS ---------------------------------------------------------------------------------------

route('GET', '/api/domains/:id/dns', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  if (d.parent_id) throw new HttpError(400, 'Subdomains use the main domain’s records.', 'subdomain')
  return { zone: d.name, ...(await agent<{ rrsets: unknown[] }>('dns.zone.get', { zone: d.name })) }
})

route('PUT', '/api/domains/:id/dns', async (ctx) => {
  const u = me(ctx)
  const d = ownDomain(u, ctx.params.id)
  if (d.parent_id) throw new HttpError(400, 'Subdomains use the main domain’s records.', 'subdomain')
  const rrsets = Array.isArray(ctx.body.rrsets) ? ctx.body.rrsets : []
  if (rrsets.some((r) => String((r as { type?: unknown }).type).toUpperCase() === 'SOA')) throw new HttpError(400, 'The SOA record is managed by the server.', 'soa')
  await agent('dns.rrsets.set', { zone: d.name, rrsets })
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'changed DNS records', detail: d.name, ip: ctx.ip })
  return agent('dns.zone.get', { zone: d.name })
})

// ---- databases -----------------------------------------------------------------------------------

type DbRow = { id: number; name: string; remote: number; engine: 'mariadb' | 'postgresql'; created_at: number }
const ENGINES = ['mariadb', 'postgresql'] as const

route('GET', '/api/databases', async (ctx) => {
  const u = me(ctx)
  const rows = db.query<DbRow, [number]>('SELECT * FROM databases WHERE user_id = ? ORDER BY name').all(u.id)
  const has = (e: string) => rows.some((r) => r.engine === e)
  const [my, pg] = await Promise.all([
    has('mariadb') ? agent<Record<string, number>>('db.sizes', { user: u.username }).catch(() => ({} as Record<string, number>)) : ({} as Record<string, number>),
    has('postgresql') ? agent<Record<string, number>>('pg.sizes', { user: u.username }).catch(() => ({} as Record<string, number>)) : ({} as Record<string, number>),
  ])
  const components = (await hosting.serverInfo()).components
  return {
    databases: rows.map((r) => ({
      id: r.id, name: r.name, user: r.name, engine: r.engine, remote: !!r.remote,
      size: (r.engine === 'postgresql' ? pg : my)[r.name] ?? 0, createdAt: r.created_at,
    })),
    engines: ENGINES.filter((e) => components[e]),
    adminer: components.mariadb || components.postgresql ? `http://${await hosting.publicAddress()}/dbadmin/` : null,
  }
})

route('POST', '/api/databases', async (ctx) => {
  const u = me(ctx)
  const engine = String(ctx.body.engine || 'mariadb') as DbRow['engine']
  if (!ENGINES.includes(engine) || !(await hosting.serverInfo()).components[engine]) throw new HttpError(400, 'That database engine is not installed on this server.', 'no_engine')
  const suffix = String(ctx.body.name ?? '').trim().toLowerCase()
  if (!/^[a-z0-9]{1,32}$/.test(suffix)) throw new HttpError(400, 'Use up to 32 lowercase letters or digits.', 'bad_name')
  const name = `${u.username}_${suffix}`
  if (db.query('SELECT 1 FROM databases WHERE name = ?').get(name)) throw new HttpError(409, 'You already have that database.', 'taken')
  within(u, 'databases', count('SELECT COUNT(*) AS n FROM databases WHERE user_id = ?', u.id), 'databases')
  const password = String(ctx.body.password || generatePassword(20))
  if (password.length < 10) throw new HttpError(400, 'Use at least 10 characters.', 'weak_password')
  if (engine === 'postgresql') await agent('pg.create', { name, password })
  else {
    await agent('db.create', { name })
    await agent('db.user.set', { name, database: name, password })
  }
  const result = db.query('INSERT INTO databases(user_id, name, engine, created_at) VALUES(?,?,?,?)').run(u.id, name, engine, now())
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'created database', detail: name, ip: ctx.ip })
  return { database: { id: Number(result.lastInsertRowid), name, user: name, engine }, password }
})

function ownDatabase(u: UserRow, id: unknown) {
  const row = db.query<DbRow, [number, number]>('SELECT * FROM databases WHERE id = ? AND user_id = ?').get(Number(id), u.id)
  if (!row) throw new HttpError(404, 'Database not found.', 'not_found')
  return row
}

route('POST', '/api/databases/:id/password', async (ctx) => {
  const u = me(ctx)
  const row = ownDatabase(u, ctx.params.id)
  const password = String(ctx.body.password || generatePassword(20))
  if (password.length < 10) throw new HttpError(400, 'Use at least 10 characters.', 'weak_password')
  if (row.engine === 'postgresql') await agent('pg.password', { name: row.name, password })
  else await agent('db.user.set', { name: row.name, database: row.name, password, remote: !!row.remote })
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'changed database password', detail: row.name, ip: ctx.ip })
  return { password }
})

route('PATCH', '/api/databases/:id', async (ctx) => {
  const u = me(ctx)
  const row = ownDatabase(u, ctx.params.id)
  if (row.engine !== 'mariadb') throw new HttpError(400, 'Remote access is available for MariaDB databases.', 'mariadb_only')
  const remote = ctx.body.remote === true
  await agent('db.user.set', { name: row.name, database: row.name, remote })
  db.query('UPDATE databases SET remote = ? WHERE id = ?').run(remote ? 1 : 0, row.id)
  return { ok: true }
})

route('DELETE', '/api/databases/:id', async (ctx) => {
  const u = me(ctx)
  const row = ownDatabase(u, ctx.params.id)
  if (String(ctx.body.confirm ?? '') !== row.name) throw new HttpError(400, 'Type the database name to confirm.', 'confirm')
  if (row.engine === 'postgresql') await agent('pg.delete', { name: row.name })
  else {
    await agent('db.delete', { name: row.name })
    await agent('db.user.delete', { name: row.name })
  }
  db.query('DELETE FROM databases WHERE id = ?').run(row.id)
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'deleted database', detail: row.name, ip: ctx.ip })
  return { ok: true }
})

// ---- Redis ---------------------------------------------------------------------------------------

route('GET', '/api/redis', async (ctx) => {
  const u = me(ctx)
  const installed = (await hosting.serverInfo()).components.redis
  const memory = hosting.redisMemory(u)
  if (!installed || memory === 0) return { available: false, enabled: false }
  const status = u.redis_enabled ? await agent<Record<string, unknown>>('redis.status', { user: u.username }).catch(() => ({ enabled: true, active: false })) : { enabled: false }
  return { available: true, memoryMb: memory, ...status }
})

route('PUT', '/api/redis', async (ctx) => {
  const u = me(ctx)
  const memory = hosting.redisMemory(u)
  if (!(await hosting.serverInfo()).components.redis || memory === 0) throw new HttpError(403, 'Your plan does not include Redis.', 'no_redis')
  if (ctx.body.enabled === true) {
    await agent('redis.enable', { user: u.username, memory_mb: memory })
    db.query('UPDATE users SET redis_enabled = 1 WHERE id = ?').run(u.id)
  } else {
    await agent('redis.disable', { user: u.username })
    db.query('UPDATE users SET redis_enabled = 0 WHERE id = ?').run(u.id)
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: ctx.body.enabled === true ? 'turned on Redis' : 'turned off Redis', ip: ctx.ip })
  return { ok: true }
})

// ---- cron jobs -----------------------------------------------------------------------------------

const SCHEDULE = /^(@(reboot|hourly|daily|weekly|monthly|yearly)|([\d*/,-]+\s+){4}[\d*/,-]+)$/

async function writeCron(u: UserRow) {
  const jobs = db.query<{ schedule: string; command: string }, [number]>('SELECT schedule, command FROM cron_jobs WHERE user_id = ? ORDER BY id').all(u.id)
  await agent('cron.write', { user: u.username, jobs })
}

route('GET', '/api/cron', (ctx) => {
  const u = me(ctx)
  return { jobs: db.query<{ id: number; schedule: string; command: string; created_at: number }, [number]>('SELECT * FROM cron_jobs WHERE user_id = ? ORDER BY id').all(u.id) }
})

route('POST', '/api/cron', async (ctx) => {
  const u = me(ctx)
  const schedule = String(ctx.body.schedule ?? '').trim().replace(/\s+/g, ' ')
  const command = String(ctx.body.command ?? '').trim()
  if (!SCHEDULE.test(schedule)) throw new HttpError(400, 'Use five fields like */5 * * * *, or @daily.', 'bad_schedule')
  if (!command || command.length > 2000 || /[\n\r]/.test(command)) throw new HttpError(400, 'Enter a command on one line.', 'bad_command')
  within(u, 'cron_jobs', count('SELECT COUNT(*) AS n FROM cron_jobs WHERE user_id = ?', u.id), 'cron jobs')
  db.query('INSERT INTO cron_jobs(user_id, schedule, command, created_at) VALUES(?,?,?,?)').run(u.id, schedule, command, now())
  try {
    await writeCron(u)
  } catch (error) {
    db.query('DELETE FROM cron_jobs WHERE id = (SELECT MAX(id) FROM cron_jobs WHERE user_id = ?)').run(u.id)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'added cron job', detail: schedule, ip: ctx.ip })
  return { ok: true }
})

route('DELETE', '/api/cron/:id', async (ctx) => {
  const u = me(ctx)
  const result = db.query('DELETE FROM cron_jobs WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), u.id)
  if (!result.changes) throw new HttpError(404, 'Cron job not found.', 'not_found')
  await writeCron(u)
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'deleted cron job', ip: ctx.ip })
  return { ok: true }
})

// ---- PHP settings and access ------------------------------------------------------------------------

const PHP_KEYS: Record<string, RegExp> = {
  memory_limit: /^\d{2,5}M$/,
  upload_max_filesize: /^\d{1,5}M$/,
  post_max_size: /^\d{1,5}M$/,
  max_execution_time: /^\d{1,4}$/,
  max_input_vars: /^\d{3,6}$/,
}

route('PUT', '/api/php', async (ctx) => {
  const u = me(ctx)
  const settings: Record<string, string | boolean> = {}
  for (const [key, pattern] of Object.entries(PHP_KEYS)) {
    const value = String(ctx.body[key] ?? '').trim()
    if (!value) continue
    if (!pattern.test(value)) throw new HttpError(400, `${key} has an invalid value.`, 'bad_value')
    settings[key] = value
  }
  settings.display_errors = ctx.body.display_errors === true
  const before = u.php_settings
  db.query('UPDATE users SET php_settings = ? WHERE id = ?').run(JSON.stringify(settings), u.id)
  try {
    await hosting.syncPhp(userById(u.id)!)
  } catch (error) {
    db.query('UPDATE users SET php_settings = ? WHERE id = ?').run(before, u.id)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'changed PHP settings', ip: ctx.ip })
  return { settings }
})
