import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatePassword, hashPasswordSync } from './auth.ts'
import { config } from './config.ts'
import { db, logActivity, now } from './db.ts'

export const INITIAL_PASSWORD_FILE = join(config.dataDir, 'initial-admin-password')

/** Example plans on a fresh install, so the panel is usable at once. They can be edited or deleted. */
const STARTER_PLANS = [
  { kind: 'hosting', name: 'Starter', limits: { disk_mb: 5120, bandwidth_gb: 100, domains: 1, subdomains: 10, databases: 2, mailboxes: 5, ftp_accounts: 2, cron_jobs: 5, cpu_percent: 100, memory_mb: 1024, processes: 40, inodes: 150000, ssh: false, apps: false } },
  { kind: 'hosting', name: 'Business', limits: { disk_mb: 30720, bandwidth_gb: null, domains: 10, subdomains: null, databases: 20, mailboxes: 50, ftp_accounts: 10, cron_jobs: 20, cpu_percent: 200, memory_mb: 2048, processes: 100, inodes: 500000, ssh: true, apps: true } },
  { kind: 'vps', name: 'VPS S', limits: { vcpu: 1, memory_mb: 1024, disk_gb: 20, traffic_gb: 1000, snapshots: 2, ipv4: 0 } },
  { kind: 'vps', name: 'VPS M', limits: { vcpu: 2, memory_mb: 4096, disk_gb: 60, traffic_gb: 3000, snapshots: 5, ipv4: 1 } },
  { kind: 'reseller', name: 'Reseller', limits: { users: 25, disk_mb: 102400, bandwidth_gb: 1000, domains: 100, databases: 200, mailboxes: 500, vps_vcpu: 8, vps_memory_mb: 16384, vps_disk_gb: 200, oversell: false } },
] as const

/** Creates the administrator on first start. The password goes to a root-only file the installer prints once. */
export function ensureAdmin() {
  if (db.query("SELECT 1 FROM users WHERE role = 'admin'").get()) return
  const password = generatePassword(20)
  const result = db
    .query("INSERT INTO users(username, password_hash, role, created_at) VALUES('admin', ?, 'admin', ?)")
    .run(hashPasswordSync(password), now())
  const adminId = Number(result.lastInsertRowid)
  for (const plan of STARTER_PLANS) {
    db.query('INSERT INTO plans(owner_id, kind, name, limits, created_at) VALUES(?,?,?,?,?)').run(adminId, plan.kind, plan.name, JSON.stringify(plan.limits), now())
  }
  writeFileSync(INITIAL_PASSWORD_FILE, password + '\n', { mode: 0o600 })
  logActivity({ actorId: adminId, subjectId: adminId, action: 'installed Webcpl' })
  console.log(`Administrator "admin" created. Password saved to ${INITIAL_PASSWORD_FILE}`)
}

export function forgetInitialPassword() {
  if (existsSync(INITIAL_PASSWORD_FILE)) rmSync(INITIAL_PASSWORD_FILE)
}
