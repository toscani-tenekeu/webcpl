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

Next: websites and PHP, DNS, SSL and databases; then VPS, more databases, app runtimes, mail and backups.

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
