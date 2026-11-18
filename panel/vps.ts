// VPS: the panel keeps a row per instance and asks the agent to act on Incus.
import { VPS_IMAGES, VPS_NAME, vpsImage } from '../shared/vps.ts'
import { parseLimits } from './access.ts'
import { agent } from './agent.ts'
import { db, getSetting, logActivity, now, planById, type UserRow, type VpsRow } from './db.ts'
import { HttpError } from './errors.ts'

export const hasVps = (u: UserRow) => !!u.vps_plan_id && u.role !== 'admin'
export const vpsById = (id: number) => db.query<VpsRow, [number]>('SELECT * FROM vps WHERE id = ?').get(id)
export const vpsOf = (userId: number) => db.query<VpsRow, [number]>('SELECT * FROM vps WHERE user_id = ? ORDER BY id').all(userId)
const period = () => new Date().toISOString().slice(0, 7)

export function vpsLimits(u: UserRow) {
  return parseLimits(u.vps_plan_id ? planById(u.vps_plan_id) : null) as Record<string, number | null | undefined>
}

export function availableImages() {
  let off: string[] = []
  try {
    off = JSON.parse(getSetting('vps_disabled_images', '[]'))
  } catch {}
  return VPS_IMAGES.filter((i) => !off.includes(i.id))
}

/** What the plan still allows, leaving out one instance when it is being resized. */
export function room(u: UserRow, exceptId: number | null = null) {
  const limits = vpsLimits(u)
  const used = { vcpu: 0, memory_mb: 0, disk_gb: 0 }
  for (const v of vpsOf(u.id)) {
    if (v.id === exceptId) continue
    used.vcpu += v.vcpu
    used.memory_mb += v.memory_mb
    used.disk_gb += v.disk_gb
  }
  const left = (key: 'vcpu' | 'memory_mb' | 'disk_gb') => (typeof limits[key] === 'number' ? Math.max(0, limits[key]! - used[key]) : null)
  return { used, left: { vcpu: left('vcpu'), memory_mb: left('memory_mb'), disk_gb: left('disk_gb') } }
}

export function checkResources(u: UserRow, body: Record<string, unknown>, exceptId: number | null = null) {
  const values = { vcpu: Number(body.vcpu), memory_mb: Number(body.memoryMb), disk_gb: Number(body.diskGb) }
  if (!Number.isInteger(values.vcpu) || values.vcpu < 1) throw new HttpError(400, 'Give at least 1 vCPU.', 'bad_cpu')
  if (!Number.isInteger(values.memory_mb) || values.memory_mb < 256) throw new HttpError(400, 'Give at least 256 MB of memory.', 'bad_memory')
  if (!Number.isInteger(values.disk_gb) || values.disk_gb < 2) throw new HttpError(400, 'Give at least 2 GB of disk.', 'bad_disk')
  const { left } = room(u, exceptId)
  for (const key of ['vcpu', 'memory_mb', 'disk_gb'] as const) {
    if (left[key] !== null && values[key] > left[key]!) throw new HttpError(403, 'Your VPS plan does not have that much left.', 'plan_full')
  }
  return values
}

export function checkPassword(value: unknown) {
  const password = String(value ?? '')
  if (password.length < 10 || password.length > 128 || /[\n:]/.test(password)) {
    throw new HttpError(400, 'The root password needs at least 10 characters.', 'bad_password')
  }
  return password
}

export function checkKey(value: unknown) {
  const key = String(value ?? '').trim()
  if (key && !/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/.test(key)) {
    throw new HttpError(400, 'That SSH public key is not valid.', 'bad_key')
  }
  return key
}

async function portFree(port: number) {
  try {
    const listener = Bun.listen({ hostname: '0.0.0.0', port, socket: { data() {} } })
    listener.stop(true)
    return true
  } catch {
    return false
  }
}

async function pickPort() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = 22000 + Math.floor(Math.random() * 8000)
    if (db.query('SELECT 1 FROM vps WHERE ssh_port = ?').get(port)) continue
    if (await portFree(port)) return port
  }
  throw new HttpError(503, 'No free port is left for SSH.', 'no_port')
}

function update(id: number, fields: Partial<VpsRow>) {
  const keys = Object.keys(fields)
  db.query(`UPDATE vps SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(Object.values(fields) as (string | number | null)[]), id)
}

// One heavy job at a time per server keeps image downloads and package installs from piling up.
let chain: Promise<unknown> = Promise.resolve()
const queue = (job: () => Promise<unknown>) => (chain = chain.then(job, job))

async function setup(v: VpsRow, password: string, key: string) {
  update(v.id, { progress: 'setup' })
  const state = await agent<{ ipv4: string | null }>('vps.setup', { name: v.instance, password, ssh_key: key }, 15 * 60_000)
  update(v.id, { status: 'ready', progress: null, error: null, ipv4: state.ipv4 })
}

export async function create(u: UserRow, body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim().toLowerCase()
  if (!VPS_NAME.test(name)) throw new HttpError(400, 'Use 3–24 lowercase letters, digits or hyphens, starting with a letter.', 'bad_name')
  const image = vpsImage(body.image)
  if (!image || !availableImages().includes(image)) throw new HttpError(400, 'Choose an operating system.', 'bad_image')
  const password = checkPassword(body.password)
  const key = checkKey(body.sshKey)
  const values = checkResources(u, body)
  if (db.query('SELECT 1 FROM vps WHERE user_id = ? AND name = ?').get(u.id, name)) throw new HttpError(409, 'You already have a VPS with that name.', 'name_taken')
  const port = await pickPort()
  const instance = `${u.username}-${name}`
  const id = Number(
    db.query(`INSERT INTO vps(user_id, name, instance, image, vcpu, memory_mb, disk_gb, ssh_port, status, progress, traffic_period, created_at)
      VALUES(?,?,?,?,?,?,?,?,'creating','queued',?,?)`).run(u.id, name, instance, image.id, values.vcpu, values.memory_mb, values.disk_gb, port, period(), now()).lastInsertRowid,
  )
  void queue(async () => {
    const v = vpsById(id)
    if (!v) return
    try {
      update(id, { progress: 'image' })
      await agent('vps.create', { name: instance, image: image.id, owner: u.username, ssh_port: port, vcpu: values.vcpu, memory_mb: values.memory_mb, disk_gb: values.disk_gb }, 20 * 60_000)
      await setup(v, password, key)
    } catch (error) {
      update(id, { status: 'error', progress: null, error: (error as Error).message })
    }
  })
  return vpsById(id)!
}

export function reinstall(v: VpsRow, body: Record<string, unknown>) {
  const image = vpsImage(body.image)
  if (!image || !availableImages().includes(image)) throw new HttpError(400, 'Choose an operating system.', 'bad_image')
  const password = checkPassword(body.password)
  const key = checkKey(body.sshKey)
  update(v.id, { status: 'creating', progress: 'queued', error: null, image: image.id })
  void queue(async () => {
    try {
      update(v.id, { progress: 'image' })
      await agent('vps.rebuild', { name: v.instance, image: image.id }, 20 * 60_000)
      await setup(v, password, key)
    } catch (error) {
      update(v.id, { status: 'error', progress: null, error: (error as Error).message })
    }
  })
}

export async function remove(v: VpsRow) {
  update(v.id, { status: 'deleting' })
  await agent('vps.delete', { name: v.instance }, 180_000)
  db.query('DELETE FROM vps WHERE id = ?').run(v.id)
}

/** Live state from Incus for a set of rows; missing ones are reported as such. */
export async function liveState(rows: VpsRow[]) {
  if (!rows.length) return {}
  try {
    return await agent<Record<string, { status: string; ipv4: string | null; ipv6: string | null; cpuNs: number; memoryBytes: number; diskBytes: number | null; rxBytes: number; txBytes: number }>>(
      'vps.state', { names: rows.map((r) => r.instance) }, 30_000)
  } catch {
    return {}
  }
}

export function publicVps(v: VpsRow, live?: Awaited<ReturnType<typeof liveState>>[string]) {
  const image = vpsImage(v.image)
  return {
    id: v.id,
    userId: v.user_id,
    name: v.name,
    image: image ? { id: image.id, name: image.name, version: image.version } : { id: v.image, name: v.image, version: '' },
    vcpu: v.vcpu,
    memoryMb: v.memory_mb,
    diskGb: v.disk_gb,
    sshPort: v.ssh_port,
    status: v.status,
    progress: v.progress,
    error: v.error,
    state: live?.status ?? (v.status === 'ready' ? 'unknown' : null),
    ipv4: live?.ipv4 ?? v.ipv4,
    ipv6: live?.ipv6 ?? null,
    memoryBytes: live?.memoryBytes ?? null,
    diskBytes: live?.diskBytes ?? null,
    cpuNs: live?.cpuNs ?? null,
    trafficBytes: v.traffic_period === period() ? v.traffic_bytes : 0,
    throttled: !!v.throttled,
    createdAt: v.created_at,
  }
}

// ---- account hooks ----------------------------------------------------------------------------------

export async function suspendAll(u: UserRow) {
  for (const v of vpsOf(u.id)) if (v.status === 'ready') await agent('vps.power', { name: v.instance, action: 'stop' }, 120_000).catch(() => null)
}

export async function unsuspendAll(u: UserRow) {
  for (const v of vpsOf(u.id)) if (v.status === 'ready') await agent('vps.power', { name: v.instance, action: 'start' }, 120_000).catch(() => null)
}

export async function removeAll(u: UserRow) {
  for (const v of vpsOf(u.id)) await remove(v).catch(() => db.query('DELETE FROM vps WHERE id = ?').run(v.id))
}

// ---- traffic ----------------------------------------------------------------------------------------

/** Adds what each instance sent and received since the last look; slows it down past the plan. */
export async function measureTraffic() {
  const rows = db.query<VpsRow, []>("SELECT * FROM vps WHERE status = 'ready'").all()
  const live = await liveState(rows)
  const current = period()
  for (const v of rows) {
    const s = live[v.instance]
    if (!s) continue
    // Counters restart from zero when the instance restarts.
    const rx = s.rxBytes >= v.last_rx ? s.rxBytes - v.last_rx : s.rxBytes
    const tx = s.txBytes >= v.last_tx ? s.txBytes - v.last_tx : s.txBytes
    const total = (v.traffic_period === current ? v.traffic_bytes : 0) + rx + tx
    update(v.id, { traffic_period: current, traffic_bytes: total, last_rx: s.rxBytes, last_tx: s.txBytes, ipv4: s.ipv4 ?? v.ipv4 })
    const owner = db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(v.user_id)
    const quota = owner ? vpsLimits(owner).traffic_gb : null
    const over = typeof quota === 'number' && total > quota * 1e9
    if (over !== !!v.throttled) {
      await agent('vps.throttle', { name: v.instance, on: over }).catch(() => null)
      update(v.id, { throttled: over ? 1 : 0 })
      if (over) logActivity({ subjectId: v.user_id, action: 'VPS traffic used up', detail: v.name })
    }
  }
}

export function startTraffic() {
  setInterval(() => void measureTraffic().catch(() => null), 5 * 60_000)
}
