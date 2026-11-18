import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const env = process.env
export const root = resolve(import.meta.dir, '..')
const dev = env.NODE_ENV !== 'production'

export const config = {
  port: Number(env.WEBCPL_PORT || 7777),
  host: env.WEBCPL_HOST || '0.0.0.0',
  dataDir: resolve(env.WEBCPL_DATA || (dev ? join(root, 'data') : '/var/lib/webcpl')),
  agentSocket: env.WEBCPL_AGENT_SOCKET || '/run/webcpl/agent.sock',
  webDist: join(root, 'web', 'dist'),
  /** HTTPS on the panel's port, with the hostname's certificate (set from Settings). */
  tls: env.WEBCPL_TLS === '1' && existsSync('/etc/webcpl/ssl/host/cert.pem') ? { cert: '/etc/webcpl/ssl/host/cert.pem', key: '/etc/webcpl/ssl/host/key.pem' } : null,
}

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })

export const version: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
