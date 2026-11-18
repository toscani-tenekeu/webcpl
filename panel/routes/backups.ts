import { agent } from '../agent.ts'
import { requireRole } from '../access.ts'
import * as backups from '../backups.ts'
import { userById } from '../db.ts'
import { HttpError } from '../errors.ts'
import * as hosting from '../hosting.ts'
import { route, type Ctx } from '../http.ts'

const BACKUP = /^[a-z0-9]+-\d{8}-\d{6}(-[a-z]+)?\.tar\.zst$/

function me(ctx: Ctx) {
  const u = userById(ctx.user!.id)!
  hosting.requireHosting(u)
  if (u.suspended && !ctx.impersonatorId) throw new HttpError(403, 'This account is suspended.', 'suspended')
  return u
}

function name(value: unknown, user: string) {
  const text = String(value ?? '')
  if (!BACKUP.test(text) || !text.startsWith(`${user}-`)) throw new HttpError(404, 'Backup not found.', 'not_found')
  return text
}

route('GET', '/api/backups', async (ctx) => {
  const u = me(ctx)
  const settings = backups.backupSettings()
  return {
    backups: await agent<{ name: string; size: number; createdAt: number }[]>('backup.list', { user: u.username }),
    job: backups.jobFor(u),
    schedule: { schedule: settings.schedule, hour: settings.hour, keep: settings.keep, offsite: settings.remote.type !== 'none' },
  }
})

route('POST', '/api/backups', (ctx) => {
  const u = me(ctx)
  backups.startBackup(u, ctx.user!.id, ctx.ip)
  return { ok: true }
})

route('POST', '/api/backups/:name/restore', (ctx) => {
  const u = me(ctx)
  const file = name(ctx.params.name, u.username)
  const parts = { files: ctx.body.files === true, databases: ctx.body.databases === true }
  if (!parts.files && !parts.databases) throw new HttpError(400, 'Choose files, databases or both.', 'nothing')
  backups.startRestore(u, file, parts, ctx.user!.id, ctx.ip)
  return { ok: true }
})

route('GET', '/api/backups/:name/download', async (ctx) => {
  const u = me(ctx)
  const file = name(ctx.params.name, u.username)
  const blob = Bun.file(`/var/backups/webcpl/${u.username}/${file}`)
  if (!(await blob.exists())) throw new HttpError(404, 'Backup not found.', 'not_found')
  return new Response(blob, { headers: { 'Content-Type': 'application/zstd', 'Content-Disposition': `attachment; filename="${file}"` } })
})

route('DELETE', '/api/backups/:name', async (ctx) => {
  const u = me(ctx)
  await agent('backup.delete', { user: u.username, name: name(ctx.params.name, u.username) })
  return { ok: true }
})

// ---- admin --------------------------------------------------------------------------------------------

route('GET', '/api/server/backups', (ctx) => {
  requireRole(ctx.user!, 'admin')
  return { settings: backups.publicSettings() }
})

route('PUT', '/api/server/backups', (ctx) => {
  requireRole(ctx.user!, 'admin')
  backups.saveSettings(ctx.body)
  return { settings: backups.publicSettings() }
})

route('POST', '/api/server/backups/test', async (ctx) => {
  requireRole(ctx.user!, 'admin')
  const remote = backups.backupSettings().remote
  if (remote.type === 'none') throw new HttpError(400, 'Set up off-site storage first.', 'no_remote')
  await agent('backup.remote.test', { remote }, 90_000)
  return { ok: true }
})

route('POST', '/api/server/backups/run', (ctx) => {
  requireRole(ctx.user!, 'admin')
  return { accounts: backups.runAll() }
})
