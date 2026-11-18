import type { Server } from 'bun'
import { apiKeyUser, cookieToken, sessionFor } from './auth.ts'
import type { UserRow } from './db.ts'
import { HttpError } from './errors.ts'

export interface Ctx {
  req: Request
  url: URL
  params: Record<string, string>
  body: Record<string, unknown>
  ip: string
  token: string | null
  user: UserRow | null
  /** The admin or reseller signed in as this account, if any. */
  impersonatorId: number | null
  viaApiKey: boolean
  secure: boolean
  headers: Headers
}

type Handler = (ctx: Ctx) => unknown
type Guard = 'open' | 'signed-in'

interface Route {
  method: string
  parts: string[]
  handler: Handler
  guard: Guard
}

const routes: Route[] = []

/** Registers a route; `signed-in` routes get ctx.user set or answer 401. */
export function route(method: string, path: string, handler: Handler, guard: Guard = 'signed-in') {
  routes.push({ method, parts: path.split('/').filter(Boolean), handler, guard })
}

function match(method: string, path: string) {
  const parts = path.split('/').filter(Boolean)
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue
    const params: Record<string, string> = {}
    if (r.parts.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(parts[i]!)), true) : p === parts[i]))) {
      return { route: r, params }
    }
  }
  return null
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

export const json = (data: unknown, status = 200, headers: Headers | Record<string, string> = {}) => {
  const out = new Headers({ ...SECURITY_HEADERS, 'Cache-Control': 'no-store' })
  new Headers(headers).forEach((value, key) => out.append(key, value))
  return Response.json(data, { status, headers: out })
}

function clientIp(req: Request, server: Server<unknown>) {
  const remote = server.requestIP(req)?.address ?? ''
  if (/^(127\.|::1$|::ffff:127\.)/.test(remote)) return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || remote
  return remote
}

export async function handleApi(req: Request, url: URL, server: Server<unknown>) {
  const ctx: Ctx = {
    req,
    url,
    params: {},
    body: {},
    ip: clientIp(req, server),
    token: cookieToken(req.headers.get('cookie')),
    user: null,
    impersonatorId: null,
    viaApiKey: false,
    secure: url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https',
    headers: new Headers(),
  }
  try {
    const found = match(req.method, url.pathname)
    if (!found) throw new HttpError(404, 'Not found.', 'not_found')

    // API keys sign each request; browsers use the session cookie plus a custom header,
    // which a cross-site form cannot send.
    const keyUser = apiKeyUser(req.headers.get('authorization'))
    if (keyUser) {
      ctx.user = keyUser
      ctx.viaApiKey = true
    } else {
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.get('x-webcpl') !== '1') {
        throw new HttpError(403, 'Missing request header.', 'csrf')
      }
      const session = sessionFor(ctx.token)
      ctx.user = session?.user ?? null
      ctx.impersonatorId = session?.impersonatorId ?? null
    }

    if (found.route.guard === 'signed-in') {
      if (!ctx.user) throw new HttpError(401, 'Please sign in.', 'auth')
      const allowedBeforeChange = ['/api/account/password', '/api/auth/logout', '/api/auth/me', '/api/auth/return']
      if (ctx.user.must_change_password && !ctx.impersonatorId && !allowedBeforeChange.includes(url.pathname)) {
        throw new HttpError(403, 'Choose a new password first.', 'must_change_password')
      }
    }
    ctx.params = found.params

    if (!['GET', 'HEAD'].includes(req.method)) {
      const text = await req.text()
      if (text.length > 256 * 1024) throw new HttpError(413, 'Request too large.', 'too_large')
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text)
          ctx.body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
        } catch {
          throw new HttpError(400, 'Invalid JSON.', 'bad_json')
        }
      }
    }

    const result = await found.route.handler(ctx)
    return json(result ?? { ok: true }, req.method === 'POST' && /^\/api\/(accounts|plans|account\/api-keys)$/.test(url.pathname) ? 201 : 200, ctx.headers)
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status, ctx.headers)
    console.error(error)
    return json({ error: 'Something went wrong on the server.', code: 'server' }, 500, ctx.headers)
  }
}
