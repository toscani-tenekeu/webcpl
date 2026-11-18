// Helpers shared by the agent's operations. Every name and path from the panel is
// checked here before it reaches a command line or a configuration file.
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, normalize } from 'node:path'

export type Args = Record<string, unknown>

export interface RunResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/** Runs a program with an explicit argument list (never a shell). */
export async function run(cmd: string[], opts: { timeout?: number; input?: string | Uint8Array | Blob; env?: Record<string, string> } = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.input === undefined ? 'ignore' : opts.input instanceof Blob ? opts.input : new Blob([opts.input]),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: opts.timeout ?? 60_000,
    env: { PATH: PATH_ENV, LC_ALL: 'C', HOME: '/root', ...opts.env },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { ok: code === 0, code, stdout, stderr }
}

/** Runs a program as an account's Linux user, so the kernel's permissions apply. */
export const runAs = (user: string, cmd: string[], opts: Parameters<typeof run>[1] = {}) =>
  run(['runuser', '-u', user, '--', ...cmd], { ...opts, env: { HOME: `/home/${user}`, ...opts.env } })

export async function must(cmd: string[], what: string, opts: Parameters<typeof run>[1] = {}) {
  const result = await run(cmd, opts)
  if (!result.ok) throw new Error(`${what}: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ') || `exit ${result.code}`}`)
  return result
}

export const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Writes a file atomically (temporary file, then rename), so a reader never sees half of it. */
export function writeAtomic(path: string, content: string, mode = 0o644, owner?: { uid: number; gid: number }) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.webcpl-tmp`
  writeFileSync(tmp, content, { mode })
  chmodSync(tmp, mode)
  if (owner) chownSync(tmp, owner.uid, owner.gid)
  renameSync(tmp, path)
}

export const removeFile = (path: string) => {
  if (existsSync(path)) rmSync(path, { force: true })
}

// ---- validation ----------------------------------------------------------------------

export const USERNAME = /^[a-z][a-z0-9]{2,15}$/
export const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
export const PHP_VERSION = /^8\.[1-4]$/
export const DB_NAME = /^[a-z][a-z0-9]{2,15}_[a-z0-9]{1,32}$/

export function username(args: Args, key = 'user') {
  const value = String(args[key] ?? '')
  if (!USERNAME.test(value)) throw new Error('Invalid account name.')
  return value
}

export function domain(value: unknown) {
  const name = String(value ?? '').toLowerCase()
  if (!DOMAIN.test(name)) throw new Error(`Invalid domain: ${name}`)
  return name
}

export function phpVersion(value: unknown) {
  const v = String(value ?? '')
  if (!PHP_VERSION.test(v)) throw new Error('Invalid PHP version.')
  return v
}

/** A path inside an account's home folder, given relative to it ("domains/x/public_html"). */
export function homePath(user: string, relative: unknown) {
  const rel = String(relative ?? '').replace(/^\/+/, '')
  if (rel.includes('\0')) throw new Error('Invalid path.')
  const home = `/home/${user}`
  const full = normalize(`${home}/${rel}`)
  if (full !== home && !full.startsWith(`${home}/`)) throw new Error('That path is outside the account.')
  return full
}

export async function ids(user: string) {
  const [uid, gid] = await Promise.all([run(['id', '-u', user]), run(['id', '-g', user])])
  if (!uid.ok) throw new Error(`No such account on this server: ${user}`)
  return { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) }
}

/** Single-quoted SQL string literal. */
export const sqlString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
