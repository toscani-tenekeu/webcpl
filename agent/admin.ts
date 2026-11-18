// Server administration: firewall, Fail2ban, updates, the hostname's certificate, metrics.
import { existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs'
import os from 'node:os'
import { type Args, DOMAIN, must, run, writeAtomic } from './lib.ts'

const PANEL_PORT = Number(process.env.WEBCPL_PORT || 7777)
/** Ports that keep the server reachable: never closed from the panel. */
const PROTECTED = new Set([22, PANEL_PORT])
const HOST_SSL = '/etc/webcpl/ssl/host'

async function ufw(args: string[]) {
  if (!Bun.which('ufw')) throw new Error('UFW is not installed.')
  return run(['ufw', ...args], { timeout: 60_000 })
}

function port(value: unknown) {
  const text = String(value ?? '').trim()
  const m = text.match(/^(\d{1,5})(?::(\d{1,5}))?$/)
  if (!m) throw new Error('Give a port like 8080 or a range like 3000:3100.')
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  if (a < 1 || b > 65535 || b < a) throw new Error('Ports go from 1 to 65535.')
  return { text: m[2] ? `${a}:${b}` : String(a), from: a, to: b }
}

function source(value: unknown) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(text)) throw new Error('Give an IP address or network, like 203.0.113.5 or 203.0.113.0/24.')
  return text
}

/** `ufw show added` lists rules as the commands that made them: easy to show and to undo. */
async function rules() {
  const r = await ufw(['show', 'added'])
  return r.stdout.split('\n').filter((l) => l.startsWith('ufw ')).map((l) => l.slice(4).trim())
}

function meminfo() {
  const text = readFileSync('/proc/meminfo', 'utf8')
  const kb = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024
  return { total: kb('MemTotal'), available: kb('MemAvailable') }
}

function netBytes() {
  let rx = 0
  let tx = 0
  for (const line of readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const [name, data] = line.split(':')
    if (!data || /^(lo|veth|docker|br-|incusbr|lxdbr|virbr)/.test(name!.trim())) continue
    const f = data.trim().split(/\s+/).map(Number)
    rx += f[0] ?? 0
    tx += f[8] ?? 0
  }
  return { rx, tx }
}

export const adminOps: Record<string, (args: Args) => Promise<unknown>> = {
  // ---- firewall --------------------------------------------------------------------------------------
  'firewall.status': async () => {
    if (!Bun.which('ufw')) return { installed: false, active: false, rules: [] }
    const status = await ufw(['status'])
    return { installed: true, active: /Status: active/.test(status.stdout), rules: await rules() }
  },
  'firewall.enable': async (args) => {
    if (args.on) {
      // Never lock the admin out: SSH and the panel are allowed before turning it on.
      for (const p of PROTECTED) await ufw(['allow', `${p}/tcp`])
      await must(['ufw', '--force', 'enable'], 'Could not turn the firewall on')
    } else await must(['ufw', 'disable'], 'Could not turn the firewall off')
    return { ok: true }
  },
  'firewall.add': async (args) => {
    const action = args.action === 'deny' ? 'deny' : 'allow'
    const p = port(args.port)
    const proto = ['tcp', 'udp'].includes(String(args.proto)) ? String(args.proto) : 'tcp'
    const from = source(args.from)
    if (action === 'deny' && [...PROTECTED].some((x) => x >= p.from && x <= p.to) && !from) throw new Error('SSH and the panel cannot be blocked for everyone.')
    const cmd = from ? [action, 'from', from, 'to', 'any', 'port', p.text, 'proto', proto] : [action, `${p.text}/${proto}`]
    const r = await ufw(cmd)
    if (!r.ok) throw new Error(r.stderr.trim() || 'The rule was refused.')
    return { ok: true }
  },
  'firewall.delete': async (args) => {
    const rule = String(args.rule ?? '')
    if (!(await rules()).includes(rule)) throw new Error('That rule does not exist.')
    const parts = rule.split(/\s+/)
    if (parts[0] === 'allow' && parts.length === 2 && PROTECTED.has(Number(parts[1]!.split('/')[0]))) throw new Error('SSH and the panel stay open.')
    const r = await ufw(['delete', ...parts])
    if (!r.ok) throw new Error(r.stderr.trim() || 'The rule could not be removed.')
    return { ok: true }
  },

  // ---- Fail2ban --------------------------------------------------------------------------------------
  'fail2ban.status': async () => {
    if (!Bun.which('fail2ban-client')) return { installed: false, jails: [] }
    const r = await run(['fail2ban-client', 'status'])
    if (!r.ok) return { installed: true, running: false, jails: [] }
    const names = (r.stdout.match(/Jail list:\s*(.*)/)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const jails = []
    for (const name of names) {
      const s = await run(['fail2ban-client', 'status', name])
      jails.push({
        name,
        failed: Number(s.stdout.match(/Currently failed:\s*(\d+)/)?.[1] ?? 0),
        banned: (s.stdout.match(/Banned IP list:\s*(.*)/)?.[1] ?? '').split(/\s+/).filter(Boolean),
        total: Number(s.stdout.match(/Total banned:\s*(\d+)/)?.[1] ?? 0),
      })
    }
    return { installed: true, running: true, jails }
  },
  'fail2ban.unban': async (args) => {
    const ip = source(args.ip)
    if (!ip || ip.includes('/')) throw new Error('Give one IP address.')
    await must(['fail2ban-client', 'unban', ip], 'Could not unban that address')
    return { ok: true }
  },

  // ---- updates ---------------------------------------------------------------------------------------
  'updates.check': async () => {
    await run(['apt-get', 'update', '-q'], { timeout: 5 * 60_000 })
    const r = await run(['apt', 'list', '--upgradable'], { timeout: 60_000 })
    const packages = r.stdout.split('\n').filter((l) => l.includes('[upgradable')).map((l) => {
      const [name, version] = l.split(/\s+/)
      return { name: name!.split('/')[0]!, version: version ?? '', security: /-security/.test(l) }
    })
    return { packages, rebootRequired: existsSync('/var/run/reboot-required') }
  },
  /** Long jobs run as their own systemd units, so they survive the panel or agent restarting. */
  'updates.start': async (args) => {
    const kind = args.kind === 'webcpl' ? 'webcpl' : 'system'
    const unit = kind === 'webcpl' ? 'webcpl-self-update' : 'webcpl-system-upgrade'
    const state = (await run(['systemctl', 'is-active', unit])).stdout.trim()
    if (state === 'active' || state === 'activating') throw new Error('An update is already running.')
    await run(['systemctl', 'reset-failed', unit])
    const cmd = kind === 'webcpl'
      ? ['/usr/local/bin/webcpl', 'update']
      : ['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', '-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'upgrade']
    await must(['systemd-run', `--unit=${unit}`, '--collect', '--property=TimeoutStartSec=2h', ...cmd], 'Could not start the update')
    return { ok: true }
  },
  'updates.job': async (args) => {
    const unit = args.kind === 'webcpl' ? 'webcpl-self-update' : 'webcpl-system-upgrade'
    const state = (await run(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'Result'])).stdout
    const log = await run(['journalctl', '-u', unit, '-n', '40', '--no-pager', '-o', 'cat'], { timeout: 20_000 })
    return {
      state: state.match(/ActiveState=(\w+)/)?.[1] ?? 'inactive',
      result: state.match(/Result=(\w+)/)?.[1] ?? '',
      log: log.stdout.slice(-8000),
    }
  },

  // ---- the hostname's certificate --------------------------------------------------------------------
  /** Gets a certificate for the hostname and gives it to the panel and to mail. */
  'ssl.hostname': async (args) => {
    const host = String(args.hostname ?? '').toLowerCase()
    if (!DOMAIN.test(host)) throw new Error('Set a full hostname like panel.example.com first.')
    const email = String(args.email ?? '')
    const r = await run(['certbot', 'certonly', '--webroot', '-w', '/var/www/webcpl-acme', '-d', host, '--non-interactive', '--agree-tos', '--keep-until-expiring',
      ...(email ? ['-m', email] : ['--register-unsafely-without-email'])], { timeout: 5 * 60_000 })
    if (!r.ok) throw new Error(`The certificate could not be issued. Check that ${host} points to this server. ${(r.stderr.match(/Detail: (.*)/)?.[1] ?? '').trim()}`)
    // Renewals copy the new files over and reload the services that use them.
    const hook = `#!/bin/sh
# Written by Webcpl: hands the hostname's certificate to the panel and to mail after each renewal.
set -e
[ "$RENEWED_LINEAGE" = "/etc/letsencrypt/live/${host}" ] || exit 0
install -d -m 0750 -o root -g webcpl ${HOST_SSL}
install -m 0640 -o root -g webcpl "$RENEWED_LINEAGE/fullchain.pem" ${HOST_SSL}/cert.pem
install -m 0640 -o root -g webcpl "$RENEWED_LINEAGE/privkey.pem" ${HOST_SSL}/key.pem
if [ -f /etc/webcpl/mail/cert.pem ]; then
  install -m 0644 "$RENEWED_LINEAGE/fullchain.pem" /etc/webcpl/mail/cert.pem
  install -m 0600 "$RENEWED_LINEAGE/privkey.pem" /etc/webcpl/mail/key.pem
  systemctl reload postfix dovecot 2>/dev/null || true
fi
systemctl restart webcpl 2>/dev/null || true
`
    mkdirSync('/etc/letsencrypt/renewal-hooks/deploy', { recursive: true })
    writeAtomic('/etc/letsencrypt/renewal-hooks/deploy/webcpl-hostname', hook, 0o755)
    await must(['env', `RENEWED_LINEAGE=/etc/letsencrypt/live/${host}`, '/etc/letsencrypt/renewal-hooks/deploy/webcpl-hostname'], 'Could not install the certificate')
    return { ok: true }
  },
  'ssl.hostname.status': async () => {
    const cert = `${HOST_SSL}/cert.pem`
    if (!existsSync(cert)) return { installed: false }
    const r = await run(['openssl', 'x509', '-in', cert, '-noout', '-subject', '-enddate'])
    return {
      installed: true,
      subject: r.stdout.match(/CN\s*=\s*([^\s,/]+)/)?.[1] ?? '',
      expiresAt: Date.parse(r.stdout.match(/notAfter=(.*)/)?.[1] ?? ''),
    }
  },
  /** Turns HTTPS on the panel's port on or off, then restarts the panel. */
  'panel.tls': async (args) => {
    if (args.on && !existsSync(`${HOST_SSL}/cert.pem`)) throw new Error('Get a certificate for the hostname first.')
    const file = '/etc/webcpl/webcpl.env'
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('WEBCPL_TLS='))
    if (args.on) lines.push('WEBCPL_TLS=1')
    writeAtomic(file, lines.join('\n') + '\n', 0o640)
    await run(['chgrp', 'webcpl', file])
    // Restarted a moment later, so this answer reaches the panel first.
    await run(['systemd-run', '--on-active=2', '--unit=webcpl-restart', '--collect', 'systemctl', 'restart', 'webcpl'])
    return { ok: true }
  },

  // ---- metrics ---------------------------------------------------------------------------------------
  'system.metrics': async () => {
    const mem = meminfo()
    const fs = statfsSync('/')
    return {
      load: os.loadavg()[0],
      cpus: os.cpus().length,
      memUsed: mem.total - mem.available,
      memTotal: mem.total,
      diskUsed: (fs.blocks - fs.bfree) * fs.bsize,
      diskTotal: fs.blocks * fs.bsize,
      ...netBytes(),
    }
  },
}
