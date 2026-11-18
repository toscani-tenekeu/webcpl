import { agent } from '../agent.ts'
import { db, logActivity, now, userById, type UserRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import * as hosting from '../hosting.ts'
import { route, type Ctx } from '../http.ts'

const KEY = /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/

function me(ctx: Ctx) {
  const u = userById(ctx.user!.id)!
  hosting.requireHosting(u)
  if (u.suspended && !ctx.impersonatorId) throw new HttpError(403, 'This account is suspended.', 'suspended')
  return u
}

const list = (u: UserRow) => db.query<{ id: number; name: string; key: string; created_at: number }, [number]>('SELECT * FROM ssh_keys WHERE user_id = ? ORDER BY id').all(u.id)
const write = (u: UserRow) => agent('account.sshkeys', { user: u.username, keys: list(u).map((k) => k.key) })
const publicKey = (k: { id: number; name: string; key: string; created_at: number }) => ({
  id: k.id, name: k.name, type: k.key.split(' ')[0], fingerprint: `${k.key.split(' ')[1]!.slice(0, 12)}…${k.key.split(' ')[1]!.slice(-12)}`, createdAt: k.created_at,
})

route('GET', '/api/ssh-keys', (ctx) => ({ keys: list(me(ctx)).map(publicKey) }))

route('POST', '/api/ssh-keys', async (ctx) => {
  const u = me(ctx)
  const key = String(ctx.body.key ?? '').trim().replace(/\s+/g, ' ')
  if (!KEY.test(key)) throw new HttpError(400, 'Paste a public key that starts with ssh-ed25519, ssh-rsa or ecdsa-sha2.', 'bad_key')
  if (list(u).length >= 20) throw new HttpError(400, 'Up to 20 keys per account.', 'too_many')
  if (list(u).some((k) => k.key.split(' ')[1] === key.split(' ')[1])) throw new HttpError(409, 'That key is already added.', 'taken')
  const name = String(ctx.body.name ?? '').trim().slice(0, 60) || key.split(' ')[2] || key.split(' ')[0]!
  const id = Number(db.query('INSERT INTO ssh_keys(user_id, name, key, created_at) VALUES(?,?,?,?)').run(u.id, name, key, now()).lastInsertRowid)
  try {
    await write(u)
  } catch (error) {
    db.query('DELETE FROM ssh_keys WHERE id = ?').run(id)
    throw error
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'added an SSH key', detail: name, ip: ctx.ip })
  return { keys: list(u).map(publicKey) }
})

route('DELETE', '/api/ssh-keys/:id', async (ctx) => {
  const u = me(ctx)
  const row = db.query<{ id: number; name: string }, [number, number]>('SELECT id, name FROM ssh_keys WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), u.id)
  if (!row) throw new HttpError(404, 'Key not found.', 'not_found')
  db.query('DELETE FROM ssh_keys WHERE id = ?').run(row.id)
  await write(u)
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'removed an SSH key', detail: row.name, ip: ctx.ip })
  return { keys: list(u).map(publicKey) }
})
