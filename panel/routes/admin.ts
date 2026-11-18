import { requireRole } from '../access.ts'
import { agent } from '../agent.ts'
import { config } from '../config.ts'
import { getSetting, logActivity, userById } from '../db.ts'
import { HttpError } from '../errors.ts'
import { route, type Ctx } from '../http.ts'
import { recentMetrics } from '../metrics.ts'

function admin(ctx: Ctx) {
  requireRole(ctx.user!, 'admin')
  return ctx.user!
}
const log = (ctx: Ctx, action: string, detail = '') => logActivity({ actorId: ctx.user!.id, action, detail, ip: ctx.ip })

route('GET', '/api/server/metrics', (ctx) => {
  admin(ctx)
  return { samples: recentMetrics() }
})

// ---- firewall ----
route('GET', '/api/server/firewall', async (ctx) => {
  admin(ctx)
  return agent('firewall.status')
})
route('PUT', '/api/server/firewall', async (ctx) => {
  admin(ctx)
  await agent('firewall.enable', { on: ctx.body.on === true })
  log(ctx, ctx.body.on === true ? 'turned on the firewall' : 'turned off the firewall')
  return agent('firewall.status')
})
route('POST', '/api/server/firewall/rules', async (ctx) => {
  admin(ctx)
  await agent('firewall.add', { action: ctx.body.action, port: ctx.body.port, proto: ctx.body.proto, from: ctx.body.from })
  log(ctx, 'added a firewall rule', `${ctx.body.action} ${ctx.body.port}/${ctx.body.proto}${ctx.body.from ? ` from ${ctx.body.from}` : ''}`)
  return agent('firewall.status')
})
route('DELETE', '/api/server/firewall/rules', async (ctx) => {
  admin(ctx)
  await agent('firewall.delete', { rule: ctx.body.rule })
  log(ctx, 'removed a firewall rule', String(ctx.body.rule ?? ''))
  return agent('firewall.status')
})

// ---- Fail2ban ----
route('GET', '/api/server/fail2ban', async (ctx) => {
  admin(ctx)
  return agent('fail2ban.status')
})
route('POST', '/api/server/fail2ban/unban', async (ctx) => {
  admin(ctx)
  await agent('fail2ban.unban', { ip: ctx.body.ip })
  log(ctx, 'unbanned an address', String(ctx.body.ip ?? ''))
  return agent('fail2ban.status')
})

// ---- updates ----
route('GET', '/api/server/updates', async (ctx) => {
  admin(ctx)
  const [system, webcpl] = await Promise.all([agent('updates.job', { kind: 'system' }), agent('updates.job', { kind: 'webcpl' })])
  return { system, webcpl }
})
route('POST', '/api/server/updates/check', async (ctx) => {
  admin(ctx)
  return agent('updates.check', {}, 6 * 60_000)
})
route('POST', '/api/server/updates/start', async (ctx) => {
  admin(ctx)
  const kind = ctx.body.kind === 'webcpl' ? 'webcpl' : 'system'
  await agent('updates.start', { kind })
  log(ctx, kind === 'webcpl' ? 'started a Webcpl update' : 'started a system update')
  return { ok: true }
})

// ---- the hostname's certificate and HTTPS for the panel ----
route('GET', '/api/server/ssl', async (ctx) => {
  admin(ctx)
  return { certificate: await agent('ssl.hostname.status'), hostname: getSetting('hostname') || null, tls: !!config.tls, port: config.port }
})
route('POST', '/api/server/ssl', async (ctx) => {
  const u = admin(ctx)
  const hostname = getSetting('hostname')
  if (!hostname) throw new HttpError(400, 'Set the server hostname first, and point it to this server.', 'no_hostname')
  await agent('ssl.hostname', { hostname, email: userById(u.id)?.email || getSetting('support_email') || '' }, 6 * 60_000)
  log(ctx, 'got a certificate for the hostname', hostname)
  return { certificate: await agent('ssl.hostname.status') }
})
route('PUT', '/api/server/ssl/panel', async (ctx) => {
  admin(ctx)
  await agent('panel.tls', { on: ctx.body.on === true })
  log(ctx, ctx.body.on === true ? 'turned on HTTPS for the panel' : 'turned off HTTPS for the panel')
  return { ok: true, restarting: true }
})
