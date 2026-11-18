import { agent } from '../agent.ts'
import { db, getSetting, logActivity, now, userById, type DomainRow, type UserRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import * as hosting from '../hosting.ts'
import { route, type Ctx } from '../http.ts'
import { type Autoreply, ensureMailRecords, hashMailPassword, requireMail, syncMail, writeSieve } from '../mail.ts'

function me(ctx: Ctx) {
  const u = userById(ctx.user!.id)!
  hosting.requireHosting(u)
  if (u.suspended && !ctx.impersonatorId) throw new HttpError(403, 'This account is suspended.', 'suspended')
  return u
}

const LOCAL = /^[a-z0-9][a-z0-9._+-]{0,63}$/

function topDomain(u: UserRow, id: unknown) {
  const d = db.query<DomainRow, [number, number]>('SELECT * FROM domains WHERE id = ? AND user_id = ? AND parent_id IS NULL').get(Number(id), u.id)
  if (!d) throw new HttpError(404, 'Domain not found.', 'not_found')
  return d
}

function checkPassword(value: unknown) {
  const password = String(value ?? '')
  if (password.length < 10 || password.length > 200) throw new HttpError(400, 'Use at least 10 characters.', 'weak_password')
  return password
}

function checkQuota(u: UserRow, value: unknown) {
  const quota = Number(value ?? 0)
  if (!Number.isInteger(quota) || quota < 0) throw new HttpError(400, 'The quota must be a whole number of MB.', 'bad_quota')
  const disk = hosting.hostingLimits(u).disk_mb
  if (typeof disk === 'number' && quota > disk) throw new HttpError(400, 'The quota cannot be larger than your disk space.', 'bad_quota')
  return quota
}

function cleanAutoreply(value: unknown): Autoreply | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const date = (v: unknown) => {
    const text = String(v ?? '').trim()
    if (!text) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, 'Dates look like 2026-12-24.', 'bad_date')
    return text
  }
  const subject = String(r.subject ?? '').trim().slice(0, 200)
  const message = String(r.message ?? '').replace(/\r/g, '').trim()
  if (message.length > 4000) throw new HttpError(400, 'Keep the reply under 4000 characters.', 'too_long')
  const reply = { enabled: r.enabled === true, subject, message, start: date(r.start), end: date(r.end) }
  if (reply.enabled && !message) throw new HttpError(400, 'Write the reply first.', 'no_message')
  if (reply.start && reply.end && reply.start > reply.end) throw new HttpError(400, 'The end date comes before the start date.', 'bad_date')
  return reply
}

route('GET', '/api/mail', async (ctx) => {
  const u = me(ctx)
  await requireMail()
  const domains = db.query<{ id: number; name: string }, [number]>('SELECT id, name FROM domains WHERE user_id = ? AND parent_id IS NULL ORDER BY name').all(u.id)
  const boxes = db.query<{ id: number; domain_id: number; address: string; quota_mb: number; autoreply: string | null; spam_to_junk: number; created_at: number }, [number]>(
    'SELECT id, domain_id, address, quota_mb, autoreply, spam_to_junk, created_at FROM mailboxes WHERE user_id = ? ORDER BY address').all(u.id)
  const used = boxes.length ? await agent<Record<string, number>>('mail.usage', { addresses: boxes.map((b) => b.address) }).catch(() => ({} as Record<string, number>)) : {}
  const forwarders = db.query<{ id: number; domain_id: number; source: string; destinations: string }, [number]>(
    'SELECT id, domain_id, source, destinations FROM forwarders WHERE user_id = ? ORDER BY source').all(u.id)
  const host = getSetting('hostname') || (await hosting.publicAddress())
  return {
    domains,
    mailboxes: boxes.map((b) => ({
      id: b.id, domainId: b.domain_id, address: b.address, quotaMb: b.quota_mb, usedBytes: used[b.address] ?? 0,
      autoreply: b.autoreply ? (JSON.parse(b.autoreply) as Autoreply) : null, spamToJunk: !!b.spam_to_junk, createdAt: b.created_at,
    })),
    forwarders: forwarders.map((f) => ({ id: f.id, domainId: f.domain_id, source: f.source, destinations: JSON.parse(f.destinations) as string[] })),
    limit: hosting.hostingLimits(u).mailboxes ?? null,
    settings: { host, imap: 993, pop3: 995, smtp: 465, submission: 587 },
    webmail: `http://${await hosting.publicAddress()}/webmail/`,
  }
})

route('POST', '/api/mail/mailboxes', async (ctx) => {
  const u = me(ctx)
  await requireMail()
  const d = topDomain(u, ctx.body.domainId)
  const local = String(ctx.body.local ?? '').trim().toLowerCase()
  if (!LOCAL.test(local)) throw new HttpError(400, 'Use letters, digits, dots, dashes, plus or underscores before the @.', 'bad_local')
  const address = `${local}@${d.name}`
  if (db.query('SELECT 1 FROM mailboxes WHERE address = ?').get(address) || db.query('SELECT 1 FROM forwarders WHERE source = ?').get(address)) {
    throw new HttpError(409, 'That address already exists.', 'taken')
  }
  const limit = hosting.hostingLimits(u).mailboxes
  const count = db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?').get(u.id)!.n
  if (typeof limit === 'number' && count >= limit) throw new HttpError(403, `Your plan allows ${limit} mailboxes.`, 'plan_limit')
  const hash = await hashMailPassword(checkPassword(ctx.body.password))
  const quota = checkQuota(u, ctx.body.quotaMb ?? 1024)
  await ensureMailRecords(d.name).catch(() => null)
  const id = Number(db.query('INSERT INTO mailboxes(user_id, domain_id, address, password_hash, quota_mb, created_at) VALUES(?,?,?,?,?,?)').run(u.id, d.id, address, hash, quota, now()).lastInsertRowid)
  try {
    await syncMail()
  } catch (error) {
    db.query('DELETE FROM mailboxes WHERE id = ?').run(id)
    throw error
  }
  await writeSieve(u.username, address, true, null).catch(() => null)
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'created mailbox', detail: address, ip: ctx.ip })
  return { mailbox: { id, address } }
})

route('PATCH', '/api/mail/mailboxes/:id', async (ctx) => {
  const u = me(ctx)
  const box = db.query<{ id: number; address: string; autoreply: string | null; spam_to_junk: number }, [number, number]>(
    'SELECT id, address, autoreply, spam_to_junk FROM mailboxes WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), u.id)
  if (!box) throw new HttpError(404, 'Mailbox not found.', 'not_found')
  if (ctx.body.autoreply !== undefined || ctx.body.spamToJunk !== undefined) {
    const reply = ctx.body.autoreply === undefined ? (box.autoreply ? JSON.parse(box.autoreply) as Autoreply : null) : cleanAutoreply(ctx.body.autoreply)
    const spam = ctx.body.spamToJunk === undefined ? !!box.spam_to_junk : ctx.body.spamToJunk === true
    await writeSieve(u.username, box.address, spam, reply)
    db.query('UPDATE mailboxes SET autoreply = ?, spam_to_junk = ? WHERE id = ?').run(reply ? JSON.stringify(reply) : null, spam ? 1 : 0, box.id)
  }
  if (ctx.body.password !== undefined) db.query('UPDATE mailboxes SET password_hash = ? WHERE id = ?').run(await hashMailPassword(checkPassword(ctx.body.password)), box.id)
  if (ctx.body.quotaMb !== undefined) db.query('UPDATE mailboxes SET quota_mb = ? WHERE id = ?').run(checkQuota(u, ctx.body.quotaMb), box.id)
  await syncMail()
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'updated mailbox', detail: box.address, ip: ctx.ip })
  return { ok: true }
})

route('DELETE', '/api/mail/mailboxes/:id', async (ctx) => {
  const u = me(ctx)
  const box = db.query<{ id: number; address: string }, [number, number]>('SELECT id, address FROM mailboxes WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), u.id)
  if (!box) throw new HttpError(404, 'Mailbox not found.', 'not_found')
  if (String(ctx.body.confirm ?? '') !== box.address) throw new HttpError(400, 'Type the address to confirm.', 'confirm')
  db.query('DELETE FROM mailboxes WHERE id = ?').run(box.id)
  await syncMail()
  await agent('mail.purge', { user: u.username, address: box.address })
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'deleted mailbox', detail: box.address, ip: ctx.ip })
  return { ok: true }
})

route('POST', '/api/mail/forwarders', async (ctx) => {
  const u = me(ctx)
  await requireMail()
  const d = topDomain(u, ctx.body.domainId)
  const local = String(ctx.body.local ?? '').trim().toLowerCase()
  // An empty name catches every address of the domain that has no mailbox.
  if (local !== '' && local !== '*' && !LOCAL.test(local)) throw new HttpError(400, 'Use letters, digits, dots, dashes, plus or underscores before the @.', 'bad_local')
  const source = `${local === '*' ? '' : local}@${d.name}`
  if (db.query('SELECT 1 FROM forwarders WHERE source = ?').get(source)) throw new HttpError(409, 'That address already forwards. Edit it instead.', 'taken')
  const destinations = [...new Set(String(ctx.body.destinations ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))]
  if (!destinations.length || destinations.length > 50 || destinations.some((x) => !/^[^\s@,:]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/.test(x))) {
    throw new HttpError(400, 'Give one or more valid addresses to forward to.', 'bad_destination')
  }
  if (destinations.includes(source)) throw new HttpError(400, 'An address cannot forward to itself.', 'bad_destination')
  const id = Number(db.query('INSERT INTO forwarders(user_id, domain_id, source, destinations, created_at) VALUES(?,?,?,?,?)').run(u.id, d.id, source, JSON.stringify(destinations), now()).lastInsertRowid)
  try {
    await syncMail()
  } catch (error) {
    db.query('DELETE FROM forwarders WHERE id = ?').run(id)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'created forwarder', detail: source, ip: ctx.ip })
  return { ok: true }
})

route('DELETE', '/api/mail/forwarders/:id', async (ctx) => {
  const u = me(ctx)
  const row = db.query<{ id: number; source: string }, [number, number]>('SELECT id, source FROM forwarders WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), u.id)
  if (!row) throw new HttpError(404, 'Forwarder not found.', 'not_found')
  db.query('DELETE FROM forwarders WHERE id = ?').run(row.id)
  await syncMail()
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'deleted forwarder', detail: row.source, ip: ctx.ip })
  return { ok: true }
})
