// Who can see and change what. Every route goes through these checks.
//
//   admin    → every account and every plan it owns
//   reseller → the user accounts it created, and its own plans
//   user     → itself only
import { LIMITS, type Limits } from '../shared/limits.ts'
import { db, planById, type PlanRow, type UserRow } from './db.ts'
import { HttpError } from './errors.ts'

export const isAdmin = (u: UserRow) => u.role === 'admin'
export const isReseller = (u: UserRow) => u.role === 'reseller'

/** Can `actor` manage `target` (edit, suspend, delete, sign in as)? Nobody manages themselves this way. */
export function canManage(actor: UserRow, target: UserRow) {
  if (actor.id === target.id || target.role === 'admin') return false
  if (isAdmin(actor)) return true
  return isReseller(actor) && target.owner_id === actor.id && target.role === 'user'
}

export function managedAccount(actor: UserRow, id: number) {
  const target = db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(id)
  // A 404 either way, so nobody can probe for accounts they cannot see.
  if (!target || !canManage(actor, target)) throw new HttpError(404, 'Account not found.', 'not_found')
  return target
}

export function requireRole(actor: UserRow, ...roles: UserRow['role'][]) {
  if (!roles.includes(actor.role)) throw new HttpError(404, 'Not found.', 'not_found')
}

/** Plans an account may be given: those of its owner (the admin or its reseller). */
export function planForAccount(ownerId: number, id: unknown, kind: PlanRow['kind']): PlanRow | null {
  if (id === null || id === undefined || id === '') return null
  const plan = planById(Number(id))
  if (!plan || plan.kind !== kind) throw new HttpError(400, 'That plan does not exist.', 'bad_plan')
  const owner = db.query<{ role: string }, [number]>('SELECT role FROM users WHERE id = ?').get(ownerId)
  // Reseller plans always come from the admin; hosting and VPS plans from the account's owner.
  const allowed = kind === 'reseller' ? owner?.role === 'admin' || isAdminId(plan.owner_id) : plan.owner_id === ownerId
  if (!allowed) throw new HttpError(400, 'That plan does not belong to this account’s owner.', 'bad_plan')
  return plan
}

const isAdminId = (id: number) => db.query<{ role: string }, [number]>('SELECT role FROM users WHERE id = ?').get(id)?.role === 'admin'

export const parseLimits = (plan: PlanRow | null | undefined): Limits => (plan ? JSON.parse(plan.limits) : {})

/** What a reseller has handed out to its accounts, against the caps of its reseller plan. */
export function resellerUsage(reseller: UserRow, change?: { accountId?: number; hostingPlanId?: number | null; vpsPlanId?: number | null; adding?: boolean }) {
  const caps = parseLimits(planById(reseller.reseller_plan_id ?? 0))
  const accounts = db
    .query<{ id: number; hosting_plan_id: number | null; vps_plan_id: number | null }, [number]>(
      "SELECT id, hosting_plan_id, vps_plan_id FROM users WHERE owner_id = ? AND role = 'user'",
    )
    .all(reseller.id)
    .map((account) =>
      account.id === change?.accountId ? { ...account, hosting_plan_id: change.hostingPlanId ?? null, vps_plan_id: change.vpsPlanId ?? null } : account,
    )
  if (change?.adding) accounts.push({ id: 0, hosting_plan_id: change.hostingPlanId ?? null, vps_plan_id: change.vpsPlanId ?? null })

  const used: Record<string, number> = { users: accounts.length }
  for (const field of LIMITS.reseller) {
    if (!field.sums) continue
    used[field.key] = accounts.reduce((total, account) => {
      const planId = field.sums!.kind === 'hosting' ? account.hosting_plan_id : account.vps_plan_id
      if (!planId) return total
      const value = parseLimits(planById(planId))[field.sums!.key]
      // An unlimited plan uses an unlimited share.
      return total + (value === null || value === undefined ? Infinity : Number(value))
    }, 0)
  }
  return { caps, used }
}

/** Refuses a change that would take a reseller over its caps (only the account count when overselling is allowed). */
export function assertResellerRoom(reseller: UserRow, change: Parameters<typeof resellerUsage>[1]) {
  const { caps, used } = resellerUsage(reseller, change)
  for (const field of LIMITS.reseller) {
    if (field.type !== 'number') continue
    if (field.key !== 'users' && caps.oversell === true) continue
    const cap = caps[field.key]
    if (cap === null || cap === undefined) continue
    if ((used[field.key] ?? 0) > Number(cap)) {
      throw new HttpError(
        400,
        used[field.key] === Infinity
          ? `${field.label}: your plan has a limit, so accounts cannot get an unlimited plan.`
          : `${field.label}: this would use ${used[field.key]} of the ${cap} your plan allows.`,
        'reseller_limit',
      )
    }
  }
}
