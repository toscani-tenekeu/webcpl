import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { db, now, planById, type UserRow } from './db.ts'

export const SESSION_COOKIE = 'webcpl_session'
const SESSION_TTL = 7 * 24 * 3600_000
const SESSION_IDLE = 24 * 3600_000

// ---- passwords -------------------------------------------------------------

export const hashPassword = (password: string) => Bun.password.hash(password)
export const hashPasswordSync = (password: string) => Bun.password.hashSync(password)

export async function verifyPassword(password: string, stored: string | null | undefined) {
  if (!stored) return false
  try {
    return await Bun.password.verify(String(password), stored)
  } catch {
    return false
  }
}

// Easy to read aloud and type: no 0/O or 1/l/I.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function generatePassword(length = 20) {
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 256 - (256 % ALPHABET.length)) out += ALPHABET[byte % ALPHABET.length]
      if (out.length === length) break
    }
  }
  return out
}

export const USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/
export const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 10 && p.length <= 200

// ---- sessions --------------------------------------------------------------

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export function createSession(userId: number, ip: string, userAgent: string, impersonatorId: number | null = null) {
  const token = randomBytes(32).toString('base64url')
  const t = now()
  db.query(
    'INSERT INTO sessions(id, user_id, impersonator_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES(?,?,?,?,?,?,?,?)',
  ).run(sha(token), userId, impersonatorId, t, t + SESSION_TTL, t, ip, userAgent.slice(0, 300))
  // Signing in as someone else is not their sign-in.
  if (!impersonatorId) db.query('UPDATE users SET last_login_at = ? WHERE id = ?').run(t, userId)
  return token
}

export function sessionCookie(token: string | null, secure: boolean) {
  const base = `${SESSION_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  return token ? `${base}; Max-Age=${SESSION_TTL / 1000}` : `${base}; Max-Age=0`
}

export const destroySession = (token: string | null) => {
  if (token) db.query('DELETE FROM sessions WHERE id = ?').run(sha(token))
}

export function destroyUserSessions(userId: number, exceptToken?: string | null) {
  if (exceptToken) db.query('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, sha(exceptToken))
  else db.query('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

export interface Session {
  user: UserRow
  /** Set when an admin or reseller is signed in as this account. */
  impersonatorId: number | null
}

export function sessionFor(token: string | null): Session | null {
  if (!token) return null
  const id = sha(token)
  const row = db
    .query<UserRow & { expires_at: number; last_seen_at: number; impersonator_id: number | null }, [string]>(
      'SELECT s.expires_at, s.last_seen_at, s.impersonator_id, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
    )
    .get(id)
  if (!row) return null
  const t = now()
  // A suspended account cannot sign in, but the admin or reseller looking at it can.
  if (row.expires_at < t || row.last_seen_at + SESSION_IDLE < t || (row.suspended && !row.impersonator_id)) {
    db.query('DELETE FROM sessions WHERE id = ?').run(id)
    return null
  }
  if (t - row.last_seen_at > 60_000) db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(t, id)
  const { expires_at: _e, last_seen_at: _l, impersonator_id, ...user } = row
  return { user: user as UserRow, impersonatorId: impersonator_id }
}

// ---- API keys ----------------------------------------------------------------

/** A new key: shown once, stored as a hash. The prefix lets people tell keys apart. */
export function createApiKey(userId: number, name: string) {
  const secret = `wcp_${randomBytes(24).toString('base64url')}`
  db.query('INSERT INTO api_keys(user_id, name, prefix, hash, created_at) VALUES(?,?,?,?,?)').run(
    userId,
    name,
    secret.slice(0, 10),
    sha(secret),
    now(),
  )
  return secret
}

export function apiKeyUser(header: string | null): UserRow | null {
  const match = header?.match(/^Bearer\s+(wcp_[A-Za-z0-9_-]{20,})$/)
  if (!match) return null
  const row = db
    .query<UserRow & { key_id: number }, [string]>(
      'SELECT k.id AS key_id, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.hash = ?',
    )
    .get(sha(match[1]!))
  if (!row || row.suspended) return null
  db.query('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.key_id)
  const { key_id: _k, ...user } = row
  return user as UserRow
}

export function cookieToken(header: string | null) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === SESSION_COOKIE) return decodeURIComponent(value.join('='))
  }
  return null
}

// Unref'd so the CLI, which also loads this module, can exit.
setInterval(() => {
  db.query('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(now(), now() - SESSION_IDLE)
}, 3600_000).unref()

// ---- brute-force protection ------------------------------------------------

const attempts = new Map<string, { start: number; count: number }>()
const WINDOW = 15 * 60_000
const LIMIT = 10

export function isThrottled(...keys: string[]) {
  const t = now()
  return keys.some((key) => {
    const a = attempts.get(key)
    if (!a) return false
    if (t - a.start > WINDOW) {
      attempts.delete(key)
      return false
    }
    return a.count >= LIMIT
  })
}

export function recordFailure(...keys: string[]) {
  const t = now()
  for (const key of keys) {
    const a = attempts.get(key)
    if (!a || t - a.start > WINDOW) attempts.set(key, { start: t, count: 1 })
    else a.count++
  }
}

export const clearFailures = (...keys: string[]) => keys.forEach((key) => attempts.delete(key))

// ---- TOTP (RFC 6238) -------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function newTotpSecret() {
  let bits = ''
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]
  return out
}

function b32decode(text: string) {
  let bits = ''
  for (const c of text.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(c)
    if (v >= 0) bits += v.toString(2).padStart(5, '0')
  }
  const out: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(out)
}

function hotp(key: Buffer, counter: number) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(buf).digest()
  const o = h[h.length - 1]! & 0xf
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
}

export function verifyTotp(secret: string | null, code: unknown) {
  const clean = String(code ?? '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(clean) || !secret) return false
  const key = b32decode(secret)
  const step = Math.floor(Date.now() / 30_000)
  return [-1, 0, 1].some((d) => timingSafeEqual(Buffer.from(hotp(key, step + d)), Buffer.from(clean)))
}

export const totpUri = (secret: string, username: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`

// A short-lived ticket between "password correct" and "code correct".
const tickets = new Map<string, { userId: number; exp: number }>()

export function issueTwoFactorTicket(userId: number) {
  const ticket = randomBytes(24).toString('base64url')
  tickets.set(ticket, { userId, exp: now() + 5 * 60_000 })
  return ticket
}

export function consumeTwoFactorTicket(ticket: string, keep = false) {
  const v = tickets.get(ticket)
  if (!v || v.exp < now()) {
    tickets.delete(ticket)
    return null
  }
  if (!keep) tickets.delete(ticket)
  return v.userId
}

// ---- public user shape -----------------------------------------------------

const planOf = (id: number | null) => {
  const plan = id ? planById(id) : null
  return plan ? { id: plan.id, name: plan.name, limits: JSON.parse(plan.limits) as Record<string, number | boolean | null> } : null
}

export function publicUser(u: UserRow | null) {
  if (!u) return null
  const owner = u.owner_id ? db.query<{ username: string; role: string }, [number]>('SELECT username, role FROM users WHERE id = ?').get(u.owner_id) : null
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    owner: u.owner_id && owner ? { id: u.owner_id, username: owner.username, role: owner.role } : null,
    suspended: !!u.suspended,
    suspendedReason: u.suspended_reason,
    mustChangePassword: !!u.must_change_password,
    totpEnabled: !!u.totp_enabled,
    hostingPlan: planOf(u.hosting_plan_id),
    vpsPlan: planOf(u.vps_plan_id),
    resellerPlan: planOf(u.reseller_plan_id),
    note: u.note,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  }
}
