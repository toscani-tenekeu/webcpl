<div align="center">

<img src="docs/logo.svg" alt="Webcpl" width="80" height="80">

# Webcpl

**Open-source web hosting control panel.**<br>
Shared hosting and LXC VPS on your own servers, for admins, resellers and users.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/toscani-tenekeu/webcpl?style=flat-square&color=171717)](package.json)
[![Debian · Ubuntu](https://img.shields.io/badge/debian%20%C2%B7%20ubuntu-supported-A81D33?style=flat-square&logo=debian&logoColor=white)](#install)

</div>

## Install

On a fresh **Debian 12/13** or **Ubuntu 22.04/24.04** server (64-bit), as root:

```bash
curl -fsSL https://raw.githubusercontent.com/toscani-tenekeu/webcpl/main/install.sh | sudo bash
```

Choose the components when asked, or add `--yes` to keep the defaults. Then open `http://SERVER_IP:7777` and sign in as `admin` with the password the installer prints. No domain name is needed.

| Component | Default | Option |
| --- | --- | --- |
| Web server (nginx + Apache) and PHP | on | `--php "8.3 8.4"` |
| MariaDB | on | `--without-mariadb` |
| DNS server (PowerDNS) | on | `--without-dns` |
| VPS hosting (Incus/LXC) | on | `--without-vps` |
| PostgreSQL, Redis | off | `--with-postgresql`, `--with-redis` |
| Node.js, Python, Ruby | off | `--with-node`, `--with-python`, `--with-ruby` |
| Mail, FTP | off | `--with-mail`, `--with-ftp` |

Other options: `--port N` (default `7777`).

## Features

- **Accounts.** Admin, resellers and users. Plans for hosting, VPS and resellers, with reseller caps. Users can be suspended, and admins can log in as them. Two-factor sign-in, API keys and an activity log. English and French.
- **Websites.** nginx in front of Apache (`.htaccess` works), a PHP version and PHP-FPM pool per account, subdomains, aliases and Let's Encrypt. CPU, memory and process limits per account.
- **DNS.** A PowerDNS zone per domain, with DKIM and DMARC records.
- **Databases.** MariaDB, PostgreSQL, a private Redis per account and SQLite. Adminer at `/dbadmin/`.
- **Apps.** Node.js 20, 22 and 24, Python and Ruby, each running as its account behind a website, with websockets.
- **Mail.** Mailboxes stored in the account's home, forwarders, catch-all addresses, Rspamd and SnappyMail webmail at `/webmail/`.
- **Files.** A file manager in the browser, SFTP, FTP over TLS, and cron jobs.
- **VPS.** LXC containers with Incus, on 11 distributions. Includes a browser console, resizing, reinstalls, snapshots and monthly traffic limits.
- **Backups.** Files, mail and databases, backed up on demand or on a schedule. Download and restore from the panel, with an optional off-site copy over SFTP or to S3.
- **Server.** UFW firewall rules, Fail2ban, system and Webcpl updates, a certificate for the hostname (HTTPS for the panel and mail), and 24-hour charts of CPU, memory, disk and network.

## Limits

- Mail needs Dovecot 2.3: Ubuntu 22.04/24.04 or Debian 12. On Debian 13, mail is skipped.
- A VPS is reached through a forwarded SSH port. Dedicated public IPs are not assigned yet.

## Manage

```bash
sudo webcpl status | update | restart | logs | reset-admin-password
```

## Develop

```bash
bun install && bun run build
sudo bun run dev:agent   # root agent on /run/webcpl/agent.sock
bun run dev              # panel on :7777
```

The panel runs as the unprivileged `webcpl` user; every system change goes through the root agent, which only accepts a fixed list of operations.

## License

[AGPL-3.0](LICENSE)
