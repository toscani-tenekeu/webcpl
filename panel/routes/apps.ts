import { agent } from '../agent.ts'
import { db, logActivity, now, userById, type AppRow, type DomainRow, type UserRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import * as hosting from '../hosting.ts'
import { route, type Ctx } from '../http.ts'

const RUNTIMES = ['node', 'python', 'ruby'] as const
const DEFAULT_COMMAND = { node: 'npm start', python: 'gunicorn -b 127.0.0.1:$PORT app:app', ruby: 'bundle exec puma -b tcp://127.0.0.1:$PORT' }

function me(ctx: Ctx) {
  const u = userById(ctx.user!.id)!
  hosting.requireHosting(u)
  if (u.suspended && !ctx.impersonatorId) throw new HttpError(403, 'This account is suspended.', 'suspended')
  if (hosting.hostingLimits(u).apps !== true) throw new HttpError(403, 'Your plan does not include apps.', 'no_apps')
  return u
}

function own(u: UserRow, id: unknown) {
  const app = db.query<AppRow, [number, number]>('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(Number(id), u.id)
  if (!app) throw new HttpError(404, 'App not found.', 'not_found')
  return app
}

async function available() {
  const components = (await hosting.serverInfo()).components
  const found = await agent<{ node: string[]; python: string | null; ruby: string | null }>('apps.runtimes').catch(() => ({ node: [], python: null, ruby: null }))
  return {
    node: components.node ? found.node : [],
    python: components.python && found.python ? [found.python] : [],
    ruby: components.ruby && found.ruby ? [found.ruby] : [],
  }
}

async function freePort() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = 30000 + Math.floor(Math.random() * 10000)
    if (db.query('SELECT 1 FROM apps WHERE port = ?').get(port)) continue
    try {
      Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true)
      return port
    } catch {}
  }
  throw new HttpError(503, 'No free port is left for apps.', 'no_port')
}

function cleanEnv(input: unknown) {
  const env: Record<string, string> = {}
  if (!input || typeof input !== 'object') return env
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new HttpError(400, `“${key}” is not a valid variable name.`, 'bad_env')
    if (['PORT', 'HOST', 'PATH', 'HOME', 'USER'].includes(key)) throw new HttpError(400, `${key} is set by the panel.`, 'bad_env')
    const text = String(value ?? '')
    if (/[\0\n\r]/.test(text) || text.length > 4000) throw new HttpError(400, `The value of ${key} must be one line.`, 'bad_env')
    env[key] = text
  }
  if (Object.keys(env).length > 100) throw new HttpError(400, 'Use at most 100 variables.', 'bad_env')
  return env
}

function cleanRoot(value: unknown) {
  const root = String(value ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!root || root.length > 200 || root.split('/').some((p) => !p || p === '.' || p === '..') || !/^[A-Za-z0-9._/-]+$/.test(root)) {
    throw new HttpError(400, 'Give a folder inside your home, like apps/myapp.', 'bad_root')
  }
  return root
}

function cleanDomain(u: UserRow, value: unknown, appId: number | null) {
  if (value === null || value === undefined || value === '') return null
  const d = db.query<DomainRow, [number, number]>('SELECT * FROM domains WHERE id = ? AND user_id = ?').get(Number(value), u.id)
  if (!d) throw new HttpError(404, 'Website not found.', 'not_found')
  const taken = db.query<{ id: number }, [number]>('SELECT id FROM apps WHERE domain_id = ?').get(d.id)
  if (taken && taken.id !== appId) throw new HttpError(409, 'Another app already serves that website.', 'domain_taken')
  return d
}

async function write(u: UserRow, app: AppRow, start = true) {
  await agent('app.write', {
    user: u.username, name: app.name, runtime: app.runtime, version: app.version, root: app.root, command: app.command,
    port: app.port, env: JSON.parse(app.env), start,
  })
}

async function refreshSite(u: UserRow, domainId: number | null) {
  if (!domainId) return
  const d = db.query<DomainRow, [number]>('SELECT * FROM domains WHERE id = ?').get(domainId)
  if (d) await hosting.writeSite(u, d)
}

function publicApp(app: AppRow, status?: { state: string; memoryBytes: number | null; since: number | null; restarts: number }) {
  const domain = app.domain_id ? db.query<{ name: string }, [number]>('SELECT name FROM domains WHERE id = ?').get(app.domain_id) : null
  return {
    id: app.id, name: app.name, runtime: app.runtime, version: app.version, root: app.root, command: app.command, port: app.port,
    env: JSON.parse(app.env) as Record<string, string>, domainId: app.domain_id, domain: domain?.name ?? null,
    state: status?.state ?? 'unknown', memoryBytes: status?.memoryBytes ?? null, since: status?.since ?? null, restarts: status?.restarts ?? 0,
    createdAt: app.created_at,
  }
}

route('GET', '/api/apps', async (ctx) => {
  const u = me(ctx)
  const rows = db.query<AppRow, [number]>('SELECT * FROM apps WHERE user_id = ? ORDER BY name').all(u.id)
  const status = rows.length ? await agent<Record<string, Parameters<typeof publicApp>[1]>>('app.status', { user: u.username, names: rows.map((r) => r.name) }).catch(() => ({})) : {}
  const domains = db.query<{ id: number; name: string }, [number]>('SELECT id, name FROM domains WHERE user_id = ? ORDER BY name').all(u.id)
  return { apps: rows.map((r) => publicApp(r, (status as Record<string, Parameters<typeof publicApp>[1]>)[r.name])), runtimes: await available(), domains, defaults: DEFAULT_COMMAND }
})

route('POST', '/api/apps', async (ctx) => {
  const u = me(ctx)
  const name = String(ctx.body.name ?? '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new HttpError(400, 'Use 2–31 lowercase letters, digits or hyphens, starting with a letter.', 'bad_name')
  if (db.query('SELECT 1 FROM apps WHERE user_id = ? AND name = ?').get(u.id, name)) throw new HttpError(409, 'You already have an app with that name.', 'taken')
  const runtime = String(ctx.body.runtime) as AppRow['runtime']
  if (!RUNTIMES.includes(runtime)) throw new HttpError(400, 'Choose Node.js, Python or Ruby.', 'bad_runtime')
  const versions = (await available())[runtime]
  const version = String(ctx.body.version || versions.at(-1) || '')
  if (!versions.includes(version)) throw new HttpError(400, 'That runtime is not installed on this server.', 'bad_runtime')
  const root = cleanRoot(ctx.body.root || `apps/${name}`)
  const command = String(ctx.body.command || DEFAULT_COMMAND[runtime]).trim()
  if (!command || command.length > 500 || /[\n\r]/.test(command)) throw new HttpError(400, 'The start command must be one line.', 'bad_command')
  const env = cleanEnv(ctx.body.env)
  const domain = cleanDomain(u, ctx.body.domainId, null)
  const port = await freePort()
  const id = Number(db.query('INSERT INTO apps(user_id, name, runtime, version, root, command, port, env, domain_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(u.id, name, runtime, version, root, command, port, JSON.stringify(env), domain?.id ?? null, now()).lastInsertRowid)
  const app = db.query<AppRow, [number]>('SELECT * FROM apps WHERE id = ?').get(id)!
  try {
    // A new app usually has no code yet: set it up, start it once the user asks.
    await write(u, app, false)
    await refreshSite(u, app.domain_id)
  } catch (error) {
    db.query('DELETE FROM apps WHERE id = ?').run(id)
    await agent('app.delete', { user: u.username, name }).catch(() => null)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'created app', detail: name, ip: ctx.ip })
  return { app: publicApp(app) }
})

route('PATCH', '/api/apps/:id', async (ctx) => {
  const u = me(ctx)
  const app = own(u, ctx.params.id)
  const next = { ...app }
  if (ctx.body.command !== undefined) {
    const command = String(ctx.body.command).trim()
    if (!command || command.length > 500 || /[\n\r]/.test(command)) throw new HttpError(400, 'The start command must be one line.', 'bad_command')
    next.command = command
  }
  if (ctx.body.version !== undefined) {
    const version = String(ctx.body.version)
    if (!(await available())[app.runtime].includes(version)) throw new HttpError(400, 'That runtime is not installed on this server.', 'bad_runtime')
    next.version = version
  }
  if (ctx.body.root !== undefined) next.root = cleanRoot(ctx.body.root)
  if (ctx.body.env !== undefined) next.env = JSON.stringify(cleanEnv(ctx.body.env))
  if (ctx.body.domainId !== undefined) next.domain_id = cleanDomain(u, ctx.body.domainId, app.id)?.id ?? null
  db.query('UPDATE apps SET command = ?, version = ?, root = ?, env = ?, domain_id = ? WHERE id = ?').run(next.command, next.version, next.root, next.env, next.domain_id, app.id)
  const status = await agent<Record<string, { state: string }>>('app.status', { user: u.username, names: [app.name] }).catch(() => ({} as Record<string, { state: string }>))
  await write(u, next, status[app.name]?.state === 'active')
  if (next.domain_id !== app.domain_id) {
    await refreshSite(u, app.domain_id)
    await refreshSite(u, next.domain_id)
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'updated app', detail: app.name, ip: ctx.ip })
  return { app: publicApp(next) }
})

route('POST', '/api/apps/:id/power', async (ctx) => {
  const u = me(ctx)
  const app = own(u, ctx.params.id)
  const action = String(ctx.body.action)
  if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, 'Unknown action.', 'bad_action')
  await agent('app.power', { user: u.username, name: app.name, action })
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: `${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'} app`, detail: app.name, ip: ctx.ip })
  return { ok: true }
})

// Installs can take minutes, longer than an HTTP request may stay open: they run in the
// background and the page asks for the result.
const installs = new Map<number, { running: boolean; ok: boolean | null; output: string; at: number }>()

route('POST', '/api/apps/:id/install', async (ctx) => {
  const u = me(ctx)
  const app = own(u, ctx.params.id)
  if (installs.get(app.id)?.running) throw new HttpError(409, 'An installation is already running.', 'busy')
  installs.set(app.id, { running: true, ok: null, output: '', at: Date.now() })
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'installed app dependencies', detail: app.name, ip: ctx.ip })
  void agent<{ ok: boolean; output: string }>('app.install', { user: u.username, name: app.name, runtime: app.runtime, version: app.version, root: app.root }, 16 * 60_000)
    .then((r) => installs.set(app.id, { running: false, ok: r.ok, output: r.output, at: Date.now() }))
    .catch((e: Error) => installs.set(app.id, { running: false, ok: false, output: e.message, at: Date.now() }))
  return { running: true }
})

route('GET', '/api/apps/:id/install', (ctx) => {
  const u = me(ctx)
  const app = own(u, ctx.params.id)
  return installs.get(app.id) ?? { running: false, ok: null, output: '' }
})

route('GET', '/api/apps/:id/logs', async (ctx) => {
  const u = me(ctx)
  const app = own(u, ctx.params.id)
  return agent('app.logs', { user: u.username, name: app.name, lines: Number(ctx.url.searchParams.get('lines')) || 200 })
})

route('DELETE', '/api/apps/:id', async (ctx) => {
  const u = me(ctx)
  const app = own(u, ctx.params.id)
  if (String(ctx.body.confirm ?? '') !== app.name) throw new HttpError(400, 'Type the app name to confirm.', 'confirm')
  await agent('app.delete', { user: u.username, name: app.name })
  db.query('DELETE FROM apps WHERE id = ?').run(app.id)
  await refreshSite(u, app.domain_id)
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'deleted app', detail: app.name, ip: ctx.ip })
  return { ok: true }
})
