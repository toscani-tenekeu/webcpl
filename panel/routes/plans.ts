import { cleanLimits, type PlanKind } from '../../shared/limits.ts'
import { isAdmin, requireRole } from '../access.ts'
import { db, logActivity, now, planById, type PlanRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import { route, type Ctx } from '../http.ts'

const KINDS: PlanKind[] = ['hosting', 'vps', 'reseller']

function usedBy(plan: PlanRow) {
  const column = plan.kind === 'hosting' ? 'hosting_plan_id' : plan.kind === 'vps' ? 'vps_plan_id' : 'reseller_plan_id'
  return db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM users WHERE ${column} = ?`).get(plan.id)!.n
}

const publicPlan = (plan: PlanRow) => ({
  id: plan.id,
  kind: plan.kind,
  name: plan.name,
  limits: JSON.parse(plan.limits),
  accounts: usedBy(plan),
  createdAt: plan.created_at,
})

function kindFor(ctx: Ctx, value: unknown): PlanKind {
  const kind = String(value ?? '') as PlanKind
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown plan type.', 'bad_kind')
  // Reseller plans are the admin's: they decide what each reseller may hand out.
  if (kind === 'reseller' && !isAdmin(ctx.user!)) throw new HttpError(403, 'Only the administrator makes reseller plans.', 'forbidden')
  return kind
}

function ownPlan(ctx: Ctx) {
  const plan = planById(Number(ctx.params.id))
  if (!plan || plan.owner_id !== ctx.user!.id) throw new HttpError(404, 'Plan not found.', 'not_found')
  return plan
}

/** The caller's own plans. */
route('GET', '/api/plans', (ctx) => {
  requireRole(ctx.user!, 'admin', 'reseller')
  const kind = ctx.url.searchParams.get('kind')
  const rows = db.query<PlanRow, [number]>('SELECT * FROM plans WHERE owner_id = ? ORDER BY kind, name').all(ctx.user!.id)
  return { plans: rows.filter((p) => !kind || p.kind === kind).map(publicPlan) }
})

route('POST', '/api/plans', (ctx) => {
  requireRole(ctx.user!, 'admin', 'reseller')
  const kind = kindFor(ctx, ctx.body.kind)
  const name = String(ctx.body.name ?? '').trim().slice(0, 60)
  if (!name) throw new HttpError(400, 'Give the plan a name.', 'bad_name')
  const cleaned = cleanLimits(kind, ctx.body.limits)
  if ('error' in cleaned) throw new HttpError(400, cleaned.error, 'bad_limit')
  if (db.query('SELECT 1 FROM plans WHERE owner_id = ? AND kind = ? AND name = ?').get(ctx.user!.id, kind, name)) {
    throw new HttpError(409, 'You already have a plan with that name.', 'taken')
  }
  const result = db
    .query('INSERT INTO plans(owner_id, kind, name, limits, created_at) VALUES(?,?,?,?,?)')
    .run(ctx.user!.id, kind, name, JSON.stringify(cleaned.limits), now())
  logActivity({ actorId: ctx.user!.id, subjectId: ctx.user!.id, action: 'created plan', detail: name, ip: ctx.ip })
  return { plan: publicPlan(planById(Number(result.lastInsertRowid))!) }
})

route('PATCH', '/api/plans/:id', (ctx) => {
  const plan = ownPlan(ctx)
  const name = ctx.body.name === undefined ? plan.name : String(ctx.body.name).trim().slice(0, 60)
  if (!name) throw new HttpError(400, 'Give the plan a name.', 'bad_name')
  const cleaned = ctx.body.limits === undefined ? { limits: JSON.parse(plan.limits) } : cleanLimits(plan.kind, ctx.body.limits)
  if ('error' in cleaned) throw new HttpError(400, cleaned.error, 'bad_limit')
  db.query('UPDATE plans SET name = ?, limits = ? WHERE id = ?').run(name, JSON.stringify(cleaned.limits), plan.id)
  logActivity({ actorId: ctx.user!.id, subjectId: ctx.user!.id, action: 'updated plan', detail: name, ip: ctx.ip })
  return { plan: publicPlan(planById(plan.id)!) }
})

route('DELETE', '/api/plans/:id', (ctx) => {
  const plan = ownPlan(ctx)
  const accounts = usedBy(plan)
  if (accounts) throw new HttpError(409, `${accounts} account(s) use this plan. Move them to another plan first.`, 'in_use')
  db.query('DELETE FROM plans WHERE id = ?').run(plan.id)
  logActivity({ actorId: ctx.user!.id, subjectId: ctx.user!.id, action: 'deleted plan', detail: plan.name, ip: ctx.ip })
  return { ok: true }
})
