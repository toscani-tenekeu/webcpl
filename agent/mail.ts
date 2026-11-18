// Mail: Postfix routes, Dovecot stores (in each account's home, as the account), Rspamd
// filters and signs. The panel sends the whole picture; the agent rewrites the maps from it.
import { existsSync } from 'node:fs'
import { type Args, DOMAIN, USERNAME, domain, ids, must, removeFile, run, writeAtomic } from './lib.ts'

const POSTFIX = '/etc/postfix/webcpl'
const USERS = '/etc/dovecot/webcpl-users'
const DKIM = '/var/lib/rspamd/dkim'
const LOCAL = /^[a-z0-9][a-z0-9._+-]{0,63}$/

interface Mailbox { address: string; hash: string; user: string; quotaMb: number; enabled: boolean }
interface Alias { source: string; destinations: string[] }

function address(value: unknown, allowCatchAll = false) {
  const text = String(value ?? '').toLowerCase()
  const at = text.lastIndexOf('@')
  const local = text.slice(0, at)
  const dom = text.slice(at + 1)
  if (at < 0 || !DOMAIN.test(dom) || !(LOCAL.test(local) || (allowCatchAll && local === ''))) throw new Error(`Invalid address: ${text}`)
  return text
}

/** Any outside address a forwarder may send to. */
function destination(value: unknown) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!/^[^\s@,:]{1,64}@[a-z0-9.-]{3,253}$/.test(text)) throw new Error(`Invalid destination: ${text}`)
  return text
}

function mailboxes(input: unknown): Mailbox[] {
  return ((input ?? []) as Record<string, unknown>[]).map((m) => {
    const hash = String(m.hash ?? '')
    if (!/^\$argon2id\$v=19\$[a-z0-9=,]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(hash)) throw new Error('Invalid password hash.')
    const user = String(m.user ?? '')
    if (!USERNAME.test(user)) throw new Error('Invalid account.')
    const quota = Number(m.quotaMb)
    return { address: address(m.address), hash, user, quotaMb: Number.isInteger(quota) && quota > 0 ? quota : 0, enabled: m.enabled !== false }
  })
}

const homeOf = (m: Mailbox) => {
  const [local, dom] = m.address.split('@')
  return `/home/${m.user}/mail/${dom}/${local}`
}

async function postmap(name: string, lines: string[]) {
  writeAtomic(`${POSTFIX}/${name}`, lines.join('\n') + (lines.length ? '\n' : ''))
  await must(['postmap', `${POSTFIX}/${name}`], `postmap ${name}`)
}

async function publicKey(dom: string) {
  const b64 = await run(['sh', '-c', 'openssl rsa -in "$1" -pubout -outform der 2>/dev/null | base64 -w0', 'sh', `${DKIM}/${dom}.webcpl.key`])
  if (!b64.ok || !b64.stdout.trim()) throw new Error('Could not read the DKIM key.')
  return `v=DKIM1; k=rsa; p=${b64.stdout.trim()}`
}

export const mailOps: Record<string, (args: Args) => Promise<unknown>> = {
  /** Rewrites every map and the mailbox list, and creates missing mail folders. */
  'mail.write': async (args) => {
    const domains = [...new Set(((args.domains ?? []) as unknown[]).map(domain))]
    const boxes = mailboxes(args.mailboxes)
    const aliases: Alias[] = ((args.aliases ?? []) as Record<string, unknown>[]).map((a) => ({
      source: address(a.source, true),
      destinations: ((a.destinations ?? []) as unknown[]).map(destination).slice(0, 50),
    })).filter((a) => a.destinations.length)
    const inDomains = (addr: string) => domains.includes(addr.split('@')[1]!)
    if (![...boxes.map((b) => b.address), ...aliases.map((a) => a.source)].every(inDomains)) throw new Error('An address is outside the mail domains.')

    const lines: string[] = []
    for (const m of boxes) {
      const { uid, gid } = await ids(m.user)
      const home = homeOf(m)
      if (!existsSync(home)) await must(['runuser', '-u', m.user, '--', 'mkdir', '-p', '-m', '0700', home], 'Could not create the mail folder')
      const quota = m.quotaMb ? `userdb_quota_rule=*:storage=${m.quotaMb}M` : ''
      // A suspended mailbox keeps receiving but cannot sign in.
      lines.push(`${m.address}:${m.enabled ? '' : '!'}{ARGON2ID}${m.hash}:${uid}:${gid}::${home}::${quota}`)
    }
    writeAtomic(USERS, lines.join('\n') + '\n', 0o640)
    await must(['chown', 'root:dovecot', USERS], 'chown dovecot users')

    await postmap('domains', domains.map((d) => `${d} OK`))
    await postmap('mailboxes', boxes.map((m) => `${m.address} OK`))
    // A mailbox that also forwards keeps its own copy.
    await postmap('aliases', aliases.map((a) => {
      const keep = boxes.some((m) => m.address === a.source) ? [a.source] : []
      return `${a.source} ${[...keep, ...a.destinations].join(',')}`
    }))
    await postmap('senders', boxes.map((m) => `${m.address} ${m.address}`))
    await run(['postfix', 'reload'])
    return { ok: true }
  },

  /** Makes sure the domain has a DKIM key and returns its DNS record. */
  'mail.dkim': async (args) => {
    const dom = domain(args.domain)
    const key = `${DKIM}/${dom}.webcpl.key`
    if (!existsSync(key)) {
      await must(['openssl', 'genrsa', '-out', key, '2048'], 'Could not create the DKIM key')
      await must(['chown', '_rspamd:_rspamd', key], 'chown dkim')
      await must(['chmod', '0600', key], 'chmod dkim')
    }
    return { selector: 'webcpl', record: await publicKey(dom) }
  },
  'mail.dkim.delete': async (args) => {
    removeFile(`${DKIM}/${domain(args.domain)}.webcpl.key`)
    return { ok: true }
  },

  /** Removes a mailbox's messages from the account's home. */
  'mail.purge': async (args) => {
    const user = String(args.user ?? '')
    if (!USERNAME.test(user)) throw new Error('Invalid account.')
    const addr = address(args.address)
    const [local, dom] = addr.split('@')
    await run(['runuser', '-u', user, '--', 'rm', '-rf', '--', `/home/${user}/mail/${dom}/${local}`])
    return { ok: true }
  },

  /** Storage used by each mailbox, from Dovecot's quota. */
  'mail.usage': async (args) => {
    const out: Record<string, number> = {}
    for (const a of ((args.addresses ?? []) as unknown[]).map((x) => address(x))) {
      const r = await run(['doveadm', '-f', 'tab', 'quota', 'get', '-u', a])
      const row = r.stdout.split('\n').find((l) => l.includes('STORAGE'))
      out[a] = row ? Number(row.split('\t')[2]) * 1024 : 0
    }
    return out
  },
}

