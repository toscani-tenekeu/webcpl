// The server software Webcpl can install. The installer records the choices in
// /etc/webcpl/components.json; the agent reports their state from it.

export interface ComponentChoice {
  web: boolean
  php: string[]
  node: boolean
  python: boolean
  ruby: boolean
  mariadb: boolean
  postgresql: boolean
  redis: boolean
  dns: boolean
  ftp: boolean
  mail: boolean
  vps: boolean
}

export const DEFAULT_CHOICE: ComponentChoice = {
  web: true,
  php: ['8.3'],
  node: false,
  python: false,
  ruby: false,
  mariadb: true,
  postgresql: false,
  redis: false,
  dns: true,
  ftp: false,
  mail: false,
  vps: true,
}

export const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4']

export interface ComponentInfo {
  id: string
  label: string
  description: string
  /** systemd services that make up the component. */
  services: string[]
  /** The panel does not manage it yet: it arrives in a later version. */
  upcoming?: boolean
}

export function componentList(choice: ComponentChoice): (ComponentInfo & { installed: boolean })[] {
  return [
    {
      id: 'web', installed: choice.web, label: 'Web server', description: 'nginx in front, Apache behind it for .htaccess support',
      services: ['nginx', 'apache2'],
    },
    {
      id: 'php', installed: choice.php.length > 0, label: `PHP ${choice.php.join(', ')}`.trim(),
      description: 'One PHP-FPM service per version; each website picks its version',
      services: choice.php.map((version) => `php${version}-fpm`),
    },
    { id: 'node', installed: choice.node, label: 'Node.js', description: 'Node.js applications behind nginx', services: [], upcoming: true },
    { id: 'python', installed: choice.python, label: 'Python', description: 'Python applications behind nginx', services: [], upcoming: true },
    { id: 'ruby', installed: choice.ruby, label: 'Ruby', description: 'Ruby applications behind nginx', services: [], upcoming: true },
    { id: 'mariadb', installed: choice.mariadb, label: 'MariaDB', description: 'MySQL-compatible databases', services: ['mariadb'] },
    { id: 'postgresql', installed: choice.postgresql, label: 'PostgreSQL', description: 'PostgreSQL databases', services: ['postgresql'], upcoming: true },
    { id: 'redis', installed: choice.redis, label: 'Redis', description: 'A private Redis instance per account', services: [], upcoming: true },
    { id: 'dns', installed: choice.dns, label: 'DNS server', description: 'PowerDNS, authoritative for the hosted domains', services: ['pdns'] },
    { id: 'ftp', installed: choice.ftp, label: 'FTP', description: 'Pure-FTPd, for clients without SFTP', services: ['pure-ftpd'] },
    {
      id: 'mail', installed: choice.mail, label: 'Mail server', description: 'Postfix, Dovecot and Rspamd',
      services: ['postfix', 'dovecot', 'rspamd'], upcoming: true,
    },
    { id: 'vps', installed: choice.vps, label: 'VPS (LXC)', description: 'Incus containers sold as VPS', services: ['incus'] },
  ]
}
