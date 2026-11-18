// Measures disk and bandwidth for hosting accounts in the background.
import { agent } from './agent.ts'
import { db, logActivity, now, userById, type UserRow } from './db.ts'
import { hostingLimits, writeAllSites } from './hosting.ts'

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

/** Turns sites off for accounts past their monthly bandwidth, and back on when it resets. */
async function enforceBandwidth() {
  const users = db.query<UserRow, []>('SELECT * FROM users WHERE linux_user = 1').all()
  for (const u of users) {
    const limit = hostingLimits(u).bandwidth_gb
    const used = db.query<{ bandwidth: number }, [number, string]>('SELECT bandwidth FROM usage WHERE user_id = ? AND period = ?').get(u.id, period())?.bandwidth ?? 0
    const over = typeof limit === 'number' && used > limit * 1e9
    if (over === !!u.over_bandwidth) continue
    db.query('UPDATE users SET over_bandwidth = ? WHERE id = ?').run(over ? 1 : 0, u.id)
    await writeAllSites(userById(u.id)!)
    logActivity({ subjectId: u.id, action: over ? 'bandwidth used up: websites paused' : 'bandwidth available again: websites back' })
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
  setTimeout(safely(enforceBandwidth), 30_000)
  setInterval(safely(async () => {
    await bandwidth()
    await enforceBandwidth()
  }), 5 * 60_000)
  setInterval(safely(disk), 30 * 60_000)
}
