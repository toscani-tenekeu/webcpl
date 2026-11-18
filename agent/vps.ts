// VPS: LXC system containers run by Incus. Every operation names an instance that Webcpl
// created, and refuses any other: the instance carries user.webcpl.owner.
import { run } from './lib.ts'
import { vpsImage } from '../shared/vps.ts'

type Args = Record<string, unknown>
const INSTANCE = /^[a-z][a-z0-9-]{2,62}$/
const SNAPSHOT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/

async function incus(args: string[], { timeout = 120_000, input }: { timeout?: number; input?: string } = {}) {
  const result = await run(['incus', ...args], { timeout, input })
  if (!result.ok) throw new Error((result.stderr || result.stdout).trim().replace(/^Error: /, '').split('\n').at(-1) || 'Incus failed.')
  return result.stdout
}

function instanceName(value: unknown) {
  const name = String(value ?? '')
  if (!INSTANCE.test(name)) throw new Error('Invalid instance name.')
  return name
}

/** The instance, if it is one of ours. */
async function managed(value: unknown) {
  const name = instanceName(value)
  const owner = (await incus(['config', 'get', name, 'user.webcpl.owner'], { timeout: 20_000 }).catch(() => '')).trim()
  if (!owner) throw new Error('That VPS does not exist.')
  return name
}

function int(value: unknown, min: number, max: number, label: string) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} is out of range.`)
  return n
}

function resources(args: Args) {
  return {
    cpu: int(args.vcpu, 1, 256, 'vCPU'),
    memory: int(args.memory_mb, 128, 1024 * 1024, 'Memory'),
    disk: int(args.disk_gb, 1, 100_000, 'Disk'),
  }
}

/** Root signs in over SSH with a password or a key, on every supported distribution. */
const SSH_SETUP = `
set -u
export DEBIAN_FRONTEND=noninteractive
retry() { n=0; until "$@"; do n=$((n+1)); [ $n -ge 5 ] && return 1; sleep 3; done; }
if command -v apt-get >/dev/null 2>&1; then retry apt-get update -q && retry apt-get install -y -q openssh-server
elif command -v dnf >/dev/null 2>&1; then retry dnf install -y -q openssh-server
elif command -v apk >/dev/null 2>&1; then retry apk add --no-cache openssh
elif command -v pacman >/dev/null 2>&1; then retry pacman -Sy --noconfirm openssh
elif command -v zypper >/dev/null 2>&1; then retry zypper --non-interactive install openssh
fi
mkdir -p /etc/ssh/sshd_config.d /root/.ssh
chmod 700 /root/.ssh
grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config 2>/dev/null || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/00-webcpl.conf
ssh-keygen -A >/dev/null 2>&1
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1
  systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1
elif command -v rc-service >/dev/null 2>&1; then
  rc-update add sshd default >/dev/null 2>&1; rc-service sshd restart >/dev/null 2>&1
fi
true
`

const ufwActive = async () => Bun.which('ufw') !== null && /Status: active/.test((await run(['ufw', 'status'])).stdout)
async function ufwPort(port: number, open: boolean) {
  if (!(await ufwActive())) return
  await run(open ? ['ufw', 'allow', `${port}/tcp`, 'comment', 'webcpl vps ssh'] : ['ufw', '--force', 'delete', 'allow', `${port}/tcp`])
}

async function sshPort(name: string) {
  const listen = (await incus(['config', 'device', 'get', name, 'ssh', 'listen']).catch(() => '')).trim()
  const port = Number(listen.split(':').at(-1))
  return Number.isInteger(port) && port > 0 ? port : null
}

function ipv4(value: unknown) {
  const ip = String(value ?? '')
  const parts = ip.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) throw new Error('Invalid IPv4 address.')
  return ip
}

/** The host interface that carries the default route: routed addresses arrive on it. */
async function defaultInterface() {
  const r = await run(['ip', '-4', 'route', 'show', 'default'])
  const dev = r.stdout.match(/\bdev (\S+)/)?.[1]
  if (!dev || !/^[A-Za-z0-9._-]{1,15}$/.test(dev)) throw new Error('Could not find the server\'s main network interface.')
  return dev
}

async function exec(name: string, script: string, timeout = 60_000, input?: string) {
  return incus(['exec', name, '--', '/bin/sh', '-c', script], { timeout, input })
}

async function setPassword(name: string, password: unknown) {
  const value = String(password ?? '')
  if (value.length < 8 || value.length > 128 || /[\n:]/.test(value)) throw new Error('Invalid password.')
  await exec(name, 'chpasswd', 30_000, `root:${value}\n`)
}

async function addKey(name: string, key: unknown) {
  const value = String(key ?? '').trim()
  if (!value) return
  if (!/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/.test(value)) throw new Error('Invalid SSH key.')
  await exec(name, 'cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys', 30_000, value + '\n')
}

async function waitForNetwork(name: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await stateOf(name).catch(() => null)
    if (state?.ipv4) return state
    await Bun.sleep(2000)
  }
  throw new Error('The VPS did not get a network address in time.')
}

interface IncusInstance {
  name: string
  status: string
  config: Record<string, string>
  state?: {
    status: string
    cpu?: { usage: number }
    memory?: { usage: number }
    disk?: Record<string, { usage: number }>
    network?: Record<string, { addresses: { family: string; address: string; scope: string }[]; counters: { bytes_received: number; bytes_sent: number } }>
  } | null
  snapshots?: { name: string; created_at: string; stateful: boolean }[] | null
}

function summarize(i: IncusInstance) {
  const eth = i.state?.network?.eth0
  const global = (family: string) => eth?.addresses.find((a) => a.family === family && a.scope === 'global')?.address ?? null
  return {
    name: i.name,
    status: (i.state?.status ?? i.status).toLowerCase(),
    ipv4: global('inet'),
    ipv6: global('inet6'),
    cpuNs: i.state?.cpu?.usage ?? 0,
    memoryBytes: i.state?.memory?.usage ?? 0,
    diskBytes: i.state?.disk?.root?.usage ?? null,
    rxBytes: eth?.counters.bytes_received ?? 0,
    txBytes: eth?.counters.bytes_sent ?? 0,
  }
}

async function stateOf(name: string) {
  const raw = JSON.parse(await incus(['query', `/1.0/instances/${name}?recursion=1`], { timeout: 20_000 })) as IncusInstance
  const state = JSON.parse(await incus(['query', `/1.0/instances/${name}/state`], { timeout: 20_000 }))
  return summarize({ ...raw, state })
}

export const vpsOps: Record<string, (args: Args) => Promise<unknown>> = {
  /** Creates and starts an instance, then sets up root access. */
  'vps.create': async (args) => {
    const name = instanceName(args.name)
    const image = vpsImage(args.image)
    if (!image) throw new Error('Unknown operating system.')
    const owner = String(args.owner ?? '')
    if (!/^[a-z][a-z0-9]{2,15}$/.test(owner)) throw new Error('Invalid owner.')
    const port = int(args.ssh_port, 1024, 65535, 'SSH port')
    const r = resources(args)
    await incus([
      'init', `images:${image.alias}`, name,
      '-c', `limits.cpu=${r.cpu}`, '-c', `limits.memory=${r.memory}MiB`, '-c', 'limits.memory.swap=false',
      '-c', 'security.nesting=true', '-c', `user.webcpl.owner=${owner}`,
      '-d', `root,size=${r.disk}GiB`,
    ], { timeout: 15 * 60_000 })
    await incus(['config', 'device', 'add', name, 'ssh', 'proxy', `listen=tcp:0.0.0.0:${port}`, 'connect=tcp:127.0.0.1:22', 'nat=false'])
    await ufwPort(port, true)
    await incus(['start', name], { timeout: 120_000 })
    return { ok: true }
  },
  /** Network, SSH server, root password and key: run after create and after a reinstall. */
  'vps.setup': async (args) => {
    const name = await managed(args.name)
    const state = await waitForNetwork(name)
    await exec(name, SSH_SETUP, 10 * 60_000)
    await setPassword(name, args.password)
    await addKey(name, args.ssh_key)
    return state
  },
  'vps.state': async (args) => {
    const names = ((args.names ?? []) as unknown[]).map(instanceName)
    const all = JSON.parse(await incus(['query', '/1.0/instances?recursion=2'], { timeout: 30_000 })) as IncusInstance[]
    const wanted = new Set(names)
    return Object.fromEntries(all.filter((i) => wanted.has(i.name) && i.config['user.webcpl.owner']).map((i) => [i.name, summarize(i)]))
  },
  'vps.power': async (args) => {
    const name = await managed(args.name)
    const action = String(args.action)
    if (action === 'start') await incus(['start', name])
    else if (action === 'stop') await incus(['stop', name, '--timeout', '30', '--force'], { timeout: 90_000 })
    else if (action === 'restart') await incus(['restart', name, '--timeout', '30', '--force'], { timeout: 120_000 })
    else throw new Error('Unknown action.')
    return { ok: true }
  },
  'vps.resize': async (args) => {
    const name = await managed(args.name)
    const r = resources(args)
    await incus(['config', 'set', name, `limits.cpu=${r.cpu}`, `limits.memory=${r.memory}MiB`])
    await incus(['config', 'device', 'override', name, 'root', `size=${r.disk}GiB`]).catch(() => incus(['config', 'device', 'set', name, 'root', `size=${r.disk}GiB`]))
    return { ok: true }
  },
  'vps.rebuild': async (args) => {
    const name = await managed(args.name)
    const image = vpsImage(args.image)
    if (!image) throw new Error('Unknown operating system.')
    await incus(['stop', name, '--force'], { timeout: 90_000 }).catch(() => {})
    await incus(['rebuild', `images:${image.alias}`, name, '--force'], { timeout: 15 * 60_000 })
    await incus(['start', name])
    return { ok: true }
  },
  'vps.password': async (args) => {
    const name = await managed(args.name)
    await setPassword(name, args.password)
    return { ok: true }
  },
  'vps.delete': async (args) => {
    const name = instanceName(args.name)
    const owner = (await incus(['config', 'get', name, 'user.webcpl.owner'], { timeout: 20_000 }).catch(() => null))
    if (owner === null) return { ok: true } // already gone
    if (!owner.trim()) throw new Error('That VPS does not exist.')
    const port = await sshPort(name)
    await incus(['delete', name, '--force'], { timeout: 120_000 })
    if (port) await ufwPort(port, false)
    return { ok: true }
  },
  /** Slows the network to 1 Mbit/s once the monthly traffic is used up, and back. */
  'vps.throttle': async (args) => {
    const name = await managed(args.name)
    if (args.on) await incus(['config', 'device', 'override', name, 'eth0', 'limits.ingress=1Mbit', 'limits.egress=1Mbit']).catch(() =>
      incus(['config', 'device', 'set', name, 'eth0', 'limits.ingress=1Mbit', 'limits.egress=1Mbit']))
    else await incus(['config', 'device', 'unset', name, 'eth0', 'limits.ingress']).then(() => incus(['config', 'device', 'unset', name, 'eth0', 'limits.egress'])).catch(() => {})
    return { ok: true }
  },
  /** Gives the VPS a public IPv4 address routed to this host (Incus routed NIC). */
  'vps.ip.attach': async (args) => {
    const name = await managed(args.name)
    const ip = ipv4(args.ip)
    const parent = await defaultInterface()
    const device = `ip${ip.replace(/\./g, '-')}`
    await incus(['config', 'device', 'add', name, device, 'nic', 'nictype=routed', `parent=${parent}`, `ipv4.address=${ip}`])
    // A running container picks up the new interface on its next start.
    const state = await stateOf(name).catch(() => null)
    if (state?.status === 'running') await incus(['restart', name, '--timeout', '30', '--force'], { timeout: 120_000 })
    return { ok: true, device }
  },
  'vps.ip.detach': async (args) => {
    const name = await managed(args.name)
    const ip = ipv4(args.ip)
    await incus(['config', 'device', 'remove', name, `ip${ip.replace(/\./g, '-')}`]).catch(() => null)
    return { ok: true }
  },
  'vps.snapshots': async (args) => {
    const name = await managed(args.name)
    const list = JSON.parse(await incus(['query', `/1.0/instances/${name}/snapshots?recursion=1`])) as { name: string; created_at: string; size?: number }[]
    return list.map((s) => ({ name: s.name, createdAt: Date.parse(s.created_at) })).sort((a, b) => b.createdAt - a.createdAt)
  },
  'vps.snapshot': async (args) => {
    const name = await managed(args.name)
    const snap = String(args.snapshot ?? '')
    if (!SNAPSHOT.test(snap)) throw new Error('Invalid snapshot name.')
    const action = String(args.action)
    if (action === 'create') await incus(['snapshot', 'create', name, snap], { timeout: 10 * 60_000 })
    else if (action === 'restore') await incus(['snapshot', 'restore', name, snap], { timeout: 10 * 60_000 })
    else if (action === 'delete') await incus(['snapshot', 'delete', name, snap], { timeout: 5 * 60_000 })
    else throw new Error('Unknown action.')
    return { ok: true }
  },
}

export const managedInstance = managed
