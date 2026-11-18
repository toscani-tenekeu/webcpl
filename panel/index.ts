import { join, normalize } from 'node:path'
import { ensureAdmin } from './bootstrap.ts'
import { config, version } from './config.ts'
import { handleApi, SECURITY_HEADERS } from './http.ts'
import './routes/auth.ts'
import './routes/accounts.ts'
import './routes/plans.ts'
import './routes/server.ts'

async function serveStatic(url: URL) {
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = join(config.webDist, requested)
  const target = file.startsWith(config.webDist) && requested !== '/' && (await Bun.file(file).exists()) ? file : join(config.webDist, 'index.html')
  if (!(await Bun.file(target).exists())) return new Response('The interface has not been built. Run: bun run build', { status: 503 })
  return new Response(Bun.file(target), {
    headers: { ...SECURITY_HEADERS, 'Cache-Control': target.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' },
  })
}

ensureAdmin()

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/')) return handleApi(req, url, srv)
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Not Found', { status: 404 })
    return serveStatic(url)
  },
})

console.log(`Webcpl ${version} listening on http://${server.hostname}:${server.port}`)
