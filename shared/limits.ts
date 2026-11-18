// Plan limits, shared by the panel and the interface. A missing or null value means unlimited.

export type PlanKind = 'hosting' | 'vps' | 'reseller'
export type Limits = Record<string, number | boolean | null>

export interface LimitField {
  key: string
  label: string
  unit?: string
  /** 'number' limits can be unlimited; 'flag' limits are on or off. */
  type: 'number' | 'flag'
  /** For reseller plans: the hosting or VPS limit this cap is the total of. */
  sums?: { kind: 'hosting' | 'vps'; key: string }
  hint?: string
}

export const LIMITS: Record<PlanKind, LimitField[]> = {
  hosting: [
    { key: 'disk_mb', label: 'Disk space', unit: 'MB', type: 'number' },
    { key: 'bandwidth_gb', label: 'Monthly bandwidth', unit: 'GB', type: 'number' },
    { key: 'domains', label: 'Domains', type: 'number' },
    { key: 'subdomains', label: 'Subdomains', type: 'number' },
    { key: 'databases', label: 'Databases', type: 'number' },
    { key: 'mailboxes', label: 'Mailboxes', type: 'number' },
    { key: 'ftp_accounts', label: 'FTP accounts', type: 'number' },
    { key: 'cron_jobs', label: 'Cron jobs', type: 'number' },
    { key: 'cpu_percent', label: 'CPU', unit: '% of one core', type: 'number', hint: '100 is one full core' },
    { key: 'memory_mb', label: 'Memory', unit: 'MB', type: 'number' },
    { key: 'processes', label: 'Processes', type: 'number' },
    { key: 'inodes', label: 'Files (inodes)', type: 'number' },
    { key: 'ssh', label: 'SSH access', type: 'flag' },
    { key: 'apps', label: 'Node.js, Python and Ruby apps', type: 'flag' },
  ],
  vps: [
    { key: 'vcpu', label: 'vCPU', type: 'number' },
    { key: 'memory_mb', label: 'Memory', unit: 'MB', type: 'number' },
    { key: 'disk_gb', label: 'Disk', unit: 'GB', type: 'number' },
    { key: 'traffic_gb', label: 'Monthly traffic', unit: 'GB', type: 'number' },
    { key: 'snapshots', label: 'Snapshots', type: 'number' },
    { key: 'ipv4', label: 'Public IPv4 addresses', type: 'number', hint: '0: reachable through a forwarded SSH port only' },
  ],
  reseller: [
    { key: 'users', label: 'Accounts', type: 'number' },
    { key: 'disk_mb', label: 'Total disk space', unit: 'MB', type: 'number', sums: { kind: 'hosting', key: 'disk_mb' } },
    { key: 'bandwidth_gb', label: 'Total bandwidth', unit: 'GB', type: 'number', sums: { kind: 'hosting', key: 'bandwidth_gb' } },
    { key: 'domains', label: 'Total domains', type: 'number', sums: { kind: 'hosting', key: 'domains' } },
    { key: 'databases', label: 'Total databases', type: 'number', sums: { kind: 'hosting', key: 'databases' } },
    { key: 'mailboxes', label: 'Total mailboxes', type: 'number', sums: { kind: 'hosting', key: 'mailboxes' } },
    { key: 'vps_vcpu', label: 'Total VPS vCPU', type: 'number', sums: { kind: 'vps', key: 'vcpu' } },
    { key: 'vps_memory_mb', label: 'Total VPS memory', unit: 'MB', type: 'number', sums: { kind: 'vps', key: 'memory_mb' } },
    { key: 'vps_disk_gb', label: 'Total VPS disk', unit: 'GB', type: 'number', sums: { kind: 'vps', key: 'disk_gb' } },
    { key: 'oversell', label: 'Allow overselling', type: 'flag', hint: 'Plans may promise more in total than the caps above' },
  ],
}

/** Keeps only known keys, with numbers as non-negative integers or null, and flags as booleans. */
export function cleanLimits(kind: PlanKind, input: unknown): { limits: Limits } | { error: string } {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const limits: Limits = {}
  for (const field of LIMITS[kind]) {
    const value = source[field.key]
    if (field.type === 'flag') {
      limits[field.key] = value === true
      continue
    }
    if (value === null || value === undefined || value === '') {
      limits[field.key] = null
      continue
    }
    const number = Number(value)
    if (!Number.isInteger(number) || number < 0 || number > 1e12) return { error: `${field.label} must be a whole number.` }
    limits[field.key] = number
  }
  return { limits }
}
