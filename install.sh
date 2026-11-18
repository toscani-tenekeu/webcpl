#!/usr/bin/env bash
# Webcpl installer.
#
#   curl -fsSL https://raw.githubusercontent.com/toscani-tenekeu/webcpl/main/install.sh | sudo bash
#   sudo bash install.sh --yes --with-node --with-postgresql --php "8.3 8.4"
#
# Run without --yes to choose the components interactively. Options:
#   --yes                    no questions, defaults plus the flags given
#   --port N                 panel port (default 7777)
#   --php "8.3 8.4"          PHP versions (8.1 to 8.4; default 8.3)
#   --with-X / --without-X   X is one of: node python ruby mariadb postgresql redis dns ftp mail vps
# Environment: WEBCPL_REPO (git URL or local path), WEBCPL_BRANCH (default main).
set -Eeuo pipefail

REPO="${WEBCPL_REPO:-https://github.com/toscani-tenekeu/webcpl.git}"
BRANCH="${WEBCPL_BRANCH:-main}"
APP=/opt/webcpl
CONF=/etc/webcpl
DATA=/var/lib/webcpl
PORT=7777
ASSUME_YES=0

# Defaults: shared hosting with PHP, MariaDB, DNS and VPS on; the rest off.
declare -A WANT=([node]=0 [python]=0 [ruby]=0 [mariadb]=1 [postgresql]=0 [redis]=0 [dns]=1 [ftp]=0 [mail]=0 [vps]=1)
PHP_VERSIONS="8.3"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "the installation stopped at line $LINENO. Fix the problem above and run the installer again; it is safe to re-run."' ERR

# ---- options ------------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --port) PORT="${2:?}"; shift ;;
    --php) PHP_VERSIONS="${2:?}"; shift ;;
    --with-*) key="${1#--with-}"; [ -n "${WANT[$key]+x}" ] || die "unknown component: $key"; WANT[$key]=1 ;;
    --without-*) key="${1#--without-}"; [ -n "${WANT[$key]+x}" ] || die "unknown component: $key"; WANT[$key]=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || die "--port must be between 1024 and 65535."
for v in $PHP_VERSIONS; do [[ "$v" =~ ^8\.[1-4]$ ]] || die "PHP $v is not offered (choose from 8.1, 8.2, 8.3, 8.4)."; done

# ---- checks -------------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "run the installer as root (sudo)."
[ -r /etc/os-release ] || die "cannot identify the operating system."
. /etc/os-release
CODENAME="${VERSION_CODENAME:-}"
case "${ID}:${VERSION_ID}" in
  debian:12|debian:13|ubuntu:22.04|ubuntu:24.04) ;;
  *) die "Webcpl supports Debian 12 and 13, and Ubuntu 22.04 and 24.04. This is ${PRETTY_NAME}." ;;
esac
case "$(uname -m)" in x86_64|aarch64) ;; *) die "Webcpl needs a 64-bit x86 or ARM processor." ;; esac
[ -d /run/systemd/system ] || die "systemd must be running."
if [ -d "$CONF" ] && [ -f "$CONF/components.json" ] && [ ! -d "$APP/.git" ]; then die "$CONF exists from another installation. Remove it first."; fi

# ---- choices ------------------------------------------------------------------------------

ask() { # ask "question" default(0/1) -> sets REPLY_BOOL
  local q="$1" def="$2" hint answer
  hint=$([ "$def" = 1 ] && echo "Y/n" || echo "y/N")
  read -r -p "    $q [$hint] " answer </dev/tty || answer=""
  case "${answer,,}" in y|yes|o|oui) REPLY_BOOL=1 ;; n|no|non) REPLY_BOOL=0 ;; *) REPLY_BOOL=$def ;; esac
}

if [ "$ASSUME_YES" = 0 ] && [ -e /dev/tty ] && (: </dev/tty) 2>/dev/null; then
  say "Choose what to install (Enter keeps the default)"
  read -r -p "    PHP versions, from 8.1 8.2 8.3 8.4 [$PHP_VERSIONS] " answer </dev/tty || answer=""
  if [ -n "$answer" ]; then PHP_VERSIONS="$answer"; fi
  for v in $PHP_VERSIONS; do [[ "$v" =~ ^8\.[1-4]$ ]] || die "PHP $v is not offered."; done
  declare -A LABEL=([node]="Node.js apps" [python]="Python apps" [ruby]="Ruby apps" [mariadb]="MariaDB" [postgresql]="PostgreSQL"
    [redis]="Redis" [dns]="DNS server (PowerDNS)" [ftp]="FTP server (SFTP is always available)" [mail]="Mail server" [vps]="VPS hosting (LXC with Incus)")
  for key in mariadb postgresql redis node python ruby dns ftp mail vps; do
    ask "${LABEL[$key]}?" "${WANT[$key]}"; WANT[$key]=$REPLY_BOOL
  done
fi

say "Installing Webcpl on ${PRETTY_NAME}"
note "Panel port: $PORT    PHP: $PHP_VERSIONS"
for key in mariadb postgresql redis node python ruby dns ftp mail vps; do if [ "${WANT[$key]}" = 1 ]; then note "+ $key"; fi; done

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
APT=(apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
FAILED=()

# A component that fails to install is reported at the end; the rest carries on.
component() { # component name function
  local name="$1"; shift
  say "Installing $name"
  if ( set +e; trap - ERR; "$@" ); then return 0; fi
  warn "$name could not be installed; Webcpl continues without it."
  FAILED+=("$name")
  return 1
}

# ---- base -----------------------------------------------------------------------------------

say "Installing base packages"
apt-get update -q
"${APT[@]}" install ca-certificates curl git zip unzip gnupg lsb-release acl sudo openssh-server zstd rclone ufw fail2ban python3-systemd goaccess

if ! command -v bun >/dev/null && [ ! -x /usr/local/bin/bun ]; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
fi
BUN=/usr/local/bin/bun
[ -x "$BUN" ] || BUN="$(command -v bun)"
"$BUN" --version >/dev/null || die "Bun does not run on this system."

id webcpl >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin webcpl

# Accounts without SSH in their plan can still use SFTP: this group gets SFTP only.
getent group webcpl-sftp >/dev/null || groupadd --system webcpl-sftp
if [ -d /etc/ssh/sshd_config.d ] && [ ! -f /etc/ssh/sshd_config.d/50-webcpl.conf ]; then
  cat > /etc/ssh/sshd_config.d/50-webcpl.conf <<'SSHD'
# Written by the Webcpl installer.
Match Group webcpl-sftp
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
SSHD
  sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true)
fi
install -d -m 755 "$CONF"
install -d -m 700 -o webcpl -g webcpl "$DATA"
install -d -m 750 -o root -g webcpl /var/backups/webcpl

# ---- components -------------------------------------------------------------------------------

install_web() {
  "${APT[@]}" install nginx apache2 certbot || return 1
  # Apache sits behind nginx on the loopback, so .htaccess works while nginx serves the outside.
  sed -i 's/^Listen 80$/Listen 127.0.0.1:8080/; s/^\(\s*\)Listen 443$/\1# Listen 443 (nginx handles TLS)/' /etc/apache2/ports.conf
  a2enmod -q proxy_fcgi setenvif rewrite headers remoteip expires alias >/dev/null
  cat > /etc/apache2/conf-available/webcpl.conf <<'APACHE'
# Written by the Webcpl installer: visitors' real addresses come from nginx.
RemoteIPHeader X-Forwarded-For
RemoteIPInternalProxy 127.0.0.1
ServerTokens Prod
ServerSignature Off
APACHE
  a2enconf -q webcpl >/dev/null
  install -d /etc/apache2/webcpl-preview
  # The first virtual host answers for the server's IP: previews of accounts (http://IP/~user).
  cat > /etc/apache2/sites-available/000-default.conf <<'APACHE'
<VirtualHost 127.0.0.1:8080>
    ServerName webcpl-default
    DocumentRoot /var/www/webcpl-default
    IncludeOptional /etc/apache2/webcpl-preview/*.conf
</VirtualHost>
APACHE
  a2ensite -q 000-default >/dev/null
  install -d /var/www/webcpl-default /var/www/webcpl-acme /var/log/webcpl
  cat > /var/www/webcpl-default/index.html <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Webcpl</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}main{text-align:center}</style></head>
<body><main><h1>It works</h1><p>This server is managed with Webcpl. No website is set up on this address yet.</p></main></body></html>
HTML
  cat > /var/www/webcpl-default/webcpl-suspended.html <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suspended</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}main{text-align:center}</style></head>
<body><main><h1>This website is suspended</h1><p>Please contact the website's owner.</p></main></body></html>
HTML
  cat > /var/www/webcpl-default/webcpl-bandwidth.html <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bandwidth limit reached</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}main{text-align:center;max-width:32rem;padding:1rem}</style></head>
<body><main><h1>This website used its monthly bandwidth</h1><p>It comes back at the start of next month, or sooner if its owner raises the limit.</p></main></body></html>
HTML
  cat > /etc/nginx/conf.d/webcpl.conf <<'NGINX'
# Written by the Webcpl installer.
log_format webcpl_bytes '$bytes_sent $request_length';
server_names_hash_bucket_size 128;
server_tokens off;
NGINX
  cat > /etc/nginx/sites-available/webcpl-default <<'NGINX'
# Answers for addresses and names that no website claims yet.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/webcpl-default;
    client_max_body_size 256m;
    location /.well-known/acme-challenge/ { root /var/www/webcpl-acme; }
    # Account previews (http://IP/~user) are served by Apache with the account's PHP.
    location ~ ^/~[a-z] {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    include /etc/nginx/webcpl/*.conf;
    location / { try_files $uri /index.html; }
}
NGINX
  install -d /etc/nginx/webcpl
  rm -f /etc/nginx/sites-enabled/default
  ln -sf /etc/nginx/sites-available/webcpl-default /etc/nginx/sites-enabled/webcpl-default
  nginx -t -q && systemctl reload-or-restart nginx && apache2ctl configtest && systemctl restart apache2 && systemctl enable -q nginx apache2
}

php_repo() {
  if [ "$ID" = ubuntu ]; then
    "${APT[@]}" install software-properties-common && add-apt-repository -y ppa:ondrej/php >/dev/null
  else
    curl -fsSLo /tmp/sury.deb https://packages.sury.org/debsuryorg-archive-keyring.deb && dpkg -i /tmp/sury.deb >/dev/null &&
      echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $CODENAME main" > /etc/apt/sources.list.d/php.list
  fi
  apt-get update -q
}

install_php() {
  php_repo || warn "the PHP repository could not be added; only the system's own PHP version is available."
  local v pkgs=()
  for v in $PHP_VERSIONS; do
    for ext in fpm cli common mysql pgsql sqlite3 curl gd mbstring xml zip intl bcmath opcache readline; do pkgs+=("php$v-$ext"); done
  done
  "${APT[@]}" install "${pkgs[@]}" || return 1
  for v in $PHP_VERSIONS; do systemctl enable -q --now "php$v-fpm"; done
}

install_mariadb() { "${APT[@]}" install mariadb-server mariadb-client && systemctl enable -q --now mariadb; }
install_postgresql() { "${APT[@]}" install postgresql && systemctl enable -q --now postgresql; }

install_redis() {
  # Each account gets its own instance later; the shared default one stays off.
  "${APT[@]}" install redis-server && systemctl disable -q --now redis-server
}

install_dns() {
  "${APT[@]}" install pdns-server pdns-backend-sqlite3 sqlite3 || return 1
  # PowerDNS needs port 53, which systemd-resolved's local stub holds on Ubuntu.
  if systemctl is-active -q systemd-resolved; then
    install -d /etc/systemd/resolved.conf.d
    printf '[Resolve]\nDNSStubListener=no\n' > /etc/systemd/resolved.conf.d/webcpl.conf
    systemctl restart systemd-resolved
    ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
  fi
  rm -f /etc/powerdns/pdns.d/bind.conf
  local db=/var/lib/powerdns/pdns.sqlite3 key
  install -d -o pdns -g pdns /var/lib/powerdns
  if [ ! -s "$db" ]; then sqlite3 "$db" < /usr/share/pdns-backend-sqlite3/schema/schema.sqlite3.sql && chown pdns:pdns "$db"; fi
  key=$(cat "$CONF/pdns-api-key" 2>/dev/null || head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9)
  printf '%s\n' "$key" > "$CONF/pdns-api-key" && chmod 600 "$CONF/pdns-api-key"
  # Only the server's own addresses: binding every address would take port 53 from the
  # DNS service Incus and other bridges run for their containers.
  local listen
  listen=$(ip -o addr show scope global | awk '$2 !~ /^(lo|docker|br-|veth|virbr|lxdbr|incusbr)/ {split($4, a, "/"); print a[1]}' | paste -sd, -)
  [ -n "$listen" ] || listen="0.0.0.0"
  cat > /etc/powerdns/pdns.d/webcpl.conf <<PDNS
# Written by the Webcpl installer.
launch=gsqlite3
gsqlite3-database=$db
local-address=$listen
api=yes
api-key=$key
webserver=yes
webserver-address=127.0.0.1
webserver-port=8081
webserver-allow-from=127.0.0.1,::1
PDNS
  systemctl enable -q pdns && systemctl restart pdns
}

# FTP for the hosting accounts with their own panel password: each one is locked in its
# home, TLS is offered, passive ports are 40000-40100. SFTP stays the better choice.
install_ftp() {
  "${APT[@]}" install pure-ftpd || return 1
  local c=/etc/pure-ftpd/conf
  echo yes > $c/ChrootEveryone
  echo yes > $c/NoAnonymous
  echo 1000 > $c/MinUID
  echo "40000 40100" > $c/PassivePortRange
  echo 1 > $c/TLS
  echo yes > $c/DontResolve
  echo no > $c/PAMAuthentication
  echo yes > $c/UnixAuthentication
  if [ ! -f /etc/ssl/private/pure-ftpd.pem ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$(hostname -f 2>/dev/null || hostname)" \
      -keyout /etc/ssl/private/pure-ftpd.pem -out /etc/ssl/private/pure-ftpd.pem >/dev/null 2>&1
    chmod 0600 /etc/ssl/private/pure-ftpd.pem
  fi
  systemctl enable -q pure-ftpd && systemctl restart pure-ftpd
}

install_mail() {
  echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
  echo "postfix postfix/mailname string $(hostname -f 2>/dev/null || hostname)" | debconf-set-selections
  "${APT[@]}" install postfix dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-sieve dovecot-managesieved rspamd redis-server ssl-cert || return 1
  install -d -m 0755 /etc/postfix/webcpl /etc/webcpl/mail
  # A certificate for mail until the hostname gets a real one.
  if [ ! -f /etc/webcpl/mail/cert.pem ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$(hostname -f 2>/dev/null || hostname)" \
      -keyout /etc/webcpl/mail/key.pem -out /etc/webcpl/mail/cert.pem >/dev/null 2>&1 || return 1
    chmod 0600 /etc/webcpl/mail/key.pem
  fi
  for f in domains mailboxes aliases; do [ -f "/etc/postfix/webcpl/$f" ] || : > "/etc/postfix/webcpl/$f"; postmap "/etc/postfix/webcpl/$f"; done
  [ -f /etc/dovecot/webcpl-users ] || install -m 0640 -o root -g dovecot /dev/null /etc/dovecot/webcpl-users

  postconf -e "myhostname = $(hostname -f 2>/dev/null || hostname)" "mydestination = localhost" \
    "smtpd_tls_cert_file = /etc/webcpl/mail/cert.pem" "smtpd_tls_key_file = /etc/webcpl/mail/key.pem" \
    "smtpd_tls_security_level = may" "smtp_tls_security_level = may" "smtpd_tls_auth_only = yes" \
    "virtual_mailbox_domains = hash:/etc/postfix/webcpl/domains" \
    "virtual_mailbox_maps = hash:/etc/postfix/webcpl/mailboxes" \
    "virtual_alias_maps = hash:/etc/postfix/webcpl/aliases" \
    "virtual_transport = lmtp:unix:private/dovecot-lmtp" \
    "smtpd_sasl_type = dovecot" "smtpd_sasl_path = private/auth" \
    "smtpd_sender_login_maps = hash:/etc/postfix/webcpl/senders" \
    "smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination" \
    "smtpd_milters = inet:127.0.0.1:11332" "non_smtpd_milters = inet:127.0.0.1:11332" \
    "milter_default_action = accept" "milter_protocol = 6" "message_size_limit = 52428800"
  [ -f /etc/postfix/webcpl/senders ] || : > /etc/postfix/webcpl/senders; postmap /etc/postfix/webcpl/senders
  # Submission (587, STARTTLS) and SMTPS (465) for mail clients: signed-in senders only.
  for svc in submission smtps; do
    postconf -M "$svc/inet=$svc inet n - y - - smtpd"
    postconf -P "$svc/inet/syslog_name=postfix/$svc" "$svc/inet/smtpd_sasl_auth_enable=yes" \
      "$svc/inet/smtpd_client_restrictions=permit_sasl_authenticated,reject" \
      "$svc/inet/smtpd_sender_restrictions=reject_sender_login_mismatch"
  done
  postconf -P "submission/inet/smtpd_tls_security_level=encrypt" "smtps/inet/smtpd_tls_wrappermode=yes"

  # Dovecot 2.4 (Debian 13) and 2.3 read different configuration formats.
  if dovecot --version | grep -q '^2\.4\.'; then
  cat > /etc/dovecot/conf.d/99-webcpl.conf <<'DOVECOT'
# Written by the Webcpl installer (Dovecot 2.4). Mailboxes live in their account's home
# and are read and written with the account's own user ID.
protocols = imap pop3 lmtp sieve
ssl = yes
ssl_server_cert_file = /etc/webcpl/mail/cert.pem
ssl_server_key_file = /etc/webcpl/mail/key.pem
auth_allow_cleartext = no
auth_mechanisms = plain login
mail_driver = maildir
mail_path = ~/Maildir
# Debian's 10-mail.conf puts homes under /home/<name> and inboxes in /var/mail; here both
# come from the mailbox list and stay in the account's folder.
mail_home =
mail_inbox_path = ~/Maildir
first_valid_uid = 1000
passdb passwd-file {
  passwd_file_path = /etc/dovecot/webcpl-users
  auth_username_format = %{user | lower}
  default_password_scheme = ARGON2ID
}
userdb passwd-file {
  passwd_file_path = /etc/dovecot/webcpl-users
  auth_username_format = %{user | lower}
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
mail_plugins {
  quota = yes
}
quota "User quota" {
  driver = count
}
quota_exceeded_message = The mailbox is full.
protocol lmtp {
  # Debian's 20-lmtp.conf strips the domain; mailboxes are full addresses here.
  auth_username_format = %{user | lower}
  mail_plugins {
    sieve = yes
  }
}
protocol imap {
  mail_plugins {
    imap_quota = yes
  }
}
sieve_script personal {
  driver = file
  path = ~/sieve
  active_path = ~/.dovecot.sieve
}
namespace inbox {
  inbox = yes
  mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
  }
  mailbox Sent {
    special_use = \Sent
    auto = subscribe
  }
  mailbox Junk {
    special_use = \Junk
    auto = subscribe
  }
  mailbox Trash {
    special_use = \Trash
    auto = subscribe
  }
}
# Webmail connects from the server itself and may sign in without TLS.
remote 127.0.0.1 {
  auth_allow_cleartext = yes
}
DOVECOT
  else
  cat > /etc/dovecot/conf.d/99-webcpl.conf <<'DOVECOT'
# Written by the Webcpl installer. Mailboxes live in their account's home and are
# read and written with the account's own user ID.
protocols = imap pop3 lmtp sieve
ssl = required
ssl_cert = </etc/webcpl/mail/cert.pem
ssl_key = </etc/webcpl/mail/key.pem
disable_plaintext_auth = yes
auth_mechanisms = plain login
mail_location = maildir:~/Maildir
first_valid_uid = 1000
mail_plugins = $mail_plugins quota
passdb {
  driver = passwd-file
  args = scheme=ARGON2ID username_format=%u /etc/dovecot/webcpl-users
}
userdb {
  driver = passwd-file
  args = username_format=%u /etc/dovecot/webcpl-users
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
protocol lmtp {
  mail_plugins = $mail_plugins sieve
}
protocol imap {
  mail_plugins = $mail_plugins imap_quota
}
plugin {
  quota = maildir:User quota
  quota_exceeded_message = The mailbox is full.
  sieve = file:~/sieve;active=~/.dovecot.sieve
}
namespace inbox {
  inbox = yes
  mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
  }
  mailbox Sent {
    special_use = \Sent
    auto = subscribe
  }
  mailbox Junk {
    special_use = \Junk
    auto = subscribe
  }
  mailbox Trash {
    special_use = \Trash
    auto = subscribe
  }
}
# Webmail connects from the server itself and may sign in without TLS.
remote 127.0.0.1 {
  disable_plaintext_auth = no
}
DOVECOT
  fi
  rm -f /etc/dovecot/conf.d/99-webcpl-local.conf

  install -d -o _rspamd -g _rspamd /var/lib/rspamd/dkim
  cat > /etc/rspamd/local.d/dkim_signing.conf <<'RSPAMD'
path = "/var/lib/rspamd/dkim/$domain.$selector.key";
selector = "webcpl";
allow_username_mismatch = true;
use_esld = false;
RSPAMD
  cp /etc/rspamd/local.d/dkim_signing.conf /etc/rspamd/local.d/arc.conf
  echo 'servers = "127.0.0.1";' > /etc/rspamd/local.d/redis.conf
  cat > /etc/rspamd/local.d/actions.conf <<'RSPAMD'
reject = 15;
add_header = 6;
greylist = 4;
RSPAMD
  echo 'extended_spam_headers = true;' > /etc/rspamd/local.d/milter_headers.conf
  systemctl enable -q redis-server rspamd dovecot postfix
  systemctl restart redis-server rspamd dovecot postfix
}

install_node() {
  # The current long-term releases, side by side; apps pick one.
  local arch file v ok=0
  arch=$([ "$(uname -m)" = aarch64 ] && echo arm64 || echo x64)
  install -d /opt/webcpl-runtimes/node
  for v in 20 22 24; do
    file=$(curl -fsSL "https://nodejs.org/dist/latest-v$v.x/SHASUMS256.txt" | awk "/linux-$arch.tar.xz/{print \$2}") || continue
    [ -d "/opt/webcpl-runtimes/node/${file%.tar.xz}" ] || curl -fsSL "https://nodejs.org/dist/latest-v$v.x/$file" | tar -xJ -C /opt/webcpl-runtimes/node || continue
    ln -sfn "/opt/webcpl-runtimes/node/${file%.tar.xz}" "/opt/webcpl-runtimes/node/$v"
    ok=1
  done
  [ "$ok" = 1 ]
}

install_python() { "${APT[@]}" install python3 python3-venv python3-pip python3-dev build-essential; }
install_ruby() { "${APT[@]}" install ruby-full ruby-bundler build-essential; }

install_vps() {
  if ! apt-cache show incus >/dev/null 2>&1; then
    # Older releases get Incus from its upstream packages (Zabbly).
    install -d /etc/apt/keyrings
    curl -fsSLo /etc/apt/keyrings/zabbly.asc https://pkgs.zabbly.com/key.asc || return 1
    echo "deb [signed-by=/etc/apt/keyrings/zabbly.asc] https://pkgs.zabbly.com/incus/stable $CODENAME main" > /etc/apt/sources.list.d/zabbly-incus.list
    apt-get update -q
  fi
  "${APT[@]}" install incus btrfs-progs || return 1
  # Inside a container only part of the ID range is mapped; Incus must stay within it.
  local mapped
  mapped=$(awk 'NR==1 {print $3}' /proc/self/uid_map)
  if [ "$mapped" -lt 4294967295 ] && [ "$mapped" -gt 2000000 ]; then
    local range=$(( (mapped - 1000000) / 10 * 9 ))
    for f in /etc/subuid /etc/subgid; do
      sed -i '/^root:/d' "$f"
      echo "root:1000000:$range" >> "$f"
    done
    systemctl restart incus 2>/dev/null || true
  fi
  systemctl enable -q --now incus.socket incus 2>/dev/null || true
  # Each piece is checked on its own, so a run that stopped half-way is completed.
  # btrfs enforces each VPS's disk size; dir is the fallback where a loop file cannot be used.
  if ! incus storage show default >/dev/null 2>&1; then
    local free_gb pool_gb
    free_gb=$(df -BG --output=avail /var/lib | tail -1 | tr -dc 0-9)
    pool_gb=$(( free_gb * 7 / 10 ))
    [ "$pool_gb" -ge 10 ] || pool_gb=10
    if ! incus storage create default btrfs size="${pool_gb}GiB" >/dev/null 2>&1; then
      incus storage create default dir || return 1
      warn "VPS disks use the dir storage driver: disk sizes are not enforced."
    fi
  fi
  incus network show incusbr0 >/dev/null 2>&1 || incus network create incusbr0 || return 1
  incus profile device show default | grep -q '^root:' || incus profile device add default root disk path=/ pool=default || return 1
  incus profile device show default | grep -q '^eth0:' || incus profile device add default eth0 nic network=incusbr0 name=eth0 || return 1
}

component "the web server" install_web || true
if [ -n "$PHP_VERSIONS" ]; then component "PHP $PHP_VERSIONS" install_php || PHP_VERSIONS=""; fi
for key in mariadb postgresql redis dns ftp mail node python ruby vps; do
  [ "${WANT[$key]}" = 1 ] || continue
  component "$key" "install_$key" || WANT[$key]=0
done

# Adminer, a web database manager, at http://IP/dbadmin/ with its own PHP pool and user.
ADMINER_VERSION=5.4.1
install_adminer() {
  local v=${PHP_VERSIONS%% *}
  install -d /usr/share/webcpl/adminer
  curl -fsSL -o /usr/share/webcpl/adminer/index.php.new "https://github.com/vrana/adminer/releases/download/v$ADMINER_VERSION/adminer-$ADMINER_VERSION.php" || return 1
  mv /usr/share/webcpl/adminer/index.php.new /usr/share/webcpl/adminer/index.php
  id webcpl-dbadmin >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin webcpl-dbadmin
  cat > "/etc/php/$v/fpm/pool.d/webcpl-dbadmin.conf" <<POOL
[webcpl-dbadmin]
user = webcpl-dbadmin
group = webcpl-dbadmin
listen = /run/php/webcpl-dbadmin.sock
listen.owner = www-data
listen.group = www-data
pm = ondemand
pm.max_children = 5
php_admin_value[open_basedir] = /usr/share/webcpl/adminer:/tmp
php_admin_value[upload_max_filesize] = 256M
php_admin_value[post_max_size] = 256M
php_admin_value[session.save_path] = /tmp
POOL
  cat > /etc/nginx/webcpl/dbadmin.conf <<'NGINX'
location = /dbadmin { return 301 /dbadmin/; }
location ^~ /dbadmin/ {
    client_max_body_size 256m;
    fastcgi_pass unix:/run/php/webcpl-dbadmin.sock;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /usr/share/webcpl/adminer/index.php;
    fastcgi_param SCRIPT_NAME /dbadmin/index.php;
}
NGINX
  systemctl restart "php$v-fpm" && nginx -t -q && systemctl reload nginx
}
# SnappyMail webmail at http://IP/webmail/, with its own PHP pool, user and data folder.
SNAPPYMAIL_VERSION=3.0.1
install_webmail() {
  local v=${PHP_VERSIONS%% *} dir=/usr/share/webcpl/snappymail data=/var/lib/webcpl-webmail
  id webcpl-webmail >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin webcpl-webmail
  if [ ! -f "$dir/.version-$SNAPPYMAIL_VERSION" ]; then
    rm -rf "$dir.new" && install -d "$dir.new" &&
      curl -fsSL "https://github.com/the-djmaze/snappymail/releases/download/v$SNAPPYMAIL_VERSION/snappymail-$SNAPPYMAIL_VERSION.tar.gz" | tar -xz -C "$dir.new" || return 1
    rm -rf "$dir.new/data"
    echo "<?php define('APP_DATA_FOLDER_PATH', '$data/');" > "$dir.new/include.php"
    touch "$dir.new/.version-$SNAPPYMAIL_VERSION"
    rm -rf "$dir" && mv "$dir.new" "$dir"
  fi
  install -d -o webcpl-webmail -g webcpl-webmail -m 0750 "$data"
  "${APT[@]}" install "php$v-imap" >/dev/null 2>&1 || true
  cat > "/etc/php/$v/fpm/pool.d/webcpl-webmail.conf" <<POOL
[webcpl-webmail]
user = webcpl-webmail
group = webcpl-webmail
listen = /run/php/webcpl-webmail.sock
listen.owner = www-data
listen.group = www-data
pm = ondemand
pm.max_children = 10
php_admin_value[open_basedir] = $dir:$data:/tmp
php_admin_value[upload_max_filesize] = 50M
php_admin_value[post_max_size] = 52M
POOL
  cat > /etc/nginx/webcpl/webmail.conf <<'NGINX'
location = /webmail { return 301 /webmail/; }
location ^~ /webmail/ {
    alias /usr/share/webcpl/snappymail/;
    index index.php;
    client_max_body_size 52m;
    location ~ ^/webmail/(.+\.php)$ {
        alias /usr/share/webcpl/snappymail/$1;
        fastcgi_pass unix:/run/php/webcpl-webmail.sock;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME /usr/share/webcpl/snappymail/$1;
    }
}
NGINX
  systemctl restart "php$v-fpm" && nginx -t -q && systemctl reload nginx || return 1
  # The first request creates SnappyMail's data; then every domain uses this server.
  curl -fsS -o /dev/null http://127.0.0.1/webmail/ || true
  local domains="$data/_data_/_default_/domains"
  install -d -o webcpl-webmail -g webcpl-webmail "$domains"
  cat > "$domains/default.json" <<'JSON'
{"IMAP":{"host":"127.0.0.1","port":143,"type":0,"timeout":300,"shortLogin":false,"sasl":["PLAIN","LOGIN"],"ssl":{"verify_peer":false,"verify_peer_name":false,"allow_self_signed":true}},
 "SMTP":{"host":"127.0.0.1","port":587,"type":2,"timeout":60,"shortLogin":false,"useAuth":true,"setSender":false,"usePhpMail":false,"sasl":["PLAIN","LOGIN"],"ssl":{"verify_peer":false,"verify_peer_name":false,"allow_self_signed":true}},
 "Sieve":{"enabled":true,"host":"127.0.0.1","port":4190,"type":0,"timeout":10,"shortLogin":false,"sasl":["PLAIN","LOGIN"]},
 "whiteList":""}
JSON
  chown -R webcpl-webmail:webcpl-webmail "$data"
}
if [ -n "$PHP_VERSIONS" ] && [ "${WANT[mail]}" = 1 ]; then
  component "Webmail" install_webmail || true
fi

if [ -n "$PHP_VERSIONS" ] && { [ "${WANT[mariadb]}" = 1 ] || [ "${WANT[postgresql]}" = 1 ]; }; then
  component "Adminer" install_adminer || true
fi

# Fail2ban: SSH, mail and panel sign-ins. Bans last an hour after 5 failures in 10 minutes.
setup_fail2ban() {
  cat > /etc/fail2ban/filter.d/webcpl.conf <<'F2B'
[Definition]
failregex = ^.*webcpl: failed sign-in from <HOST>$
journalmatch = _SYSTEMD_UNIT=webcpl.service
F2B
  local mail=false
  [ "${WANT[mail]}" = 1 ] && mail=true
  cat > /etc/fail2ban/jail.d/webcpl.conf <<F2B
# Written by the Webcpl installer.
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true

[webcpl]
enabled = true
port = $PORT

[postfix-sasl]
enabled = $mail
filter = postfix[mode=auth]
port = smtp,submission,submissions

[dovecot]
enabled = $mail
port = imap,imaps,pop3,pop3s,submission,submissions,sieve
F2B
  systemctl enable -q fail2ban && systemctl restart fail2ban
}
component "Fail2ban" setup_fail2ban || true

# What actually got installed: the agent reports from this file.
WEB_OK=true
if [[ " ${FAILED[*]-} " == *" the web server "* ]]; then WEB_OK=false; fi
php_json=$(printf '"%s",' $PHP_VERSIONS); php_json="[${php_json%,}]"
if [ "$php_json" = '[""]' ]; then php_json='[]'; fi
b() { [ "${WANT[$1]}" = 1 ] && echo true || echo false; }
cat > "$CONF/components.json" <<JSON
{
  "web": $WEB_OK,
  "php": $php_json,
  "node": $(b node), "python": $(b python), "ruby": $(b ruby),
  "mariadb": $(b mariadb), "postgresql": $(b postgresql), "redis": $(b redis),
  "dns": $(b dns), "ftp": $(b ftp), "mail": $(b mail), "vps": $(b vps)
}
JSON

# ---- Webcpl -----------------------------------------------------------------------------------

say "Installing the panel"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q --depth 1 origin "$BRANCH" && git -C "$APP" reset -q --hard FETCH_HEAD
else
  rm -rf "$APP"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi
VERSION=$(grep -m1 '"version"' "$APP/package.json" | cut -d'"' -f4)
(cd "$APP" && "$BUN" install --frozen-lockfile >/dev/null && "$BUN" run build >/dev/null) || die "the interface could not be built."

PUBLIC_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
cat > "$CONF/webcpl.env" <<ENV
NODE_ENV=production
WEBCPL_PUBLIC_IP=$PUBLIC_IP
WEBCPL_PORT=$PORT
WEBCPL_HOST=0.0.0.0
WEBCPL_DATA=$DATA
WEBCPL_AGENT_SOCKET=/run/webcpl/agent.sock
WEBCPL_BRANCH=$BRANCH
WEBCPL_VERSION=$VERSION
ENV
chmod 640 "$CONF/webcpl.env"; chgrp webcpl "$CONF/webcpl.env"

cat > /etc/systemd/system/webcpl-agent.service <<UNIT
[Unit]
Description=Webcpl agent (runs server operations for the panel)
After=network-online.target

[Service]
EnvironmentFile=$CONF/webcpl.env
ExecStart=$BUN $APP/agent/index.ts
# The socket directory belongs to root, readable by the panel's group only.
Group=webcpl
RuntimeDirectory=webcpl
RuntimeDirectoryMode=0750
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/webcpl.service <<UNIT
[Unit]
Description=Webcpl hosting control panel
After=network-online.target webcpl-agent.service
Wants=webcpl-agent.service

[Service]
User=webcpl
Group=webcpl
EnvironmentFile=$CONF/webcpl.env
WorkingDirectory=$APP
ExecStart=$BUN $APP/panel/index.ts
Restart=always
RestartSec=2
# The panel never needs more than its data folder and the agent's socket.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT

cat > /usr/local/bin/webcpl <<'CLI'
#!/usr/bin/env bash
# webcpl: manage the panel from the server.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo webcpl $*" >&2; exit 1; }
set -a; . /etc/webcpl/webcpl.env; set +a
case "${1:-help}" in
  update)
    git -C /opt/webcpl fetch -q --depth 1 origin "${WEBCPL_BRANCH:-main}" && git -C /opt/webcpl reset -q --hard FETCH_HEAD
    cd /opt/webcpl && /usr/local/bin/bun install --frozen-lockfile >/dev/null && /usr/local/bin/bun run build >/dev/null
    sed -i "s/^WEBCPL_VERSION=.*/WEBCPL_VERSION=$(grep -m1 '"version"' package.json | cut -d'"' -f4)/" /etc/webcpl/webcpl.env
    systemctl restart webcpl-agent webcpl && echo "Updated to $(grep -m1 '"version"' package.json | cut -d'"' -f4)." ;;
  restart) systemctl restart webcpl-agent webcpl && echo "Restarted." ;;
  status) systemctl --no-pager status webcpl-agent webcpl | grep -E '●|Active:' ;;
  logs) exec journalctl -u webcpl -u webcpl-agent -f ;;
  *) cd /opt/webcpl && exec runuser -u webcpl -- /usr/local/bin/bun panel/cli.ts "$@" ;;
esac
CLI
chmod 755 /usr/local/bin/webcpl

systemctl daemon-reload
systemctl enable -q webcpl-agent webcpl
systemctl restart webcpl-agent
sleep 1
systemctl restart webcpl
for _ in $(seq 1 40); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/me" && break; sleep 0.5; done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/me" || { journalctl -u webcpl -u webcpl-agent -n 40 --no-pager; die "the panel did not start."; }

if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow "$PORT/tcp" >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  if [ "${WANT[dns]}" = 1 ]; then ufw allow 53 >/dev/null; fi
fi

# ---- done -----------------------------------------------------------------------------------------

trap - ERR
IP="$PUBLIC_IP"
PASSFILE="$DATA/initial-admin-password"
echo
echo "────────────────────────────────────────────────────────"
echo "  Webcpl $VERSION is running."
echo
echo "  Open:      http://$IP:$PORT"
echo "  Username:  admin"
if [ -f "$PASSFILE" ]; then
  echo "  Password:  $(cat "$PASSFILE")"
  rm -f "$PASSFILE"
  echo
  echo "  Save this password now; it is not shown again."
else
  echo "  Password:  unchanged (reset it with: sudo webcpl reset-admin-password)"
fi
if [ ${#FAILED[@]} -gt 0 ]; then
  echo
  echo "  Not installed: ${FAILED[*]}"
fi
echo
echo "  Manage:    sudo webcpl status | update | restart | logs | reset-admin-password"
echo "────────────────────────────────────────────────────────"
