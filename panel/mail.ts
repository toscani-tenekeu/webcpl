// Mail for hosting accounts: the panel keeps mailboxes and forwarders, and sends the whole
// picture to the agent after each change.
import { agent } from './agent.ts'
import { db, type UserRow } from './db.ts'
import { HttpError } from './errors.ts'
import { serverInfo } from './hosting.ts'

export const hashMailPassword = (password: string) => Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })

export async function mailInstalled() {
  return !!(await serverInfo()).components.mail
}

export async function requireMail() {
  if (!(await mailInstalled())) throw new HttpError(404, 'Mail is not installed on this server.', 'no_mail')
}

/** Rewrites the server's mail maps from the database. */
export async function syncMail() {
  if (!(await mailInstalled())) return
  const domains = db.query<{ name: string }, []>(
    "SELECT d.name FROM domains d JOIN users u ON u.id = d.user_id WHERE d.parent_id IS NULL AND u.linux_user = 1").all().map((d) => d.name)
  const mailboxes = db.query<{ address: string; password_hash: string; quota_mb: number; username: string; suspended: number }, []>(
    'SELECT m.address, m.password_hash, m.quota_mb, u.username, u.suspended FROM mailboxes m JOIN users u ON u.id = m.user_id').all()
  const forwarders = db.query<{ source: string; destinations: string }, []>('SELECT source, destinations FROM forwarders').all()
  await agent('mail.write', {
    domains,
    mailboxes: mailboxes.map((m) => ({ address: m.address, hash: m.password_hash, user: m.username, quotaMb: m.quota_mb, enabled: !m.suspended })),
    aliases: forwarders.map((f) => ({ source: f.source, destinations: JSON.parse(f.destinations) })),
  }, 120_000)
}

/** DKIM and DMARC records for a domain, when the server has DNS and mail. */
export async function mailRecords(zone: string) {
  if (!(await mailInstalled())) return []
  const dkim = await agent<{ selector: string; record: string }>('mail.dkim', { domain: zone })
  // TXT strings are limited to 255 characters: split the key into several.
  const chunks = dkim.record.match(/.{1,250}/g) ?? []
  return [
    { name: `${dkim.selector}._domainkey.${zone}.`, type: 'TXT', ttl: 3600, records: [chunks.map((c) => `"${c}"`).join(' ')] },
    { name: `_dmarc.${zone}.`, type: 'TXT', ttl: 3600, records: ['"v=DMARC1; p=none"'] },
  ]
}

/** Adds the records to an existing zone (domains created before mail was set up). */
export async function ensureMailRecords(zone: string) {
  if (!(await serverInfo()).components.dns) return
  const existing = await agent<{ rrsets: { name: string; type: string }[] }>('dns.zone.get', { zone }).catch(() => null)
  if (!existing || existing.rrsets.some((r) => r.name.startsWith('webcpl._domainkey.'))) return
  await agent('dns.rrsets.set', { zone, rrsets: await mailRecords(zone) })
}

export async function removeDomainMail(u: UserRow, zone: string) {
  for (const m of db.query<{ address: string }, [number, string]>('SELECT address FROM mailboxes WHERE user_id = ? AND address LIKE ?').all(u.id, `%@${zone}`)) {
    await agent('mail.purge', { user: u.username, address: m.address }).catch(() => null)
  }
  if (await mailInstalled()) await agent('mail.dkim.delete', { domain: zone }).catch(() => null)
}
