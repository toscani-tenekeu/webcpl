import { isAdmin, requireRole, resellerUsage } from '../access.ts'
import { agent } from '../agent.ts'
import { version } from '../config.ts'
import { allSettings, db, getSetting, logActivity, setSetting } from '../db.ts'
import { HttpError } from '../errors.ts'
import { route } from '../http.ts'

// ---- server (admin) ----------------------------------------------------------------

route('GET', '/api/server', async (ctx) => {
  requireRole(ctx.user!, 'admin')
  const [info, components] = await Promise.all([
    agent('system.info').catch((error: Error) => ({ error: error.message })),
    agent('components.status').catch(() => null),
  ])
  return { info, components, version }
})

route('POST', '/api/server/services/:name/:action', async (ctx) => {
  requireRole(ctx.user!, 'admin')
  const result = await agent('service.action', { name: ctx.params.name, action: ctx.params.action }, 150_000)
  logActivity({ actorId: ctx.user!.id, action: `${ctx.params.action} service`, detail: ctx.params.name, ip: ctx.ip })
  return result
})

const SETTINGS = ['panel_name', 'hostname', 'nameserver1', 'nameserver2', 'support_email', 'public_ip']

route('GET', '/api/settings', (ctx) => {
  requireRole(ctx.user!, 'admin')
  return { settings: allSettings(SETTINGS) }
})

route('PUT', '/api/settings', (ctx) => {
  requireRole(ctx.user!, 'admin')
  const next: Record<string, string> = {}
  for (const key of SETTINGS) next[key] = String(ctx.body[key] ?? getSetting(key)).trim()
  if (!next.panel_name) next.panel_name = 'Webcpl'
  const host = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
  for (const key of ['hostname', 'nameserver1', 'nameserver2']) {
    if (next[key] && !host.test(next[key]!)) throw new HttpError(400, `${key === 'hostname' ? 'Hostname' : 'Name server'} must be a full name like panel.example.com.`, 'bad_host')
  }
  if (next.public_ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(next.public_ip)) throw new HttpError(400, 'Enter the server’s public IPv4 address, like 203.0.113.10.', 'bad_ip')
  if (next.support_email && !/^\S+@\S+\.\S+$/.test(next.support_email)) throw new HttpError(400, 'Enter a valid email address.', 'bad_email')
  for (const [key, value] of Object.entries(next)) setSetting(key, value)
  logActivity({ actorId: ctx.user!.id, action: 'changed panel settings', ip: ctx.ip })
  return { settings: allSettings(SETTINGS) }
})

// ---- dashboard (everyone) -----------------------------------------------------------------

route('GET', '/api/dashboard', (ctx) => {
  const actor = ctx.user!
  const count = (sql: string, ...args: number[]) => db.query<{ n: number }, number[]>(sql).get(...args)!.n
  if (isAdmin(actor)) {
    return {
      counts: {
        resellers: count("SELECT COUNT(*) AS n FROM users WHERE role = 'reseller'"),
        users: count("SELECT COUNT(*) AS n FROM users WHERE role = 'user'"),
        suspended: count('SELECT COUNT(*) AS n FROM users WHERE suspended = 1'),
        plans: count('SELECT COUNT(*) AS n FROM plans WHERE owner_id = ?', actor.id),
      },
    }
  }
  if (actor.role === 'reseller') {
    return {
      counts: {
        users: count('SELECT COUNT(*) AS n FROM users WHERE owner_id = ?', actor.id),
        suspended: count('SELECT COUNT(*) AS n FROM users WHERE owner_id = ? AND suspended = 1', actor.id),
        plans: count('SELECT COUNT(*) AS n FROM plans WHERE owner_id = ?', actor.id),
      },
      usage: resellerUsage(actor),
    }
  }
  return {}
})

// ---- activity -------------------------------------------------------------------------------

interface ActivityRow {
  id: number
  at: number
  action: string
  detail: string
  ip: string
  actor: string | null
  subject: string | null
}

/** Admins see everything; resellers their own actions and their accounts'; users their own. */
route('GET', '/api/activity', (ctx) => {
  const actor = ctx.user!
  const before = Number(ctx.url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER
  const base = `SELECT a.id, a.at, a.action, a.detail, a.ip, ua.username AS actor, us.username AS subject
    FROM activity a LEFT JOIN users ua ON ua.id = a.actor_id LEFT JOIN users us ON us.id = a.subject_id WHERE a.id < ?`
  const rows = isAdmin(actor)
    ? db.query<ActivityRow, [number]>(`${base} ORDER BY a.id DESC LIMIT 100`).all(before)
    : actor.role === 'reseller'
      ? db
          .query<ActivityRow, [number, number, number, number, number]>(
            `${base} AND (a.actor_id = ? OR a.subject_id = ? OR a.subject_id IN (SELECT id FROM users WHERE owner_id = ?) OR a.actor_id IN (SELECT id FROM users WHERE owner_id = ?)) ORDER BY a.id DESC LIMIT 100`,
          )
          .all(before, actor.id, actor.id, actor.id, actor.id)
      : db
          .query<ActivityRow, [number, number, number]>(`${base} AND (a.subject_id = ? OR a.actor_id = ?) ORDER BY a.id DESC LIMIT 100`)
          .all(before, actor.id, actor.id)
  // A reseller's or user's view never shows the admin's address.
  const showIp = isAdmin(actor)
  return { events: rows.map((r) => ({ ...r, ip: showIp || r.actor === actor.username ? r.ip : '' })) }
})

