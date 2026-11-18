// Talks to the root agent over its Unix socket. One connection per request keeps it simple.
import { config } from './config.ts'
import { HttpError } from './errors.ts'

let next = 0

export function agent<T = unknown>(op: string, args: Record<string, unknown> = {}, timeout = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++next
    let buffer = ''
    let settled = false
    const done = (error: Error | null, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value as T)
    }
    const timer = setTimeout(() => done(new HttpError(504, 'The server agent took too long to answer.', 'agent_timeout')), timeout)
    Bun.connect({
      unix: config.agentSocket,
      socket: {
        open(socket) {
          socket.write(JSON.stringify({ id, op, args }) + '\n')
        },
        data(socket, chunk) {
          buffer += chunk.toString()
          const newline = buffer.indexOf('\n')
          if (newline < 0) return
          // Settle before closing: end() runs the close handler at once.
          try {
            const reply = JSON.parse(buffer.slice(0, newline))
            if (reply.ok) done(null, reply.result)
            else done(new HttpError(502, reply.error || 'The server agent refused the operation.', 'agent'))
          } catch {
            done(new HttpError(502, 'The server agent sent an invalid answer.', 'agent'))
          }
          socket.end()
        },
        error(_socket, error) {
          done(new HttpError(502, `The server agent is not reachable: ${error.message}`, 'agent_down'))
        },
        close() {
          done(new HttpError(502, 'The server agent closed the connection.', 'agent_down'))
        },
      },
    }).catch((error: Error) => done(new HttpError(502, `The server agent is not running (${error.message}).`, 'agent_down')))
  })
}
