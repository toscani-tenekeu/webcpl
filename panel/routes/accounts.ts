import { assertResellerRoom, canManage, isAdmin, managedAccount, planForAccount, requireRole, resellerUsage } from '../access.ts'
import * as auth from '../auth.ts'
import { db, logActivity, now, userById, type UserRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import * as hosting from '../hosting.ts'
import { route, type Ctx } from '../http.ts'

// Account names become Linux user names for hosting, so they follow the same rules.
const USERNAME = /^[a-z][a-z0-9]{2,15}$/
const RESERVED = new Set([
  'admin', 'root', 'webcpl', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'backup',
  'list', 'irc', 'nobody', 'systemd', 'messagebus', 'sshd', 'www', 'wwwdata', 'nginx', 'apache', 'mysql', 'mariadb',
  'postgres', 'redis', 'pdns', 'postfix', 'dovecot', 'rspamd', 'ftp', 'incus', 'lxd', 'syslog', 'ubuntu', 'debian',
  'operator', 'support', 'test', 'user', 'reseller', 'webmail', 'phpmyadmin', 'adminer', 'ns1', 'ns2',
])

function summary(u: UserRow) {
  const pub = auth.publicUser(u)!
  const accounts = u.role === 'reseller' ? db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM users WHERE owner_id = ?').get(u.id)!.n : null
  return { ...pub, accounts }
}

/** The accounts the caller can see: everyone for the admin, its own customers for a reseller. */
route('GET', '/api/accounts', (ctx) => {
  const actor = ctx.user!
  requireRole(actor, 'admin', 'reseller')
  const role = ctx.url.searchParams.get('role')
  const rows = isAdmin(actor)
    ? db.query<UserRow, []>("SELECT * FROM users WHERE role <> 'admin' ORDER BY username").all()
    : db.query<UserRow, [number]>("SELECT * FROM users WHERE owner_id = ? AND role = 'user' ORDER BY username").all(actor.id)
  return { accounts: rows.filter((u) => !role || u.role === role).map(summary) }
})

route('GET', '/api/accounts/:id', (ctx) => {
  const target = managedAccount(ctx.user!, Number(ctx.params.id))
  return {
    account: summary(target),
    usage: target.role === 'reseller' ? resellerUsage(target) : null,
    customers: target.role === 'reseller'
      ? db.query<UserRow, [number]>('SELECT * FROM users WHERE owner_id = ? ORDER BY username').all(target.id).map(summary)
      : null,
  }
})

function plansFrom(ctx: Ctx, ownerId: number, role: UserRow['role']) {
  return {
    hosting: planForAccount(ownerId, ctx.body.hostingPlanId, 'hosting'),
    vps: planForAccount(ownerId, ctx.body.vpsPlanId, 'vps'),
    reseller: role === 'reseller' ? planForAccount(ownerId, ctx.body.resellerPlanId, 'reseller') : null,
  }
}

route('POST', '/api/accounts', async (ctx) => {
  const actor = ctx.user!
  requireRole(actor, 'admin', 'reseller')
  const role = ctx.body.role === 'reseller' ? 'reseller' : 'user'
  // Only the admin creates resellers; a reseller's accounts are always users.
  if (role === 'reseller' && !isAdmin(actor)) throw new HttpError(403, 'Only the administrator can create resellers.', 'forbidden')

  const username = String(ctx.body.username ?? '').trim().toLowerCase()
  if (!USERNAME.test(username)) throw new HttpError(400, 'Usernames are 3 to 16 lowercase letters or digits, starting with a letter.', 'bad_username')
  if (RESERVED.has(username)) throw new HttpError(400, 'That username is reserved by the system.', 'reserved')
  if (db.query('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.', 'taken')
  const email = String(ctx.body.email ?? '').trim()
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'bad_email')

  let password = String(ctx.body.password ?? '')
  if (!password) password = auth.generatePassword(16)
  else if (!auth.validPassword(password)) throw new HttpError(400, 'Use at least 10 characters.', 'weak_password')

  const plans = plansFrom(ctx, actor.id, role)
  if (role === 'reseller' && !plans.reseller) throw new HttpError(400, 'Choose a reseller plan.', 'bad_plan')
  if (role === 'user' && !plans.hosting && !plans.vps) throw new HttpError(400, 'Choose a hosting plan, a VPS plan or both.', 'bad_plan')
  if (actor.role === 'reseller') assertResellerRoom(actor, { adding: true, hostingPlanId: plans.hosting?.id ?? null, vpsPlanId: plans.vps?.id ?? null })

  const result = db
    .query(
      `INSERT INTO users(username, email, password_hash, role, owner_id, hosting_plan_id, vps_plan_id, reseller_plan_id, must_change_password, note, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      username, email, await auth.hashPassword(password), role, actor.id,
      plans.hosting?.id ?? null, plans.vps?.id ?? null, plans.reseller?.id ?? null,
      ctx.body.mustChangePassword === false ? 0 : 1, String(ctx.body.note ?? '').slice(0, 500), now(),
    )
  const id = Number(result.lastInsertRowid)
  // Hosting needs the Linux user at once; if the server refuses, the account is not kept.
  try {
    await hosting.provision(userById(id)!, password)
  } catch (error) {
    db.query('DELETE FROM users WHERE id = ?').run(id)
    throw error
  }
  logActivity({ actorId: actor.id, subjectId: id, action: role === 'reseller' ? 'created reseller' : 'created account', detail: username, ip: ctx.ip })
  return { account: summary(userById(id)!), password }
})

route('PATCH', '/api/accounts/:id', async (ctx) => {
  const actor = ctx.user!
  const target = managedAccount(actor, Number(ctx.params.id))
  const email = ctx.body.email === undefined ? target.email : String(ctx.body.email).trim()
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'bad_email')
  const note = ctx.body.note === undefined ? target.note : String(ctx.body.note).slice(0, 500)

  const owner = target.owner_id!
  const pick = (key: string, kind: 'hosting' | 'vps' | 'reseller', current: number | null) =>
    key in ctx.body ? (planForAccount(owner, ctx.body[key], kind)?.id ?? null) : current
  const hostingId = pick('hostingPlanId', 'hosting', target.hosting_plan_id)
  const vps = pick('vpsPlanId', 'vps', target.vps_plan_id)
  const reseller = target.role === 'reseller' ? pick('resellerPlanId', 'reseller', target.reseller_plan_id) : null
  if (target.role === 'reseller' && !reseller) throw new HttpError(400, 'A reseller needs a reseller plan.', 'bad_plan')
  if (target.role === 'user' && !hostingId && !vps) throw new HttpError(400, 'Keep a hosting plan, a VPS plan or both.', 'bad_plan')

  // The account's reseller (whoever changes it) must stay within its caps.
  const ownerRow = userById(owner)
  if (ownerRow?.role === 'reseller') assertResellerRoom(ownerRow, { accountId: target.id, hostingPlanId: hostingId, vpsPlanId: vps })

  if (target.linux_user && !hostingId) throw new HttpError(409, 'This account has websites on the server. Delete the account to remove its hosting.', 'has_hosting')
  db.query('UPDATE users SET email = ?, note = ?, hosting_plan_id = ?, vps_plan_id = ?, reseller_plan_id = ? WHERE id = ?').run(
    email, note, hostingId, vps, reseller, target.id,
  )
  const updated = userById(target.id)!
  if (updated.linux_user) {
    if (hostingId !== target.hosting_plan_id) await hosting.syncLimits(updated)
  } else {
    await hosting.provision(updated)
  }
  logActivity({ actorId: actor.id, subjectId: target.id, action: 'updated account', detail: target.username, ip: ctx.ip })
  return { account: summary(userById(target.id)!) }
})

route('POST', '/api/accounts/:id/suspend', async (ctx) => {
  const target = managedAccount(ctx.user!, Number(ctx.params.id))
  const reason = String(ctx.body.reason ?? '').trim().slice(0, 200)
  db.query('UPDATE users SET suspended = 1, suspended_reason = ? WHERE id = ?').run(reason, target.id)
  auth.destroyUserSessions(target.id)
  await hosting.suspend(userById(target.id)!)
  // Suspending a reseller suspends its customers' access too.
  if (target.role === 'reseller') {
    for (const customer of db.query<{ id: number }, [number]>('SELECT id FROM users WHERE owner_id = ?').all(target.id)) auth.destroyUserSessions(customer.id)
  }
  logActivity({ actorId: ctx.user!.id, subjectId: target.id, action: 'suspended account', detail: reason || target.username, ip: ctx.ip })
  return { account: summary(userById(target.id)!) }
})

route('POST', '/api/accounts/:id/unsuspend', async (ctx) => {
  const target = managedAccount(ctx.user!, Number(ctx.params.id))
  db.query("UPDATE users SET suspended = 0, suspended_reason = '' WHERE id = ?").run(target.id)
  await hosting.unsuspend(userById(target.id)!)
  logActivity({ actorId: ctx.user!.id, subjectId: target.id, action: 'unsuspended account', detail: target.username, ip: ctx.ip })
  return { account: summary(userById(target.id)!) }
})

route('POST', '/api/accounts/:id/reset-password', async (ctx) => {
  const target = managedAccount(ctx.user!, Number(ctx.params.id))
  const password = auth.generatePassword(16)
  db.query('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await auth.hashPassword(password), target.id)
  await hosting.syncPassword(target, password)
  auth.destroyUserSessions(target.id)
  logActivity({ actorId: ctx.user!.id, subjectId: target.id, action: 'reset password', detail: target.username, ip: ctx.ip })
  return { password }
})

route('POST', '/api/accounts/:id/reset-2fa', (ctx) => {
  const target = managedAccount(ctx.user!, Number(ctx.params.id))
  db.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(target.id)
  logActivity({ actorId: ctx.user!.id, subjectId: target.id, action: 'turned off two-factor sign-in', detail: target.username, ip: ctx.ip })
  return { ok: true }
})

route('DELETE', '/api/accounts/:id', async (ctx) => {
  const target = managedAccount(ctx.user!, Number(ctx.params.id))
  if (String(ctx.body.confirm ?? '') !== target.username) throw new HttpError(400, 'Type the username to confirm.', 'confirm')
  const customers = db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM users WHERE owner_id = ?').get(target.id)!.n
  if (customers) throw new HttpError(409, `This reseller still has ${customers} account(s). Delete or move them first.`, 'has_accounts')
  await hosting.deprovision(target)
  db.query('DELETE FROM plans WHERE owner_id = ?').run(target.id)
  db.query('DELETE FROM users WHERE id = ?').run(target.id)
  logActivity({ actorId: ctx.user!.id, action: 'deleted account', detail: target.username, ip: ctx.ip })
  return { ok: true }
})

/** "Log in as": the caller's session is replaced by one for the account, marked with who started it. */
route('POST', '/api/accounts/:id/login-as', (ctx) => {
  const actor = ctx.user!
  if (ctx.viaApiKey) throw new HttpError(403, 'Not available with an API key.', 'forbidden')
  if (ctx.impersonatorId) throw new HttpError(400, 'Go back to your own account first.', 'nested')
  const target = managedAccount(actor, Number(ctx.params.id))
  if (!canManage(actor, target)) throw new HttpError(404, 'Account not found.', 'not_found')
  auth.destroySession(ctx.token)
  const token = auth.createSession(target.id, ctx.ip, ctx.req.headers.get('user-agent') ?? '', actor.id)
  ctx.headers.append('Set-Cookie', auth.sessionCookie(token, ctx.secure))
  logActivity({ actorId: actor.id, subjectId: target.id, action: 'signed in as', detail: target.username, ip: ctx.ip })
  return { ok: true }
})
