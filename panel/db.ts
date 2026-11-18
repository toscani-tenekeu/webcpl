import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { config } from './config.ts'

export const db = new Database(join(config.dataDir, 'panel.db'), { create: true, strict: true })
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Plans: what an account gets. Admins make plans of every kind; resellers make hosting and VPS plans.
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('hosting','vps','reseller')),
  name TEXT NOT NULL,
  limits TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, kind, name)
);

-- Accounts on three levels. owner_id is who created and manages the account: the admin or a reseller.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','reseller','user')),
  owner_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  hosting_plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  vps_plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  reseller_plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  suspended INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT NOT NULL DEFAULT '',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Set when an admin or reseller signed in as this account ("log in as").
  impersonator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- The account the action was about, so its owner and the account itself can see it.
  subject_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS activity_subject ON activity(subject_id, at);
CREATE INDEX IF NOT EXISTS activity_actor ON activity(actor_id, at);

-- Websites. A subdomain has a parent; its DNS record lives in the parent's zone.
CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  parent_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
  docroot TEXT NOT NULL,
  php_version TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  ssl_cert TEXT,
  ssl_key TEXT,
  ssl_expires_at INTEGER,
  force_https INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS databases (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  remote INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Bandwidth per calendar month, disk as last measured.
CREATE TABLE IF NOT EXISTS vps (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  instance TEXT NOT NULL UNIQUE,
  image TEXT NOT NULL,
  vcpu INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  disk_gb INTEGER NOT NULL,
  ssh_port INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'creating',
  progress TEXT,
  error TEXT,
  ipv4 TEXT,
  traffic_period TEXT,
  traffic_bytes INTEGER NOT NULL DEFAULT 0,
  last_rx INTEGER NOT NULL DEFAULT 0,
  last_tx INTEGER NOT NULL DEFAULT 0,
  throttled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  bandwidth INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
`)

// Columns added after 0.1.
for (const statement of [
  'ALTER TABLE users ADD COLUMN linux_user INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE users ADD COLUMN php_settings TEXT NOT NULL DEFAULT '{}'",
  'ALTER TABLE users ADD COLUMN disk_used INTEGER',
  'ALTER TABLE users ADD COLUMN disk_measured_at INTEGER',
  "ALTER TABLE databases ADD COLUMN engine TEXT NOT NULL DEFAULT 'mariadb'",
  'ALTER TABLE users ADD COLUMN redis_enabled INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(statement)
  } catch {
    // Already there.
  }
}

export const now = () => Date.now()

export type Role = 'admin' | 'reseller' | 'user'

export interface UserRow {
  id: number
  username: string
  email: string
  password_hash: string
  role: Role
  owner_id: number | null
  hosting_plan_id: number | null
  vps_plan_id: number | null
  reseller_plan_id: number | null
  suspended: number
  suspended_reason: string
  must_change_password: number
  totp_secret: string | null
  totp_enabled: number
  note: string
  created_at: number
  last_login_at: number | null
  linux_user: number
  php_settings: string
  disk_used: number | null
  disk_measured_at: number | null
  redis_enabled: number
}

export interface DomainRow {
  id: number
  user_id: number
  name: string
  parent_id: number | null
  docroot: string
  php_version: string
  aliases: string
  ssl_cert: string | null
  ssl_key: string | null
  ssl_expires_at: number | null
  force_https: number
  created_at: number
}

export interface VpsRow {
  id: number
  user_id: number
  name: string
  instance: string
  image: string
  vcpu: number
  memory_mb: number
  disk_gb: number
  ssh_port: number
  status: 'creating' | 'ready' | 'error' | 'deleting'
  progress: string | null
  error: string | null
  ipv4: string | null
  traffic_period: string | null
  traffic_bytes: number
  last_rx: number
  last_tx: number
  throttled: number
  created_at: number
}

export interface PlanRow {
  id: number
  owner_id: number
  kind: 'hosting' | 'vps' | 'reseller'
  name: string
  limits: string
  created_at: number
}

export const userById = (id: number) => db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(id)
export const planById = (id: number) => db.query<PlanRow, [number]>('SELECT * FROM plans WHERE id = ?').get(id)

export function getSetting(key: string, fallback = '') {
  return db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback
}
export function allSettings(keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, getSetting(key)]))
}

export function setSetting(key: string, value: string) {
  db.query('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function logActivity(entry: { actorId?: number | null; subjectId?: number | null; action: string; detail?: string; ip?: string }) {
  db.query('INSERT INTO activity(at, actor_id, subject_id, action, detail, ip) VALUES(?,?,?,?,?,?)').run(
    now(),
    entry.actorId ?? null,
    entry.subjectId ?? null,
    entry.action,
    entry.detail ?? '',
    entry.ip ?? '',
  )
}
