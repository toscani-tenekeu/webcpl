// Shared hosting accounts: Linux user, PHP-FPM services, resource limits and websites.
import { chownSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { type Args, domain, homePath, ids, must, phpVersion, readText, removeFile, run, username, writeAtomic } from './lib.ts'

const SYSTEMD = '/etc/systemd/system'
const NGINX_SITES = '/etc/nginx/sites-enabled'
const APACHE_SITES = '/etc/apache2/sites-enabled'
const PREVIEW_DIR = '/etc/apache2/webcpl-preview'
const PHP_CONF = '/etc/webcpl/php'
const LOGS = '/var/log/webcpl'
const ACME_ROOT = '/var/www/webcpl-acme'

interface Limits {
  cpu_percent?: number | null
  memory_mb?: number | null
  processes?: number | null
}

// ---- configuration changes, tested before they are applied --------------------------------------

interface Change {
  path: string
  /** null removes the file. */
  content: string | null
}

/** Writes the changes, checks nginx and Apache, and reloads them; on any failure the old files come back. */
async function applyWebConfig(changes: Change[]) {
  const before = changes.map((c) => ({ path: c.path, content: existsSync(c.path) ? readText(c.path) : null }))
  const write = (list: Change[]) => {
    for (const c of list) {
      if (c.content === null) removeFile(c.path)
      else writeAtomic(c.path, c.content)
    }
  }
  write(changes)
  const nginx = await run(['nginx', '-t'])
  const apache = await run(['apache2ctl', 'configtest'])
  if (!nginx.ok || !apache.ok) {
    write(before)
    const reason = (!nginx.ok ? nginx.stderr : apache.stderr).trim().split('\n').filter((l) => !/syntax is ok|test is successful/.test(l)).slice(-2).join(' ')
    throw new Error(`The web server configuration was refused, nothing was changed: ${reason}`)
  }
  await must(['systemctl', 'reload', 'apache2'], 'Apache did not reload')
  await must(['systemctl', 'reload', 'nginx'], 'nginx did not reload')
}

// ---- accounts ---------------------------------------------------------------------------------------

function sliceUnit(user: string, limits: Limits) {
  const lines = ['[Unit]', `Description=Webcpl account ${user}`, '', '[Slice]']
  if (limits.cpu_percent) lines.push(`CPUQuota=${limits.cpu_percent}%`)
  if (limits.memory_mb) lines.push(`MemoryMax=${limits.memory_mb}M`)
  if (limits.processes) lines.push(`TasksMax=${limits.processes}`)
  return lines.join('\n') + '\n'
}

/** The same limits apply to the account's PHP, its SSH sessions and its cron jobs. */
async function applyLimits(user: string, limits: Limits) {
  const { uid } = await ids(user)
  const slice = sliceUnit(user, limits)
  writeAtomic(`${SYSTEMD}/webcpl-${user}.slice`, slice)
  writeAtomic(`${SYSTEMD}/user-${uid}.slice.d/webcpl.conf`, slice.replace(/^\[Unit\][\s\S]*?\[Slice\]/, '[Slice]'))
  await run(['systemctl', 'daemon-reload'])
}

async function setShell(user: string, ssh: boolean) {
  await must(['usermod', '-s', ssh ? '/bin/bash' : '/usr/sbin/nologin', user], 'Could not set the shell')
  // Without SSH, the account can still use SFTP: the group makes sshd force internal-sftp.
  await run(['gpasswd', ssh ? '-d' : '-a', user, 'webcpl-sftp'])
}

export const hostingOps: Record<string, (args: Args) => Promise<unknown>> = {
  /** The password file of one protected folder: bcrypt hashes made by the panel. */
  'htpasswd.write': async (args) => {
    const user = username(args)
    const file = htpasswdPath(user, args.file)
    const entries = ((args.entries ?? []) as Record<string, unknown>[]).map((e) => {
      const name = String(e.name ?? '')
      const hash = String(e.hash ?? '')
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(name) || !/^\$2y\$\d\d\$[./A-Za-z0-9]{53}$/.test(hash)) throw new Error('Invalid username or password hash.')
      return `${name}:${hash}`
    })
    mkdirSync(`/etc/webcpl/htpasswd/${user}`, { recursive: true, mode: 0o750 })
    await must(['chgrp', 'www-data', `/etc/webcpl/htpasswd/${user}`], 'chgrp htpasswd')
    writeAtomic(file, entries.join('\n') + '\n', 0o640)
    await must(['chgrp', 'www-data', file], 'chgrp htpasswd')
    return { ok: true }
  },
  'htpasswd.delete': async (args) => {
    const user = username(args)
    removeFile(htpasswdPath(user, args.file))
    return { ok: true }
  },
  /** A GoAccess report of a site's visitors, from its nginx access log. */
  'stats.report': async (args) => {
    const user = username(args)
    const name = domain(args.name)
    if (!Bun.which('goaccess')) throw new Error('Visitor statistics need GoAccess, which is not installed.')
    const logs = [`${LOGS}/${user}/${name}.access.log`, `${LOGS}/${user}/${name}.access.log.1`].filter((f) => existsSync(f))
    if (!logs.length) throw new Error('This website has no visits recorded yet.')
    const r = await run(['goaccess', ...logs, '--log-format=COMBINED', '--no-global-config', '-o', 'html', '--html-report-title', name], { timeout: 120_000 })
    if (!r.ok) throw new Error(`The report could not be made: ${r.stderr.trim().split('\n').at(-1)}`)
    return { html: r.stdout }
  },

  'account.create': async (args) => {
    const user = username(args)
    const password = String(args.password ?? '')
    if (password.length < 10) throw new Error('A password of at least 10 characters is needed.')
    if (!(await run(['id', user])).ok) {
      // A group left behind by an older removal would make useradd fail.
      if ((await run(['getent', 'group', user])).ok) await must(['groupdel', user], 'Could not remove a leftover group')
      await must(['useradd', '--create-home', '--home-dir', `/home/${user}`, '--user-group', '--shell', '/usr/sbin/nologin', user], 'Could not create the Linux user')
    }
    const { uid, gid } = await ids(user)
    const home = `/home/${user}`
    await must(['chmod', '0710', home], 'chmod home')
    // Apache reads the sites as www-data: it joins the account's group, which can only traverse the home folder.
    await run(['usermod', '-aG', user, 'www-data'])
    for (const [dir, mode] of [['domains', 0o755], ['tmp', 0o700], ['logs', 0o750]] as const) {
      const path = `${home}/${dir}`
      mkdirSync(path, { recursive: true, mode })
      chownSync(path, uid, gid)
    }
    // nginx and Apache write their logs as root, so those live outside the home folder where the
    // account cannot plant links; it reads them through ~/access-logs. PHP's own logs go to ~/logs.
    mkdirSync(`${LOGS}/${user}`, { recursive: true })
    await must(['chown', `root:${user}`, `${LOGS}/${user}`], 'chown logs')
    await must(['chmod', '0750', `${LOGS}/${user}`], 'chmod logs')
    if (!existsSync(`${home}/access-logs`)) symlinkSync(`${LOGS}/${user}`, `${home}/access-logs`)
    await must(['chpasswd'], 'Could not set the password', { input: `${user}:${password}\n` })
    await setShell(user, args.ssh === true)
    await applyLimits(user, (args.limits ?? {}) as Limits)
    return { user, uid }
  },

  'account.password': async (args) => {
    const user = username(args)
    const password = String(args.password ?? '')
    if (password.length < 10) throw new Error('A password of at least 10 characters is needed.')
    await must(['chpasswd'], 'Could not set the password', { input: `${user}:${password}\n` })
    return { ok: true }
  },

  'account.limits': async (args) => {
    const user = username(args)
    await setShell(user, args.ssh === true)
    await applyLimits(user, (args.limits ?? {}) as Limits)
    await run(['systemctl', 'restart', `webcpl-${user}.slice`])
    return { ok: true }
  },

  'account.suspend': async (args) => {
    const user = username(args)
    await must(['usermod', '--lock', '--expiredate', '1', user], 'Could not lock the account')
    await run(['systemctl', 'stop', ...phpUnits(user)])
    await run(['pkill', '-KILL', '-u', user])
    return { ok: true }
  },

  'account.unsuspend': async (args) => {
    const user = username(args)
    await must(['usermod', '--unlock', '--expiredate', '', user], 'Could not unlock the account')
    const units = phpUnits(user)
    if (units.length) await run(['systemctl', 'start', ...units])
    return { ok: true }
  },

  'account.delete': async (args) => {
    const user = username(args)
    rmSync(`/etc/webcpl/htpasswd/${user}`, { recursive: true, force: true })
    if (!(await run(['id', user])).ok) return { ok: true }
    const { uid } = await ids(user)
    const units = phpUnits(user)
    if (units.length) await run(['systemctl', 'disable', '--now', ...units])
    for (const unit of units) removeFile(`${SYSTEMD}/${unit}`)
    for (const file of listFiles(PHP_CONF).filter((f) => f.startsWith(`${user}-`))) removeFile(`${PHP_CONF}/${file}`)
    await run(['crontab', '-r', '-u', user])
    await run(['pkill', '-KILL', '-u', user])
    const changes: Change[] = [
      ...listFiles(NGINX_SITES).filter((f) => f.startsWith(`webcpl-${user}-`)).map((f) => ({ path: `${NGINX_SITES}/${f}`, content: null })),
      ...listFiles(APACHE_SITES).filter((f) => f.startsWith(`webcpl-${user}-`)).map((f) => ({ path: `${APACHE_SITES}/${f}`, content: null })),
      { path: `${PREVIEW_DIR}/${user}.conf`, content: null },
    ]
    await applyWebConfig(changes)
    // www-data joined the account's group to read its sites; it leaves first so the group goes too.
    await run(['gpasswd', '-d', 'www-data', user])
    await must(['userdel', '--remove', user], 'Could not remove the Linux user')
    if ((await run(['getent', 'group', user])).ok) await run(['groupdel', user])
    await run(['rm', '-rf', `${LOGS}/${user}`])
    removeFile(`${SYSTEMD}/webcpl-${user}.slice`)
    await run(['rm', '-rf', `${SYSTEMD}/user-${uid}.slice.d`])
    await run(['systemctl', 'daemon-reload'])
    return { ok: true }
  },

  // ---- PHP ------------------------------------------------------------------------------------

  /** One PHP-FPM service per account and PHP version in use, inside the account's slice. */
  'php.sync': async (args) => {
    const user = username(args)
    const versions = [...new Set(((args.versions ?? []) as unknown[]).map(phpVersion))]
    const settings = (args.settings ?? {}) as Record<string, unknown>
    const maxChildren = Math.max(2, Math.min(50, Number(args.maxChildren) || 5))
    const home = `/home/${user}`
    const ini: string[] = []
    for (const [key, pattern] of [
      ['memory_limit', /^\d{2,5}M$/], ['upload_max_filesize', /^\d{1,5}M$/], ['post_max_size', /^\d{1,5}M$/],
      ['max_execution_time', /^\d{1,4}$/], ['max_input_vars', /^\d{3,6}$/],
    ] as const) {
      const value = String(settings[key] ?? '')
      if (value && pattern.test(value)) ini.push(`php_value[${key}] = ${value}`)
    }
    if (settings.display_errors === true) ini.push('php_flag[display_errors] = on')

    const wanted = new Set(versions.map((v) => unitName(user, v)))
    for (const unit of phpUnits(user)) {
      if (wanted.has(unit)) continue
      await run(['systemctl', 'disable', '--now', unit])
      removeFile(`${SYSTEMD}/${unit}`)
      removeFile(`${PHP_CONF}/${unit.replace(/^webcpl-php-/, '').replace(/\.service$/, '')}.conf`)
    }
    for (const v of versions) {
      if (!existsSync(`/usr/sbin/php-fpm${v}`)) throw new Error(`PHP ${v} is not installed on this server.`)
      const id = `${user}-${v}`
      const conf = `[global]
pid = /run/webcpl-php-${id}/php-fpm.pid
error_log = ${home}/logs/php-fpm-${v}.log
daemonize = no

[${user}]
user = ${user}
group = ${user}
listen = /run/webcpl-php-${id}/php.sock
listen.mode = 0660
pm = ondemand
pm.max_children = ${maxChildren}
pm.process_idle_timeout = 20s
pm.max_requests = 500
php_admin_value[open_basedir] = ${home}/:/tmp/:/usr/share/php/:/dev/urandom
php_admin_value[upload_tmp_dir] = ${home}/tmp
php_admin_value[session.save_path] = ${home}/tmp
php_admin_value[sys_temp_dir] = ${home}/tmp
php_admin_value[error_log] = ${home}/logs/php-error.log
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec
${ini.join('\n')}
`
      const unit = `[Unit]
Description=PHP ${v} for ${user}
After=network.target

[Service]
User=${user}
Group=${user}
Slice=webcpl-${user}.slice
RuntimeDirectory=webcpl-php-${id}
RuntimeDirectoryMode=0750
ExecStart=/usr/sbin/php-fpm${v} --nodaemonize --fpm-config ${PHP_CONF}/${id}.conf
ExecReload=/bin/kill -USR2 $MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
`
      const confChanged = readText(`${PHP_CONF}/${id}.conf`) !== conf
      const unitChanged = readText(`${SYSTEMD}/${unitName(user, v)}`) !== unit
      writeAtomic(`${PHP_CONF}/${id}.conf`, conf)
      writeAtomic(`${SYSTEMD}/${unitName(user, v)}`, unit)
      if (unitChanged) await run(['systemctl', 'daemon-reload'])
      // Tested as the account, the way the service runs it.
      const test = await run(['runuser', '-u', user, '--', `/usr/sbin/php-fpm${v}`, '--test', '--fpm-config', `${PHP_CONF}/${id}.conf`])
      if (!test.ok) throw new Error(`PHP ${v} settings were refused: ${(test.stderr + test.stdout).trim().split('\n').filter((l) => /ERROR|error/.test(l)).slice(-2).join(' ')}`)
      await must(['systemctl', 'enable', unitName(user, v)], 'Could not enable PHP')
      await must(['systemctl', confChanged || unitChanged ? 'restart' : 'start', unitName(user, v)], `PHP ${v} did not start`)
    }
    return { versions }
  },

  // ---- websites ---------------------------------------------------------------------------------

  'site.write': async (args) => {
    const user = username(args)
    const site = siteFrom(user, args.site)
    if (site.overBandwidth && !existsSync('/var/www/webcpl-default/webcpl-bandwidth.html')) writeAtomic('/var/www/webcpl-default/webcpl-bandwidth.html', BANDWIDTH_PAGE)
    // Websockets to apps need this map once; older installs did not write it.
    if (site.appPort && !existsSync('/etc/nginx/conf.d/webcpl-upgrade.conf')) {
      writeAtomic('/etc/nginx/conf.d/webcpl-upgrade.conf', "map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n")
    }
    await applyWebConfig(siteChanges(user, site))
    // The document root is created on first use, with a page that says the site works.
    const root = site.docroot
    if (!existsSync(root)) {
      await must(['runuser', '-u', user, '--', 'mkdir', '-p', root], 'Could not create the site folder')
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${site.name}</title></head><body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh"><main><h1>${site.name}</h1><p>This website is ready. Upload your files to <code>${root.replace(`/home/${user}/`, '~/')}</code>.</p></main></body></html>\n`
      await must(['runuser', '-u', user, '--', 'tee', `${root}/index.html`], 'Could not write the welcome page', { input: page })
    }
    return { ok: true }
  },

  'site.delete': async (args) => {
    const user = username(args)
    const name = domain(args.name)
    await applyWebConfig([
      { path: `${NGINX_SITES}/webcpl-${user}-${name}.conf`, content: null },
      { path: `${APACHE_SITES}/webcpl-${user}-${name}.conf`, content: null },
    ])
    return { ok: true }
  },

  /** http://IP/~user shows the account's first website before any domain points to the server. */
  'preview.write': async (args) => {
    const user = username(args)
    if (!args.docroot) {
      await applyWebConfig([{ path: `${PREVIEW_DIR}/${user}.conf`, content: null }])
      return { ok: true }
    }
    const docroot = homePath(user, args.docroot)
    const php = phpVersion(args.php)
    await applyWebConfig([{
      path: `${PREVIEW_DIR}/${user}.conf`,
      content: `Alias /~${user} ${docroot}
<Directory ${docroot}>
    AllowOverride All
    Options -Indexes +SymLinksIfOwnerMatch
    Require all granted
    <FilesMatch "\\.php$">
        SetHandler "proxy:unix:/run/webcpl-php-${user}-${php}/php.sock|fcgi://localhost"
    </FilesMatch>
</Directory>
`,
    }])
    return { ok: true }
  },
}

// ---- helpers ------------------------------------------------------------------------------------

const unitName = (user: string, version: string) => `webcpl-php-${user}-${version}.service`

function listFiles(dir: string) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function phpUnits(user: string) {
  return listFiles(SYSTEMD).filter((f) => f.startsWith(`webcpl-php-${user}-`) && f.endsWith('.service'))
}

interface Site {
  name: string
  aliases: string[]
  docroot: string
  php: string
  ssl: { cert: string; key: string } | null
  forceHttps: boolean
  suspended: boolean
  /** Out of monthly bandwidth: the site answers 509 until the next month. */
  overBandwidth: boolean
  /** The whole site sends visitors elsewhere. */
  redirect: { to: string; code: 301 | 302; keepPath: boolean } | null
  /** Folders behind a username and password (Apache basic auth). */
  protected: { path: string; file: string }[]
  /** Pages shown for errors, relative to the site's folder. */
  errorPages: Record<string, string>
  /** Set when the site is served by one of the account's apps instead of PHP. */
  appPort: number | null
}

const BANDWIDTH_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bandwidth limit reached</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}main{text-align:center;max-width:32rem;padding:1rem}</style></head>
<body><main><h1>This website used its monthly bandwidth</h1><p>It comes back at the start of next month, or sooner if its owner raises the limit.</p></main></body></html>
`

function siteFrom(user: string, input: unknown): Site {
  const s = (input ?? {}) as Record<string, unknown>
  const ssl = s.ssl as { cert?: unknown; key?: unknown } | null
  const certPath = (p: unknown) => {
    const path = String(p ?? '')
    if (!/^\/etc\/(letsencrypt\/live|webcpl\/ssl)\/[a-z0-9.-]+\/[a-z0-9.]+\.pem$/.test(path)) throw new Error('Invalid certificate path.')
    return path
  }
  return {
    name: domain(s.name),
    aliases: ((s.aliases ?? []) as unknown[]).map(domain).slice(0, 50),
    docroot: homePath(user, s.docroot),
    php: phpVersion(s.php),
    ssl: ssl ? { cert: certPath(ssl.cert), key: certPath(ssl.key) } : null,
    forceHttps: s.forceHttps === true && !!ssl,
    suspended: s.suspended === true,
    overBandwidth: s.overBandwidth === true,
    redirect: redirectFrom(s.redirect),
    protected: ((s.protected ?? []) as Record<string, unknown>[]).slice(0, 50).map((p) => ({ path: webPath(p.path), file: htpasswdPath(user, p.file) })),
    errorPages: Object.fromEntries(Object.entries((s.errorPages ?? {}) as Record<string, unknown>)
      .filter(([code]) => ['403', '404', '500', '503'].includes(code)).map(([code, page]) => [code, webPath(page)])),
    appPort: appPort(s.appPort),
  }
}

function redirectFrom(value: unknown): Site['redirect'] {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const to = String(r.to ?? '')
  if (!/^https?:\/\/[^\s"'`$\\{};<>]+$/.test(to) || to.length > 500) throw new Error('Invalid redirect address.')
  return { to: to.replace(/\/+$/, ''), code: r.code === 302 ? 302 : 301, keepPath: r.keepPath !== false }
}

function webPath(value: unknown) {
  const path = String(value ?? '')
  if (!/^\/[A-Za-z0-9._~\/-]{0,200}$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid path.')
  return path
}

function htpasswdPath(user: string, value: unknown) {
  const file = String(value ?? '')
  if (!new RegExp(`^/etc/webcpl/htpasswd/${user}/[a-z0-9.-]+-[0-9]+$`).test(file)) throw new Error('Invalid password file.')
  return file
}

function appPort(value: unknown) {
  if (value === null || value === undefined) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 30000 || port > 39999) throw new Error('Invalid app port.')
  return port
}

function siteChanges(user: string, site: Site): Change[] {
  const names = [site.name, ...site.aliases].join(' ')
  const logs = `${LOGS}/${user}/${site.name}`
  const acme = `    location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }`
  const body = site.suspended
    ? `    location / { return 503; }\n    error_page 503 /webcpl-suspended.html;\n    location = /webcpl-suspended.html { root /var/www/webcpl-default; internal; }`
    : site.redirect
    ? `    location / { return ${site.redirect.code} ${site.redirect.to}${site.redirect.keepPath ? '$request_uri' : ''}; }`
    : site.overBandwidth
    ? `    location / { return 509; }\n    error_page 509 /webcpl-bandwidth.html;\n    location = /webcpl-bandwidth.html { root /var/www/webcpl-default; internal; }`
    : site.appPort
    ? `    location / {
        proxy_pass http://127.0.0.1:${site.appPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }`
    : `    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }`
  const common = `    server_name ${names};
    access_log ${logs}.access.log;
    access_log ${logs}.bytes.log webcpl_bytes;
    error_log ${logs}.error.log;
    client_max_body_size 256m;
${acme}`
  const http = site.forceHttps
    ? `server {\n    listen 80;\n    listen [::]:80;\n${common}\n    location / { return 301 https://$host$request_uri; }\n}\n`
    : `server {\n    listen 80;\n    listen [::]:80;\n${common}\n${body}\n}\n`
  const https = site.ssl
    ? `server {\n    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;\n    ssl_certificate ${site.ssl.cert};\n    ssl_certificate_key ${site.ssl.key};\n${common}\n${body}\n}\n`
    : ''
  const apache = `<VirtualHost 127.0.0.1:8080>
    ServerName ${site.name}
${site.aliases.length ? `    ServerAlias ${site.aliases.join(' ')}\n` : ''}    DocumentRoot ${site.docroot}
    ErrorLog ${logs}.apache-error.log
    <Directory ${site.docroot}>
        AllowOverride All
        Options -Indexes +SymLinksIfOwnerMatch
        Require all granted
    </Directory>
${Object.entries(site.errorPages).map(([code, page]) => `    ErrorDocument ${code} ${page}\n`).join('')}${site.protected.map((p) => `    <Location "${p.path}">
        AuthType Basic
        AuthName "Restricted"
        AuthUserFile ${p.file}
        Require valid-user
    </Location>
`).join('')}    <FilesMatch "\\.php$">
        SetHandler "proxy:unix:/run/webcpl-php-${user}-${site.php}/php.sock|fcgi://localhost"
    </FilesMatch>
</VirtualHost>
`
  return [
    { path: `${NGINX_SITES}/webcpl-${user}-${site.name}.conf`, content: `# Managed by Webcpl.\n${http}${https}` },
    { path: `${APACHE_SITES}/webcpl-${user}-${site.name}.conf`, content: `# Managed by Webcpl.\n${apache}` },
  ]
}
