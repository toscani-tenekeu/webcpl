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

## Status

**0.1** — three account levels (admin, reseller, user), hosting, VPS and reseller plans with reseller caps, log in as, suspend, two-factor sign-in, API keys, activity log, server and service overview, English and French.

**0.2**: shared hosting.
- Websites with their own PHP version and PHP-FPM pool per account, `.htaccess`, subdomains, aliases and Let’s Encrypt.
- A DNS zone per domain, MariaDB databases, a file manager, cron jobs and SFTP.
- CPU, memory and process limits per account.

**0.3**: VPS with Incus. Users split their VPS plan across LXC containers on 11 Linux distributions, with SSH through a forwarded port, a browser console, power actions, resizing, reinstalls, snapshots and monthly traffic limits.

**0.4**: more databases.
- PostgreSQL next to MariaDB.
- A private Redis per account, on a socket in the account's home, with memory from the plan.
- SQLite through PHP.
- Adminer at `http://IP/dbadmin/`.

**0.5**: Node.js (20, 22, 24), Python and Ruby apps.
- Each app runs as its account, inside the account's limits, and is restarted by systemd if it stops.
- A website can serve an app, websockets included.
- Dependencies, environment variables and logs are handled from the panel.

**0.6**: mail.
- Mailboxes with quotas, stored in the account's home.
- Forwarders and catch-all addresses.
- DKIM signing and DMARC, with spam filtering by Rspamd.
- SnappyMail webmail at `http://IP/webmail/`.
- Mail needs Dovecot 2.3: Ubuntu 22.04/24.04 and Debian 12.

**0.7**: backups.
- Each account's files, mail, apps and databases, backed up on demand or daily or weekly, with retention.
- Download and restore from the panel.
- An optional off-site copy over SFTP or to S3-compatible storage.
- Backups are stored in `/var/backups/webcpl`.

Next: admin tools (firewall, Fail2ban, monitoring, branding, updates).

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
