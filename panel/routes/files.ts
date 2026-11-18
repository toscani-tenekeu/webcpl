import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { agent } from '../agent.ts'
import { config } from '../config.ts'
import { logActivity, userById, type UserRow } from '../db.ts'
import { HttpError } from '../errors.ts'
import { hostingLimits, requireHosting } from '../hosting.ts'
import { route, type Ctx } from '../http.ts'

const UPLOADS = join(config.dataDir, 'uploads')
mkdirSync(UPLOADS, { recursive: true, mode: 0o700 })
const MAX_UPLOAD = 256 * 1024 * 1024

function me(ctx: Ctx) {
  const u = userById(ctx.user!.id)!
  requireHosting(u)
  if (u.suspended && !ctx.impersonatorId) throw new HttpError(403, 'This account is suspended.', 'suspended')
  return u
}

/** The last measured disk use against the plan: writes stop once it is full. */
function assertRoom(u: UserRow, adding = 0) {
  const limit = hostingLimits(u).disk_mb
  if (limit === null || limit === undefined || u.disk_used === null) return
  if (u.disk_used + adding > Number(limit) * 1024 * 1024) throw new HttpError(507, 'Your disk space is full. Delete some files or ask for a larger plan.', 'disk_full')
}

const op = (name: string) => async (ctx: Ctx) => {
  const u = me(ctx)
  return agent(`files.${name}`, { ...ctx.body, user: u.username }, 900_000)
}

route('GET', '/api/files', async (ctx) => {
  const u = me(ctx)
  return agent('files.list', { user: u.username, path: ctx.url.searchParams.get('path') ?? '/' })
})

route('GET', '/api/files/content', async (ctx) => {
  const u = me(ctx)
  return agent('files.read', { user: u.username, path: ctx.url.searchParams.get('path') ?? '' })
})

route('PUT', '/api/files/content', async (ctx) => {
  const u = me(ctx)
  assertRoom(u, String(ctx.body.content ?? '').length)
  const result = await agent('files.write', { user: u.username, path: ctx.body.path, content: ctx.body.content })
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'edited file', detail: String(ctx.body.path ?? ''), ip: ctx.ip })
  return result
})

route('POST', '/api/files/mkdir', op('mkdir'))
route('POST', '/api/files/create', op('create'))
route('POST', '/api/files/rename', op('rename'))
route('POST', '/api/files/copy', async (ctx) => {
  assertRoom(me(ctx))
  return op('copy')(ctx)
})
route('POST', '/api/files/chmod', op('chmod'))
route('POST', '/api/files/extract', async (ctx) => {
  assertRoom(me(ctx))
  return op('extract')(ctx)
})
route('POST', '/api/files/compress', async (ctx) => {
  assertRoom(me(ctx))
  return op('compress')(ctx)
})
route('POST', '/api/files/delete', async (ctx) => {
  const u = me(ctx)
  const result = await agent('files.delete', { user: u.username, paths: ctx.body.paths }, 900_000)
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'deleted files', detail: ((ctx.body.paths ?? []) as string[]).slice(0, 3).join(', '), ip: ctx.ip })
  return result
})

/** Multipart upload: the panel stores the file, then the agent moves it into the account as its user. */
route('POST', '/api/files/upload', async (ctx) => {
  const u = me(ctx)
  const length = Number(ctx.req.headers.get('content-length') || 0)
  if (length > MAX_UPLOAD) throw new HttpError(413, 'Upload files of up to 256 MB here; use SFTP for larger ones.', 'too_large')
  assertRoom(u, length)
  const form = await ctx.req.formData()
  const path = String(form.get('path') ?? '/')
  const files = form.getAll('file').filter((f) => typeof f !== 'string') as unknown as (Blob & { name: string })[]
  if (!files.length) throw new HttpError(400, 'No file was sent.', 'no_file')
  for (const file of files) {
    const staged = randomBytes(24).toString('base64url')
    await Bun.write(join(UPLOADS, staged), file)
    try {
      await agent('files.upload', { user: u.username, path, name: file.name, staged }, 900_000)
    } finally {
      rmSync(join(UPLOADS, staged), { force: true })
    }
  }
  logActivity({ actorId: ctx.user!.id, subjectId: u.id, action: 'uploaded files', detail: files.map((f) => f.name).slice(0, 3).join(', '), ip: ctx.ip })
  return { ok: true, count: files.length }
}, 'signed-in', { raw: true })

route('GET', '/api/files/download', async (ctx) => {
  const u = me(ctx)
  const result = await agent<{ name: string; base64: string }>('files.download', { user: u.username, path: ctx.url.searchParams.get('path') ?? '' }, 300_000)
  return new Response(Buffer.from(result.base64, 'base64'), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
      'Cache-Control': 'no-store',
    },
  })
})
