// Browser console for a VPS: a websocket on the panel, relayed to the agent's console socket.
import type { Server, ServerWebSocket, Socket } from 'bun'
import { canManage } from './access.ts'
import { agent } from './agent.ts'
import { cookieToken, sessionFor } from './auth.ts'
import { config } from './config.ts'
import { logActivity, userById, type VpsRow } from './db.ts'
import { vpsById } from './vps.ts'

export interface ConsoleData {
  userId: number
  vps: VpsRow
  cols: number
  rows: number
  upstream?: Socket<{ buffer: string }>
}

const open = new Map<number, number>()
const PER_USER = 6

export function upgradeConsole(req: Request, url: URL, server: Server<ConsoleData>, id: number): Response | undefined {
  const origin = req.headers.get('origin')
  try {
    if (origin && new URL(origin).host !== req.headers.get('host')) return new Response('Forbidden', { status: 403 })
  } catch {
    return new Response('Forbidden', { status: 403 })
  }
  const session = sessionFor(cookieToken(req.headers.get('cookie')))
  const u = session?.user
  if (!u || (u.must_change_password && !session.impersonatorId)) return new Response('Unauthorized', { status: 401 })
  const v = vpsById(id)
  const owner = v ? userById(v.user_id) : null
  if (!v || !owner || (v.user_id !== u.id && !canManage(u, owner))) return new Response('Not Found', { status: 404 })
  if (v.status !== 'ready' || owner.suspended) return new Response('Conflict', { status: 409 })
  if ((open.get(u.id) ?? 0) >= PER_USER) return new Response('Too Many Requests', { status: 429 })
  const cols = Math.min(500, Math.max(20, Number(url.searchParams.get('cols')) || 100))
  const rows = Math.min(300, Math.max(5, Number(url.searchParams.get('rows')) || 30))
  if (server.upgrade(req, { data: { userId: u.id, vps: v, cols, rows } })) return undefined
  return new Response('Upgrade failed', { status: 400 })
}

export const consoleSocket = {
  maxPayloadLength: 1024 * 1024,
  idleTimeout: 0,
  sendPings: true,
  async open(ws: ServerWebSocket<ConsoleData>) {
    const { userId, vps, cols, rows } = ws.data
    open.set(userId, (open.get(userId) ?? 0) + 1)
    logActivity({ actorId: userId, subjectId: vps.user_id, action: 'opened VPS console', detail: vps.name })
    try {
      const { token } = await agent<{ token: string }>('vps.console', { name: vps.instance, cols, rows })
      ws.data.upstream = await Bun.connect<{ buffer: string }>({
        unix: config.agentSocket.replace(/agent\.sock$/, 'console.sock'),
        socket: {
          open(socket) {
            socket.data = { buffer: '' }
            socket.write(JSON.stringify({ token }) + '\n')
          },
          data(socket, chunk) {
            socket.data.buffer += chunk.toString()
            let newline = socket.data.buffer.indexOf('\n')
            while (newline >= 0) {
              const line = socket.data.buffer.slice(0, newline)
              socket.data.buffer = socket.data.buffer.slice(newline + 1)
              try {
                const message = JSON.parse(line) as { o?: string; x?: number }
                if (typeof message.o === 'string' && ws.readyState === 1) ws.sendBinary(Buffer.from(message.o, 'base64'))
                if (message.x !== undefined) ws.close()
              } catch {}
              newline = socket.data.buffer.indexOf('\n')
            }
          },
          close() {
            ws.close()
          },
          error() {
            ws.close()
          },
        },
      })
    } catch {
      ws.close(1011, 'The console could not be opened.')
    }
  },
  message(ws: ServerWebSocket<ConsoleData>, message: string | Buffer) {
    let parsed: { t?: string; d?: string; c?: number; r?: number }
    try {
      parsed = JSON.parse(String(message))
    } catch {
      return
    }
    const up = ws.data.upstream
    if (!up) return
    if (parsed.t === 'i' && typeof parsed.d === 'string') up.write(JSON.stringify({ i: Buffer.from(parsed.d).toString('base64') }) + '\n')
    else if (parsed.t === 'r') up.write(JSON.stringify({ r: [Number(parsed.c), Number(parsed.r)] }) + '\n')
  },
  close(ws: ServerWebSocket<ConsoleData>) {
    open.set(ws.data.userId, Math.max(0, (open.get(ws.data.userId) ?? 1) - 1))
    ws.data.upstream?.end()
  },
}
