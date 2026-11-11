#!/usr/bin/env bash
# Offline installer for the OAuth Server console (management), shipped inside the bundle that
# deploy/offline/build-bundle.sh builds. It downloads nothing: Node.js, the console and its
# dependencies (and nginx, when the bundle has it) all come from the bundle. Ubuntu 22.04 or 24.04.
#
#   sudo bash install.sh                                     # the service only, on port 3000
#   sudo bash install.sh --domain console.corp.example --cert console.crt --key console.key
#
# Re-running it from a newer bundle installs a new release next to the old ones, switches
# /opt/oauth-console/current and restarts the service if it runs. Roll back with:
#   sudo ln -sfn /opt/oauth-console/releases/<previous> /opt/oauth-console/current && sudo systemctl restart oauth-console
#
# Settings live in /etc/oauth-console/console.env. The first run creates it with a new JWT_SECRET
# and PKI_MASTER_KEY.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR=/opt/oauth-console
CONFIG_DIR=/etc/oauth-console
SERVICE_USER=oauth-console
NODE_HOME=${INSTALL_DIR}/node
NODE_BIN=${NODE_HOME}/current/bin/node
DOMAIN=""
CERT=""
KEY=""
START=0
export DEBIAN_FRONTEND=noninteractive

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh [--domain NAME --cert FILE --key FILE] [--start]

  --domain NAME  also serve HTTPS on 443 with nginx for this host name, to the console on
                 127.0.0.1:3000 (nginx comes from the bundle when it isn't installed)
  --cert FILE    the certificate for NAME (PEM, server certificate first, then its chain),
                 e.g. from your company CA: Let's Encrypt can't reach an offline server
  --key FILE     its private key (PEM, without a passphrase)
  --start        start the console (or restart it) when done; fill in console.env first
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
    --cert) CERT=${2:?--cert needs a file}; shift 2 ;;
    --key) KEY=${2:?--key needs a file}; shift 2 ;;
    --start) START=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

info() { echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
bundle() { sed -n "s/^$1=//p" "${BUNDLE_DIR}/BUNDLE"; }

[[ $EUID -eq 0 ]] || fail "Run this script as root: sudo bash $0"
[[ -f "${BUNDLE_DIR}/BUNDLE" && -f "${BUNDLE_DIR}/app/server.js" ]] || fail "${BUNDLE_DIR} is not an unpacked console bundle."
if [[ -n "$DOMAIN" ]]; then
  [[ -n "$CERT" && -n "$KEY" ]] || fail "--domain needs --cert and --key."
  [[ -r "$CERT" && -r "$KEY" ]] || fail "Can't read ${CERT} or ${KEY}."
fi
case "$(uname -m)" in x86_64) machine=x64 ;; aarch64|arm64) machine=arm64 ;; *) machine=$(uname -m) ;; esac
[[ "$(bundle arch)" == "$machine" ]] || fail "This bundle is for linux-$(bundle arch); this server is ${machine}."

VERSION="$(bundle version)"
NODE_FILE="$(bundle node)"
NODE_DIR="${NODE_HOME}/${NODE_FILE%.tar.gz}"

if [[ ! -x "${NODE_DIR}/bin/node" ]]; then
  info "Installing ${NODE_FILE%.tar.gz} in ${NODE_HOME}"
  install -d -m 755 "$NODE_HOME"
  tar -xzf "${BUNDLE_DIR}/node/${NODE_FILE}" -C "$NODE_HOME" --no-same-owner
fi
ln -sfn "$NODE_DIR" "${NODE_HOME}/current"
info "Using Node.js $("$NODE_BIN" --version)"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "Creating system user ${SERVICE_USER}"
  useradd --system --home-dir "$INSTALL_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -m 755 "$INSTALL_DIR" "${INSTALL_DIR}/releases"
install -d -m 750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"

RELEASE_DIR="${INSTALL_DIR}/releases/${VERSION}-$(date +%Y%m%d%H%M%S)"
info "Installing release ${RELEASE_DIR} ($(bundle commit), built $(bundle built))"
install -d -m 755 "$RELEASE_DIR"
cp -r "${BUNDLE_DIR}/app/." "$RELEASE_DIR/"
chown -R root:root "$RELEASE_DIR"
chmod -R u=rwX,go=rX "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "${INSTALL_DIR}/current"

NEW_ENV=0
if [[ ! -f "${CONFIG_DIR}/console.env" ]]; then
  info "Creating ${CONFIG_DIR}/console.env with a new JWT_SECRET and PKI_MASTER_KEY"
  jwt="$("$NODE_BIN" -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))")"
  pki="$("$NODE_BIN" -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"
  edits=(-e "s|^JWT_SECRET=.*|JWT_SECRET=${jwt}|" -e "s|^# PKI_MASTER_KEY=.*|PKI_MASTER_KEY=${pki}|")
  if [[ -n "$DOMAIN" ]]; then
    edits+=(-e "s|^# APP_URL=.*|APP_URL=https://${DOMAIN}|" -e "s|^# TRUST_PROXY=loopback|TRUST_PROXY=loopback|")
  fi
  tmp="$(mktemp)"
  sed "${edits[@]}" "${BUNDLE_DIR}/console.env.example" > "$tmp"
  install -m 640 -o root -g "$SERVICE_USER" "$tmp" "${CONFIG_DIR}/console.env"
  rm -f "$tmp"
  NEW_ENV=1
fi
if [[ -f "${BUNDLE_DIR}/certs/rds-global-bundle.pem" ]]; then
  install -m 644 "${BUNDLE_DIR}/certs/rds-global-bundle.pem" "${CONFIG_DIR}/rds-global-bundle.pem"
fi

sed "s|^ExecStart=.*|ExecStart=${NODE_BIN} ${INSTALL_DIR}/current/server.js|" \
  "${BUNDLE_DIR}/oauth-console.service" > /etc/systemd/system/oauth-console.service
chmod 644 /etc/systemd/system/oauth-console.service

# Commands that run one of the console's scripts with its settings and its Node.js (no npm, and
# no MySQL client needed on the server).
helper() {
  cat > "/usr/local/sbin/$1" <<EOF
#!/bin/sh
# $3
exec runuser -u ${SERVICE_USER} -- env DOTENV_CONFIG_QUIET=true /bin/sh -c 'set -a; . ${CONFIG_DIR}/console.env; set +a; cd ${INSTALL_DIR}/current && exec ${NODE_BIN} scripts/$2 "\$@"' sh "\$@"
EOF
  chmod 755 "/usr/local/sbin/$1"
}
helper oauth-console-migrate migrate-data.js "Schema and data migrations for the console: a dry run unless given --apply. Back up the database first."
helper oauth-console-admin platform-admin.js "Makes a registered account a platform admin: oauth-console-admin you@example.com"

SYSTEMD=0
[[ -d /run/systemd/system ]] && SYSTEMD=1

if [[ -n "$DOMAIN" ]]; then
  if ! command -v nginx >/dev/null 2>&1; then
    [[ -f "${BUNDLE_DIR}/nginx/Packages" ]] || fail "nginx isn't installed and this bundle has none. Build the bundle with NGINX_FOR=$(. /etc/os-release; echo "$VERSION_CODENAME"), or install nginx from your own mirror."
    release="$(. /etc/os-release; echo "$VERSION_CODENAME")"
    [[ "$release" == "$(cat "${BUNDLE_DIR}/nginx/UBUNTU_RELEASE")" ]] || fail "The bundle's nginx is for Ubuntu $(cat "${BUNDLE_DIR}/nginx/UBUNTU_RELEASE"); this server runs ${release}."
    info "Installing nginx from the bundle"
    # apt resolves nginx's dependencies from the bundle's folder only, keeping newer installed ones.
    repo="$(mktemp -d)"
    cp "${BUNDLE_DIR}"/nginx/* "$repo/"
    chmod 755 "$repo"
    echo "deb [trusted=yes] file:${repo} ./" > "${repo}/bundle.list"
    apt_local=(-o "Dir::Etc::SourceList=${repo}/bundle.list" -o Dir::Etc::SourceParts=/dev/null -o APT::Get::List-Cleanup=false)
    apt-get "${apt_local[@]}" update -qq
    apt-get "${apt_local[@]}" install -y -qq nginx
    rm -rf "$repo"
  fi
  info "nginx site for ${DOMAIN}"
  install -d -m 750 /etc/nginx/tls
  install -m 644 "$CERT" "/etc/nginx/tls/${DOMAIN}.crt"
  install -m 600 "$KEY" "/etc/nginx/tls/${DOMAIN}.key"
  sed -e "s|/etc/letsencrypt/live/console.example.com/fullchain.pem|/etc/nginx/tls/${DOMAIN}.crt|" \
      -e "s|/etc/letsencrypt/live/console.example.com/privkey.pem|/etc/nginx/tls/${DOMAIN}.key|" \
      -e '/acme-challenge/d' -e '/Let.s Encrypt renewals/d' \
      -e "s/console.example.com/${DOMAIN}/g" \
      "${BUNDLE_DIR}/nginx.conf" > /etc/nginx/sites-available/oauth-console
  ln -sfn /etc/nginx/sites-available/oauth-console /etc/nginx/sites-enabled/oauth-console
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  if [[ $SYSTEMD -eq 1 ]]; then
    systemctl enable --quiet nginx
    systemctl reload-or-restart nginx
  fi
fi

if [[ $SYSTEMD -eq 1 ]]; then
  systemctl daemon-reload
  if [[ $START -eq 1 ]]; then
    info "Starting the console"
    systemctl enable --quiet oauth-console
    systemctl restart oauth-console
  elif systemctl is-active --quiet oauth-console; then
    info "Restarting the running console on the new release"
    systemctl restart oauth-console
  fi
fi

cat <<EOF

Installed console ${VERSION}. Next steps:
  1. Fill in ${CONFIG_DIR}/console.env: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD and APP_URL.
     On Amazon RDS also: DB_SSL=true and DB_SSL_CA=${CONFIG_DIR}/rds-global-bundle.pem
     On Azure Database for MySQL: DB_SSL=true
EOF
if [[ $NEW_ENV -eq 1 ]]; then
  cat <<EOF
     JWT_SECRET and PKI_MASTER_KEY were generated. Moving an existing console's database? Copy
     that console's values instead: its stored private keys can't be read with new ones.
EOF
fi
cat <<EOF
  2. Upgrading an existing database? Back it up, then check and apply the migration:
       sudo oauth-console-migrate
       sudo oauth-console-migrate --apply
  3. Start it:
       sudo systemctl enable --now oauth-console
       journalctl -u oauth-console -f
  4. New database: register in the console, then make that account the platform admin:
       sudo oauth-console-admin you@example.com
  5. Allow $([[ -n "$DOMAIN" ]] && echo 443 || echo 3000) to users and API clients, 3443 to pull-mode gateways only, and
     outbound 9443 to push-mode gateways.
EOF
