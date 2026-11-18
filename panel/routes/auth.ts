import os from 'node:os'
import * as auth from '../auth.ts'
import { version } from '../config.ts'
import { db, getSetting, logActivity, userById, type UserRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import { syncPassword } from '../hosting.ts'
import { route, type Ctx } from '../http.ts'

const DUMMY_HASH = auth.hashPasswordSync('not-a-real-password')

function me(ctx: Ctx, user: UserRow | null) {
  const impersonator = ctx.impersonatorId ? userById(ctx.impersonatorId) : null
  return {
    user: auth.publicUser(user),
    impersonator: impersonator ? { id: impersonator.id, username: impersonator.username, role: impersonator.role } : null,
    panelName: getSetting('panel_name', 'Webcpl'),
    version,
  }
}

function startSession(ctx: Ctx, user: UserRow, impersonatorId: number | null = null) {
  const token = auth.createSession(user.id, ctx.ip, ctx.req.headers.get('user-agent') ?? '', impersonatorId)
  ctx.headers.append('Set-Cookie', auth.sessionCookie(token, ctx.secure))
  ctx.impersonatorId = impersonatorId
}

// ---- signing in ------------------------------------------------------------------

route('GET', '/api/auth/me', (ctx) => me(ctx, ctx.user), 'open')

route('POST', '/api/auth/login', async (ctx) => {
  const username = String(ctx.body.username ?? '').trim().toLowerCase()
  const password = String(ctx.body.password ?? '')
  if (auth.isThrottled(`ip:${ctx.ip}`, `u:${username}`)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.', 'throttled')
  const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE username = ?').get(username)
  const ok = await auth.verifyPassword(password, user?.password_hash ?? DUMMY_HASH)
  if (!user || !ok) {
    auth.recordFailure(`ip:${ctx.ip}`, `u:${username}`)
    throw new HttpError(401, 'Wrong username or password.', 'bad_credentials')
  }
  if (user.suspended) throw new HttpError(403, user.suspended_reason ? `This account is suspended: ${user.suspended_reason}` : 'This account is suspended.', 'suspended')
  if (user.totp_enabled) return { twoFactor: true, ticket: auth.issueTwoFactorTicket(user.id) }
  auth.clearFailures(`u:${username}`)
  startSession(ctx, user)
  logActivity({ actorId: user.id, subjectId: user.id, action: 'signed in', ip: ctx.ip })
  return me(ctx, user)
}, 'open')

route('POST', '/api/auth/2fa', (ctx) => {
  if (auth.isThrottled(`ip:${ctx.ip}`)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.', 'throttled')
  const ticket = String(ctx.body.ticket ?? '')
  const userId = auth.consumeTwoFactorTicket(ticket, true)
  if (!userId) throw new HttpError(401, 'Your sign-in expired. Start again.', 'ticket_expired')
  const user = userById(userId)!
  if (!auth.verifyTotp(user.totp_secret, ctx.body.code)) {
    auth.recordFailure(`ip:${ctx.ip}`, `u:${user.username}`)
    throw new HttpError(401, 'That code is not valid.', 'bad_code')
  }
  auth.consumeTwoFactorTicket(ticket)
  startSession(ctx, user)
  logActivity({ actorId: user.id, subjectId: user.id, action: 'signed in', detail: 'with two-factor code', ip: ctx.ip })
  return me(ctx, user)
}, 'open')

route('POST', '/api/auth/logout', (ctx) => {
  auth.destroySession(ctx.token)
  ctx.headers.append('Set-Cookie', auth.sessionCookie(null, ctx.secure))
  return { ok: true }
}, 'open')

/** Ends "log in as" and goes back to the admin or reseller who started it. */
route('POST', '/api/auth/return', (ctx) => {
  if (!ctx.impersonatorId) throw new HttpError(400, 'You are not signed in as someone else.', 'not_impersonating')
  const back = userById(ctx.impersonatorId)
  if (!back) throw new HttpError(401, 'Please sign in.', 'auth')
  auth.destroySession(ctx.token)
  startSession(ctx, back)
  ctx.impersonatorId = null
  return me(ctx, back)
})

// ---- the signed-in account ------------------------------------------------------------

route('PATCH', '/api/account', (ctx) => {
  const email = String(ctx.body.email ?? '').trim()
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'bad_email')
  db.query('UPDATE users SET email = ? WHERE id = ?').run(email, ctx.user!.id)
  return { user: auth.publicUser(userById(ctx.user!.id)!) }
})

route('POST', '/api/account/password', async (ctx) => {
  const user = ctx.user!
  if (ctx.impersonatorId) throw new HttpError(403, 'Use “Reset password” on the account instead.', 'impersonating')
  if (!(await auth.verifyPassword(String(ctx.body.current ?? ''), user.password_hash))) {
    throw new HttpError(401, 'Your current password is not correct.', 'bad_current')
  }
  if (!auth.validPassword(ctx.body.password)) throw new HttpError(400, 'Use at least 10 characters.', 'weak_password')
  db.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await auth.hashPassword(ctx.body.password), user.id)
  await syncPassword(user, ctx.body.password)
  auth.destroyUserSessions(user.id, ctx.token)
  logActivity({ actorId: user.id, subjectId: user.id, action: 'changed password', ip: ctx.ip })
  return { ok: true }
})

route('POST', '/api/account/2fa/setup', (ctx) => {
  const user = ctx.user!
  if (user.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on.', 'already')
  const secret = auth.newTotpSecret()
  db.query('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, user.id)
  return { secret, uri: auth.totpUri(secret, user.username, `${getSetting('panel_name', 'Webcpl')} (${os.hostname()})`) }
})

route('POST', '/api/account/2fa/enable', (ctx) => {
  const user = ctx.user!
  if (!user.totp_secret || !auth.verifyTotp(user.totp_secret, ctx.body.code)) {
    throw new HttpError(400, 'That code is not valid. Check the time on your phone.', 'bad_code')
  }
  db.query('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id)
  logActivity({ actorId: user.id, subjectId: user.id, action: 'turned on two-factor sign-in', ip: ctx.ip })
  return { ok: true }
})

route('POST', '/api/account/2fa/disable', async (ctx) => {
  const user = ctx.user!
  if (!(await auth.verifyPassword(String(ctx.body.password ?? ''), user.password_hash))) throw new HttpError(401, 'Your password is not correct.', 'bad_current')
  if (!auth.verifyTotp(user.totp_secret, ctx.body.code)) throw new HttpError(400, 'That code is not valid.', 'bad_code')
  db.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id)
  logActivity({ actorId: user.id, subjectId: user.id, action: 'turned off two-factor sign-in', ip: ctx.ip })
  return { ok: true }
})

route('POST', '/api/account/sessions/revoke', (ctx) => {
  auth.destroyUserSessions(ctx.user!.id, ctx.token)
  return { ok: true }
})

// ---- API keys ----------------------------------------------------------------------------

route('GET', '/api/account/api-keys', (ctx) => ({
  keys: db
    .query<{ id: number; name: string; prefix: string; created_at: number; last_used_at: number | null }, [number]>(
      'SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
    )
    .all(ctx.user!.id)
    .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at })),
}))

route('POST', '/api/account/api-keys', (ctx) => {
  if (ctx.viaApiKey) throw new HttpError(403, 'API keys cannot create other API keys.', 'forbidden')
  const name = String(ctx.body.name ?? '').trim().slice(0, 60)
  if (!name) throw new HttpError(400, 'Give the key a name, like “billing”.', 'bad_name')
  const key = auth.createApiKey(ctx.user!.id, name)
  logActivity({ actorId: ctx.user!.id, subjectId: ctx.user!.id, action: 'created an API key', detail: name, ip: ctx.ip })
  return { key }
})

route('DELETE', '/api/account/api-keys/:id', (ctx) => {
  const result = db.query('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), ctx.user!.id)
  if (!result.changes) throw new HttpError(404, 'Key not found.', 'not_found')
  logActivity({ actorId: ctx.user!.id, subjectId: ctx.user!.id, action: 'deleted an API key', ip: ctx.ip })
  return { ok: true }
})
