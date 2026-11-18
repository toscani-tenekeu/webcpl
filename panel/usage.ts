// Measures disk and bandwidth for hosting accounts in the background.
import { agent } from './agent.ts'
import { db, now } from './db.ts'

const period = () => new Date().toISOString().slice(0, 7)

async function bandwidth() {
  const totals = await agent<Record<string, Record<string, number>>>('usage.bandwidth')
  for (const [username, sites] of Object.entries(totals)) {
    const user = db.query<{ id: number }, [string]>('SELECT id FROM users WHERE username = ?').get(username)
    if (!user) continue
    const bytes = Object.values(sites).reduce((a, b) => a + b, 0)
    db.query('INSERT INTO usage(user_id, period, bandwidth) VALUES(?,?,?) ON CONFLICT(user_id, period) DO UPDATE SET bandwidth = bandwidth + excluded.bandwidth').run(user.id, period(), bytes)
  }
}

async function disk() {
  const users = db.query<{ id: number; username: string }, []>('SELECT id, username FROM users WHERE linux_user = 1').all()
  if (!users.length) return
  const sizes = await agent<Record<string, number>>('usage.disk', { users: users.map((u) => u.username) }, 900_000)
  for (const u of users) {
    if (sizes[u.username] !== undefined) db.query('UPDATE users SET disk_used = ?, disk_measured_at = ? WHERE id = ?').run(sizes[u.username]!, now(), u.id)
  }
}

export function startUsage() {
  const safely = (fn: () => Promise<void>) => () => void fn().catch((error: Error) => console.error(`usage: ${error.message}`))
  setTimeout(safely(disk), 20_000)
  setInterval(safely(bandwidth), 5 * 60_000)
  setInterval(safely(disk), 30 * 60_000)
}
