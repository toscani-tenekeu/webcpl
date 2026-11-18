import { mkdirSync, readFileSync } from 'node:fs'
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
}

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })

export const version: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
