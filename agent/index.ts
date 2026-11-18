// The Webcpl agent: the only part of Webcpl that runs as root.
//
// It listens on a Unix socket that only the panel's group can open, and accepts a fixed
// list of named operations. Each one checks its arguments and runs programs with explicit
// argument lists, never through a shell. One request per line, JSON in and out:
//   → {"id":1,"op":"system.info","args":{}}
//   ← {"id":1,"ok":true,"result":{…}}
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { operations } from './ops.ts'

const SOCKET = process.env.WEBCPL_AGENT_SOCKET ?? '/run/webcpl/agent.sock'
/** The group allowed to talk to the agent: the panel runs in it. */
const GROUP = process.env.WEBCPL_GROUP ?? 'webcpl'

function groupId(name: string): number | null {
  const line = Bun.spawnSync(['getent', 'group', name]).stdout.toString().trim()
  const gid = Number(line.split(':')[2])
  return Number.isInteger(gid) ? gid : null
}

interface Request {
  id?: unknown
  op?: unknown
  args?: unknown
}

async function handle(line: string): Promise<string> {
  let request: Request
  try {
    request = JSON.parse(line)
  } catch {
    return JSON.stringify({ id: null, ok: false, error: 'Invalid request.' })
  }
  const id = request.id ?? null
  const op = typeof request.op === 'string' ? operations[request.op] : undefined
  if (!op) return JSON.stringify({ id, ok: false, error: `Unknown operation: ${String(request.op)}` })
  try {
    const result = await op(request.args && typeof request.args === 'object' ? (request.args as Record<string, unknown>) : {})
    return JSON.stringify({ id, ok: true, result })
  } catch (error) {
    return JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

mkdirSync(dirname(SOCKET), { recursive: true })
if (existsSync(SOCKET)) rmSync(SOCKET)

const buffers = new WeakMap<object, string>()

Bun.listen({
  unix: SOCKET,
  socket: {
    data(socket, chunk) {
      let text = (buffers.get(socket) ?? '') + chunk.toString()
      if (text.length > 1024 * 1024) {
        socket.end()
        return
      }
      let newline = text.indexOf('\n')
      while (newline >= 0) {
        const line = text.slice(0, newline)
        text = text.slice(newline + 1)
        if (line.trim()) void handle(line).then((reply) => socket.write(reply + '\n'))
        newline = text.indexOf('\n')
      }
      buffers.set(socket, text)
    },
  },
})

// Only root and the panel's group may connect.
const gid = groupId(GROUP)
if (gid !== null) chownSync(SOCKET, 0, gid)
chmodSync(SOCKET, 0o660)
console.log(`Webcpl agent listening on ${SOCKET}`)
