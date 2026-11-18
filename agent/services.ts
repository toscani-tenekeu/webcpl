// DNS zones (PowerDNS), MariaDB databases, Let's Encrypt certificates, cron jobs and usage.
import { existsSync, readdirSync, statSync, truncateSync } from 'node:fs'
import { type Args, DB_NAME, domain, must, readText, run, sqlString, username } from './lib.ts'

// ---- DNS (PowerDNS HTTP API on 127.0.0.1) ---------------------------------------------------------

const PDNS = 'http://127.0.0.1:8081/api/v1/servers/localhost'

async function pdns(method: string, path: string, body?: unknown) {
  const key = readText('/etc/webcpl/pdns-api-key').trim()
  if (!key) throw new Error('The DNS server is not installed.')
  const response = await fetch(`${PDNS}${path}`, {
    method,
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`DNS server: ${(() => { try { return JSON.parse(text).error } catch { return text } })() || response.status}`)
  return text ? JSON.parse(text) : null
}

const TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'])
const absolute = (name: string) => (name.endsWith('.') ? name : `${name}.`)

interface RRSet { name: string; type: string; ttl: number; records: { content: string; disabled: boolean }[] }

function cleanRRSets(zone: string, input: unknown): RRSet[] {
  if (!Array.isArray(input)) throw new Error('Invalid records.')
  return input.slice(0, 500).map((raw) => {
    const r = raw as Record<string, unknown>
    const name = absolute(String(r.name ?? '').toLowerCase())
    if (name !== absolute(zone) && !name.endsWith(`.${absolute(zone)}`)) throw new Error(`${name} is not inside ${zone}.`)
    if (!/^(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+$/.test(name)) throw new Error(`Invalid record name: ${name}`)
    const type = String(r.type ?? '').toUpperCase()
    if (!TYPES.has(type)) throw new Error(`Record type ${type} is not supported.`)
    const ttl = Math.max(60, Math.min(86400, Number(r.ttl) || 3600))
    const records = ((r.records ?? []) as unknown[]).map((c) => {
      const content = String(c ?? '').trim()
      if (!content || content.length > 4000 || /[\n\r]/.test(content)) throw new Error(`Invalid value in ${name} ${type}.`)
      return { content, disabled: false }
    })
    return { name, type, ttl, records }
  })
}

export const serviceOps: Record<string, (args: Args) => Promise<unknown>> = {
  'dns.zone.create': async (args) => {
    const zone = domain(args.zone)
    const nameservers = ((args.nameservers ?? []) as unknown[]).map((n) => absolute(domain(n)))
    if (!nameservers.length) throw new Error('A zone needs at least one name server.')
    const existing = await pdns('GET', `/zones/${absolute(zone)}`).catch(() => null)
    if (existing) return { ok: true, existed: true }
    await pdns('POST', '/zones', {
      name: absolute(zone),
      kind: 'Native',
      nameservers,
      rrsets: cleanRRSets(zone, args.rrsets ?? []).map((r) => ({ ...r, changetype: 'REPLACE' })),
    })
    return { ok: true }
  },

  'dns.zone.delete': async (args) => {
    const zone = domain(args.zone)
    await pdns('DELETE', `/zones/${absolute(zone)}`).catch((error: Error) => {
      if (!/not found|Could not find/i.test(error.message)) throw error
    })
    return { ok: true }
  },

  'dns.zone.get': async (args) => {
    const zone = domain(args.zone)
    const data = await pdns('GET', `/zones/${absolute(zone)}`)
    return {
      rrsets: (data.rrsets as RRSet[]).map((r) => ({ name: r.name, type: r.type, ttl: r.ttl, records: r.records.map((x) => x.content) })),
    }
  },

  /** Replaces the given record sets; sets with no values are deleted. SOA is never touched. */
  'dns.rrsets.set': async (args) => {
    const zone = domain(args.zone)
    const rrsets = cleanRRSets(zone, args.rrsets)
    await pdns('PATCH', `/zones/${absolute(zone)}`, {
      rrsets: rrsets.map((r) => (r.records.length ? { ...r, changetype: 'REPLACE' } : { name: r.name, type: r.type, changetype: 'DELETE' })),
    })
    return { ok: true }
  },

  // ---- MariaDB ---------------------------------------------------------------------------------

  'db.create': async (args) => {
    const name = dbName(args.name)
    await sql(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    return { ok: true }
  },

  'db.delete': async (args) => {
    const name = dbName(args.name)
    await sql(`DROP DATABASE IF EXISTS \`${name}\``)
    return { ok: true }
  },

  /** Creates or updates a database user with access to one database. */
  'db.user.set': async (args) => {
    const name = dbName(args.name)
    const database = dbName(args.database)
    const password = String(args.password ?? '')
    const hosts = args.remote === true ? ['localhost', '%'] : ['localhost']
    const statements: string[] = []
    for (const host of ['localhost', '%']) {
      if (!hosts.includes(host)) statements.push(`DROP USER IF EXISTS '${name}'@'${host}'`)
    }
    for (const host of hosts) {
      if (password) {
        if (password.length < 10 || password.length > 200) throw new Error('Use a password of 10 to 200 characters.')
        statements.push(`CREATE USER IF NOT EXISTS '${name}'@'${host}' IDENTIFIED BY ${sqlString(password)}`)
        statements.push(`ALTER USER '${name}'@'${host}' IDENTIFIED BY ${sqlString(password)}`)
      }
      statements.push(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${name}'@'${host}'`)
    }
    await sql(statements.join(';\n'))
    return { ok: true }
  },

  'db.user.delete': async (args) => {
    const name = dbName(args.name)
    await sql(`DROP USER IF EXISTS '${name}'@'localhost'; DROP USER IF EXISTS '${name}'@'%'`)
    return { ok: true }
  },

  /** Size of every database of an account, in bytes. */
  'db.sizes': async (args) => {
    const user = username(args)
    const result = await sql(
      `SELECT table_schema, COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema LIKE '${user}\\_%' GROUP BY table_schema`,
    )
    return Object.fromEntries(result.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, size] = line.split('\t')
      return [name, Number(size) || 0]
    }))
  },

  // ---- SSL (Let's Encrypt, HTTP-01 through the shared acme folder) ---------------------------------------

  'ssl.issue': async (args) => {
    const names = ((args.names ?? []) as unknown[]).map(domain)
    if (!names.length) throw new Error('No name to certify.')
    const email = String(args.email ?? '')
    const result = await run([
      'certbot', 'certonly', '--webroot', '-w', '/var/www/webcpl-acme', '--non-interactive', '--agree-tos', '--keep-until-expiring',
      '--expand', '--cert-name', names[0]!,
      ...(email && /^\S+@\S+\.\S+$/.test(email) ? ['-m', email] : ['--register-unsafely-without-email']),
      ...names.flatMap((n) => ['-d', n]),
    ], { timeout: 300_000 })
    if (!result.ok) {
      const lines = (result.stderr + result.stdout).split('\n').map((l) => l.trim()).filter(Boolean)
      const detail = lines.find((l) => /Detail:|urn:ietf|Challenge failed|not resolve|NXDOMAIN|unauthorized/i.test(l)) ?? lines.at(-1)
      throw new Error(`The certificate could not be issued. Check that the domain points to this server. ${detail ?? ''}`.trim())
    }
    const dir = `/etc/letsencrypt/live/${names[0]}`
    const expiry = await run(['openssl', 'x509', '-enddate', '-noout', '-in', `${dir}/fullchain.pem`])
    return {
      cert: `${dir}/fullchain.pem`,
      key: `${dir}/privkey.pem`,
      expiresAt: Date.parse(expiry.stdout.replace('notAfter=', '').trim()) || null,
    }
  },

  'ssl.delete': async (args) => {
    const name = domain(args.name)
    if (existsSync(`/etc/letsencrypt/live/${name}`)) await run(['certbot', 'delete', '--non-interactive', '--cert-name', name])
    return { ok: true }
  },

  // ---- cron ----------------------------------------------------------------------------------------

  /** Writes the account's whole crontab from the panel's list. */
  'cron.write': async (args) => {
    const user = username(args)
    const jobs = ((args.jobs ?? []) as { schedule?: unknown; command?: unknown }[]).slice(0, 200)
    const lines = ['# Managed by Webcpl: changes made here are replaced from the panel.', 'SHELL=/bin/bash']
    for (const job of jobs) {
      const schedule = String(job.schedule ?? '').trim()
      const command = String(job.command ?? '').trim()
      if (!/^(@(reboot|hourly|daily|weekly|monthly|yearly)|([\d*/,-]+\s+){4}[\d*/,-]+)$/.test(schedule)) throw new Error(`Invalid schedule: ${schedule}`)
      if (!command || command.length > 2000 || /[\n\r]/.test(command)) throw new Error('Invalid command.')
      lines.push(`${schedule} ${command}`)
    }
    if (jobs.length) await must(['crontab', '-u', user, '-'], 'Could not save the cron jobs', { input: lines.join('\n') + '\n' })
    else await run(['crontab', '-r', '-u', user])
    return { ok: true }
  },

  // ---- usage -----------------------------------------------------------------------------------------

  /** Disk used by each account's home folder, in bytes. */
  'usage.disk': async (args) => {
    const users = ((args.users ?? []) as unknown[]).map((u) => username({ user: u }))
    const out: Record<string, number> = {}
    for (const user of users) {
      const result = await run(['du', '-sxb', `/home/${user}`], { timeout: 300_000 })
      out[user] = Number(result.stdout.split('\t')[0]) || 0
    }
    return out
  },

  /** Bytes served per site since the last call; the byte logs are emptied once read. */
  'usage.bandwidth': async () => {
    const out: Record<string, Record<string, number>> = {}
    let accounts: string[] = []
    try {
      accounts = readdirSync('/var/log/webcpl')
    } catch {
      return out
    }
    for (const user of accounts) {
      let files: string[] = []
      try {
        files = readdirSync(`/var/log/webcpl/${user}`).filter((f) => f.endsWith('.bytes.log'))
      } catch {
        continue
      }
      for (const file of files) {
        const path = `/var/log/webcpl/${user}/${file}`
        if (!statSync(path).size) continue
        let total = 0
        for (const line of readText(path).split('\n')) {
          const [sent, received] = line.split(' ')
          total += (Number(sent) || 0) + (Number(received) || 0)
        }
        truncateSync(path, 0)
        ;(out[user] ??= {})[file.replace(/\.bytes\.log$/, '')] = total
      }
    }
    return out
  },
}

function dbName(value: unknown) {
  const name = String(value ?? '')
  if (!DB_NAME.test(name) || name.length > 64) throw new Error('Invalid database name.')
  return name
}

async function sql(statement: string) {
  const result = await run(['mariadb', '--batch', '--skip-column-names', '-e', statement], { timeout: 120_000 })
  if (!result.ok) throw new Error(`MariaDB: ${result.stderr.trim().split('\n').at(-1)}`)
  return result
}
