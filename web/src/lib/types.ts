import type { Limits, PlanKind } from '@shared/limits'

export type Role = 'admin' | 'reseller' | 'user'

export interface PlanRef {
  id: number
  name: string
  limits: Limits
}

export interface Account {
  id: number
  username: string
  email: string
  role: Role
  owner: { id: number; username: string; role: Role } | null
  suspended: boolean
  suspendedReason: string
  mustChangePassword: boolean
  totpEnabled: boolean
  hostingPlan: PlanRef | null
  vpsPlan: PlanRef | null
  resellerPlan: PlanRef | null
  note: string
  createdAt: number
  lastLoginAt: number | null
  /** Resellers: how many accounts they have. */
  accounts?: number | null
}

export interface Plan {
  id: number
  kind: PlanKind
  name: string
  limits: Limits
  accounts: number
  createdAt: number
}

export interface ResellerUsage {
  caps: Limits
  used: Record<string, number | null>
}

export interface ActivityEvent {
  id: number
  at: number
  action: string
  detail: string
  ip: string
  actor: string | null
  subject: string | null
}

export interface ComponentStatus {
  id: string
  label: string
  description: string
  installed: boolean
  upcoming?: boolean
  services: { name: string; state: string }[]
}

export interface ServerInfo {
  hostname: string
  os: string
  kernel: string
  arch: string
  uptime: number
  cpu: { count: number; model: string; load: number[] }
  memory: { total: number; free: number }
  disk: { total: number; free: number } | null
  addresses: { address: string; family: 4 | 6; interface: string }[]
}

export interface Website {
  id: number
  name: string
  parentId: number | null
  docroot: string
  php: string
  aliases: string[]
  ssl: { expiresAt: number | null } | null
  forceHttps: boolean
  createdAt: number
}

export interface HostingInfo {
  username: string
  address: string
  hostname: string | null
  previewUrl: string
  sftp: { host: string; port: number; username: string; ssh: boolean }
  phpVersions: string[]
  phpSettings: Record<string, string | boolean>
  limits: Record<string, number | boolean | null>
  usage: {
    diskBytes: number | null
    diskMeasuredAt: number | null
    bandwidthBytes: number
    domains: number
    subdomains: number
    databases: number
    cron_jobs: number
  }
}

export interface RRSet {
  name: string
  type: string
  ttl: number
  records: string[]
}

export interface FileEntry {
  name: string
  type: 'dir' | 'file' | 'link'
  size: number
  modified: number
  mode: string
  owner: string
  target: string | null
}

export interface Vps {
  id: number
  userId: number
  owner?: string
  name: string
  image: { id: string; name: string; version: string }
  vcpu: number
  memoryMb: number
  diskGb: number
  sshPort: number
  status: 'creating' | 'ready' | 'error' | 'deleting'
  progress: string | null
  error: string | null
  state: string | null
  ipv4: string | null
  ipv6: string | null
  memoryBytes: number | null
  diskBytes: number | null
  cpuNs: number | null
  trafficBytes: number
  throttled: boolean
  createdAt: number
}

export interface VpsRoom {
  used: { vcpu: number; memory_mb: number; disk_gb: number }
  left: { vcpu: number | null; memory_mb: number | null; disk_gb: number | null }
}

export interface VpsImageInfo { id: string; name: string; version: string }
