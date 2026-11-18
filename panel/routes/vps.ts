import { canManage, isAdmin, requireRole } from '../access.ts'
import { agent } from '../agent.ts'
import { db, logActivity, now, userById, type UserRow, type VpsRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import { route, type Ctx } from '../http.ts'
import * as virt from '../vps.ts'

/** The instance, if the signed-in account owns it or manages its owner. */
function reach(ctx: Ctx) {
  const v = virt.vpsById(Number(ctx.params.id))
  const owner = v ? userById(v.user_id) : null
  if (!v || !owner || (v.user_id !== ctx.user!.id && !canManage(ctx.user!, owner))) throw new HttpError(404, 'VPS not found.', 'not_found')
  return { v, owner }
}

function ready(v: VpsRow) {
  if (v.status !== 'ready') throw new HttpError(409, 'Wait until the VPS is ready.', 'busy')
}

const log = (ctx: Ctx, owner: UserRow, action: string, detail: string) =>
  logActivity({ actorId: ctx.user!.id, subjectId: owner.id, action, detail, ip: ctx.ip })

route('GET', '/api/vps', async (ctx) => {
  const u = ctx.user!
  // Admins and resellers can list every VPS they manage.
  if (ctx.url.searchParams.get('all') === '1' && u.role !== 'user') {
    const rows = db.query<VpsRow & { username: string; owner_id: number | null }, []>(
      'SELECT vps.*, users.username, users.owner_id FROM vps JOIN users ON users.id = vps.user_id ORDER BY vps.id').all()
      .filter((r) => isAdmin(u) || r.owner_id === u.id)
    const live = await virt.liveState(rows)
    return { vps: rows.map((r) => ({ ...virt.publicVps(r, live[r.instance]), owner: r.username })) }
  }
  if (!virt.hasVps(u)) throw new HttpError(404, 'This account has no VPS plan.', 'no_vps')
  const rows = virt.vpsOf(u.id)
  const live = await virt.liveState(rows)
  return {
    vps: rows.map((r) => virt.publicVps(r, live[r.instance])),
    limits: virt.vpsLimits(u),
    room: virt.room(u),
    images: virt.availableImages(),
  }
})

route('POST', '/api/vps', async (ctx) => {
  const u = ctx.user!
  if (!virt.hasVps(u)) throw new HttpError(404, 'This account has no VPS plan.', 'no_vps')
  const v = await virt.create(u, ctx.body)
  log(ctx, u, 'created VPS', v.name)
  return { vps: virt.publicVps(v) }
})

route('GET', '/api/vps/:id', async (ctx) => {
  const { v, owner } = reach(ctx)
  const live = await virt.liveState([v])
  return {
    vps: virt.publicVps(v, live[v.instance]),
    owner: owner.username,
    limits: virt.vpsLimits(owner),
    room: virt.room(owner, v.id),
    images: virt.availableImages(),
  }
})

route('POST', '/api/vps/:id/power', async (ctx) => {
  const { v, owner } = reach(ctx)
  ready(v)
  const action = String(ctx.body.action)
  if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, 'Unknown action.', 'bad_action')
  if (action !== 'stop' && owner.suspended) throw new HttpError(403, 'This account is suspended.', 'suspended')
  await agent('vps.power', { name: v.instance, action }, 150_000)
  log(ctx, owner, `${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'} VPS`, v.name)
  return { ok: true }
})

route('POST', '/api/vps/:id/resize', async (ctx) => {
  const { v, owner } = reach(ctx)
  ready(v)
  const values = virt.checkResources(owner, ctx.body, v.id)
  if (values.disk_gb < v.disk_gb) throw new HttpError(400, 'The disk cannot shrink.', 'bad_disk')
  await agent('vps.resize', { name: v.instance, ...values }, 120_000)
  db.query('UPDATE vps SET vcpu = ?, memory_mb = ?, disk_gb = ? WHERE id = ?').run(values.vcpu, values.memory_mb, values.disk_gb, v.id)
  log(ctx, owner, 'resized VPS', `${v.name}: ${values.vcpu} vCPU, ${values.memory_mb} MB, ${values.disk_gb} GB`)
  return { ok: true }
})

route('POST', '/api/vps/:id/reinstall', async (ctx) => {
  const { v, owner } = reach(ctx)
  if (v.status === 'creating' || v.status === 'deleting') throw new HttpError(409, 'Wait until the VPS is ready.', 'busy')
  if (String(ctx.body.confirm ?? '') !== v.name) throw new HttpError(400, 'Type the VPS name to confirm.', 'confirm')
  virt.reinstall(v, ctx.body)
  log(ctx, owner, 'reinstalled VPS', v.name)
  return { ok: true }
})

route('POST', '/api/vps/:id/password', async (ctx) => {
  const { v, owner } = reach(ctx)
  ready(v)
  await agent('vps.password', { name: v.instance, password: virt.checkPassword(ctx.body.password) })
  log(ctx, owner, 'changed VPS root password', v.name)
  return { ok: true }
})

route('GET', '/api/vps/:id/snapshots', async (ctx) => {
  const { v, owner } = reach(ctx)
  const list = v.status === 'ready' ? await agent<{ name: string; createdAt: number }[]>('vps.snapshots', { name: v.instance }) : []
  return { snapshots: list, limit: virt.vpsLimits(owner).snapshots ?? null }
})

route('POST', '/api/vps/:id/snapshots', async (ctx) => {
  const { v, owner } = reach(ctx)
  ready(v)
  const limit = virt.vpsLimits(owner).snapshots
  const list = await agent<unknown[]>('vps.snapshots', { name: v.instance })
  if (typeof limit === 'number' && list.length >= limit) throw new HttpError(403, 'Your plan allows no more snapshots. Delete one first.', 'plan_full')
  const name = String(ctx.body.name ?? '').trim() || `snap-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) throw new HttpError(400, 'Use letters, digits, dots, dashes or underscores.', 'bad_name')
  await agent('vps.snapshot', { name: v.instance, snapshot: name, action: 'create' }, 11 * 60_000)
  log(ctx, owner, 'took a VPS snapshot', `${v.name}/${name}`)
  return { ok: true }
})

route('POST', '/api/vps/:id/snapshots/:snap/restore', async (ctx) => {
  const { v, owner } = reach(ctx)
  ready(v)
  await agent('vps.snapshot', { name: v.instance, snapshot: ctx.params.snap, action: 'restore' }, 11 * 60_000)
  log(ctx, owner, 'restored a VPS snapshot', `${v.name}/${ctx.params.snap}`)
  return { ok: true }
})

route('DELETE', '/api/vps/:id/snapshots/:snap', async (ctx) => {
  const { v, owner } = reach(ctx)
  ready(v)
  await agent('vps.snapshot', { name: v.instance, snapshot: ctx.params.snap, action: 'delete' }, 6 * 60_000)
  log(ctx, owner, 'deleted a VPS snapshot', `${v.name}/${ctx.params.snap}`)
  return { ok: true }
})

route('DELETE', '/api/vps/:id', async (ctx) => {
  const { v, owner } = reach(ctx)
  if (String(ctx.body.confirm ?? '') !== v.name) throw new HttpError(400, 'Type the VPS name to confirm.', 'confirm')
  await virt.remove(v)
  log(ctx, owner, 'deleted VPS', v.name)
  return { ok: true }
})

// ---- public IPv4 addresses ---------------------------------------------------------------------

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

route('GET', '/api/server/ips', (ctx) => {
  requireRole(ctx.user!, 'admin')
  return {
    ips: db.query<{ ip: string; vps_id: number | null; name: string | null; username: string | null }, []>(
      `SELECT vps_ips.ip, vps_ips.vps_id, vps.name, users.username FROM vps_ips
       LEFT JOIN vps ON vps.id = vps_ips.vps_id LEFT JOIN users ON users.id = vps.user_id ORDER BY vps_ips.ip`).all()
      .map((r) => ({ ip: r.ip, vps: r.vps_id ? { id: r.vps_id, name: r.name, owner: r.username } : null })),
  }
})

route('POST', '/api/server/ips', (ctx) => {
  requireRole(ctx.user!, 'admin')
  const ips = String(ctx.body.ips ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
  if (!ips.length) throw new HttpError(400, 'Give one or more IPv4 addresses.', 'no_ip')
  for (const ip of ips) if (!IPV4.test(ip)) throw new HttpError(400, `${ip} is not an IPv4 address.`, 'bad_ip')
  for (const ip of ips) db.query('INSERT OR IGNORE INTO vps_ips(ip, created_at) VALUES(?, ?)').run(ip, now())
  logActivity({ actorId: ctx.user!.id, action: 'added public IPs', detail: ips.join(', '), ip: ctx.ip })
  return { ok: true }
})

route('DELETE', '/api/server/ips/:ip', (ctx) => {
  requireRole(ctx.user!, 'admin')
  const row = db.query<{ vps_id: number | null }, [string]>('SELECT vps_id FROM vps_ips WHERE ip = ?').get(String(ctx.params.ip))
  if (!row) throw new HttpError(404, 'Address not found.', 'not_found')
  if (row.vps_id) throw new HttpError(409, 'That address is in use by a VPS. Release it there first.', 'in_use')
  db.query('DELETE FROM vps_ips WHERE ip = ?').run(String(ctx.params.ip))
  return { ok: true }
})

route('POST', '/api/vps/:id/ips', async (ctx) => {
  const { v, owner } = reach(ctx)
  ready(v)
  const limit = virt.vpsLimits(owner).ipv4
  const used = db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM vps_ips JOIN vps ON vps.id = vps_ips.vps_id WHERE vps.user_id = ?').get(owner.id)!.n
  if (typeof limit === 'number' && used >= limit) throw new HttpError(403, limit ? `Your plan includes ${limit} public IPv4 address(es).` : 'Your plan includes no public IPv4 address.', 'plan_limit')
  const free = db.query<{ ip: string }, []>('SELECT ip FROM vps_ips WHERE vps_id IS NULL ORDER BY ip LIMIT 1').get()
  if (!free) throw new HttpError(503, 'No free public address is left on this server. Ask your provider.', 'no_ip')
  // Claimed first, so two requests cannot take the same address.
  const claimed = db.query('UPDATE vps_ips SET vps_id = ? WHERE ip = ? AND vps_id IS NULL').run(v.id, free.ip)
  if (!claimed.changes) throw new HttpError(409, 'Try again.', 'busy')
  try {
    await agent('vps.ip.attach', { name: v.instance, ip: free.ip }, 180_000)
  } catch (error) {
    db.query('UPDATE vps_ips SET vps_id = NULL WHERE ip = ?').run(free.ip)
    throw error
  }
  log(ctx, owner, 'gave a VPS a public IP', `${v.name}: ${free.ip}`)
  return { ip: free.ip }
})

route('DELETE', '/api/vps/:id/ips/:ip', async (ctx) => {
  const { v, owner } = reach(ctx)
  const row = db.query<{ ip: string }, [string, number]>('SELECT ip FROM vps_ips WHERE ip = ? AND vps_id = ?').get(String(ctx.params.ip), v.id)
  if (!row) throw new HttpError(404, 'Address not found.', 'not_found')
  await agent('vps.ip.detach', { name: v.instance, ip: row.ip })
  db.query('UPDATE vps_ips SET vps_id = NULL WHERE ip = ?').run(row.ip)
  log(ctx, owner, 'released a VPS public IP', `${v.name}: ${row.ip}`)
  return { ok: true }
})
