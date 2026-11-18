// A sample of the server's load, memory, disk and network every minute, kept for a day.
import { agent } from './agent.ts'
import { db } from './db.ts'

interface Sample { load: number; cpus: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number; rx: number; tx: number }
let last: Sample | null = null

async function sample() {
  const s = await agent<Sample>('system.metrics')
  // Network is stored as bytes per second since the previous sample.
  const rx = last && s.rx >= last.rx ? (s.rx - last.rx) / 60 : 0
  const tx = last && s.tx >= last.tx ? (s.tx - last.tx) / 60 : 0
  last = s
  db.query('INSERT OR REPLACE INTO metrics(at, load, mem_used, mem_total, disk_used, disk_total, rx, tx) VALUES(?,?,?,?,?,?,?,?)')
    .run(Math.floor(Date.now() / 60_000) * 60_000, s.load / Math.max(1, s.cpus), s.memUsed, s.memTotal, s.diskUsed, s.diskTotal, Math.round(rx), Math.round(tx))
  db.query('DELETE FROM metrics WHERE at < ?').run(Date.now() - 24 * 60 * 60_000)
}

export function recentMetrics() {
  return db.query<{ at: number; load: number; mem_used: number; mem_total: number; disk_used: number; disk_total: number; rx: number; tx: number }, []>(
    'SELECT * FROM metrics ORDER BY at').all()
}

export function startMetrics() {
  const tick = () => void sample().catch(() => null)
  tick()
  setInterval(tick, 60_000)
}
