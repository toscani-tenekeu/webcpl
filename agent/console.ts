// Browser consoles for VPS. The panel asks for a one-time token over the main socket
// (vps.console), then opens this second socket, sends the token, and relays a shell
// in a pseudo-terminal. Messages are JSON lines: {"i":base64} input, {"r":[cols,rows]} resize
// from the panel; {"o":base64} output and {"x":code} exit from the agent.
import { chmodSync, chownSync, existsSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Socket, Subprocess } from 'bun'
import { managedInstance } from './vps.ts'

const SOCKET = process.env.WEBCPL_CONSOLE_SOCKET ?? '/run/webcpl/console.sock'
const tokens = new Map<string, { name: string; cols: number; rows: number; expires: number }>()
const clamp = (v: unknown, min: number, max: number, fallback: number) => Math.min(max, Math.max(min, Number(v) || fallback))

export const consoleOps = {
  'vps.console': async (args: Record<string, unknown>) => {
    const name = await managedInstance(args.name)
    const token = randomBytes(24).toString('base64url')
    tokens.set(token, { name, cols: clamp(args.cols, 20, 500, 100), rows: clamp(args.rows, 5, 300, 30), expires: Date.now() + 30_000 })
    return { token }
  },
}

interface Conn { buffer: string; proc?: Subprocess }

export function startConsoleSocket(gid: number | null) {
  if (existsSync(SOCKET)) rmSync(SOCKET)
  Bun.listen<Conn>({
    unix: SOCKET,
    socket: {
      open(socket) {
        socket.data = { buffer: '' }
      },
      data(socket, chunk) {
        const conn = socket.data
        conn.buffer += chunk.toString()
        if (conn.buffer.length > 4 * 1024 * 1024) return void socket.end()
        let newline = conn.buffer.indexOf('\n')
        while (newline >= 0) {
          const line = conn.buffer.slice(0, newline)
          conn.buffer = conn.buffer.slice(newline + 1)
          handle(socket, line)
          newline = conn.buffer.indexOf('\n')
        }
      },
      close(socket) {
        socket.data?.proc?.kill()
      },
    },
  })
  if (gid !== null) chownSync(SOCKET, 0, gid)
  chmodSync(SOCKET, 0o660)
}

function handle(socket: Socket<Conn>, line: string) {
  let message: { token?: string; i?: string; r?: [number, number] }
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const conn = socket.data
  if (!conn.proc) {
    const grant = message.token ? tokens.get(message.token) : undefined
    if (message.token) tokens.delete(message.token)
    if (!grant || grant.expires < Date.now()) {
      socket.write(JSON.stringify({ x: -1 }) + '\n')
      return void socket.end()
    }
    conn.proc = Bun.spawn(
      ['incus', 'exec', grant.name, '--force-interactive', '--cwd', '/root', '--env', 'TERM=xterm-256color', '--env', 'HOME=/root', '--env', 'LANG=C.UTF-8',
        '--', '/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'],
      {
        terminal: {
          cols: grant.cols,
          rows: grant.rows,
          data(_term, data) {
            socket.write(JSON.stringify({ o: Buffer.from(data).toString('base64') }) + '\n')
          },
        },
        env: { ...process.env, TERM: 'xterm-256color' },
      },
    )
    conn.proc.exited.then((code) => {
      socket.write(JSON.stringify({ x: code }) + '\n')
      socket.end()
    })
    return
  }
  const term = conn.proc.terminal
  if (!term) return
  if (typeof message.i === 'string') term.write(Buffer.from(message.i, 'base64'))
  else if (Array.isArray(message.r)) term.resize(clamp(message.r[0], 20, 500, 100), clamp(message.r[1], 5, 300, 30))
}
