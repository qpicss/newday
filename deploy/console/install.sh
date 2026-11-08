#!/usr/bin/env bash
# Installs the OAuth Server console (management) as a systemd service on Ubuntu 22.04 or 24.04,
# optionally behind nginx with a Let's Encrypt certificate.
#
#   sudo bash deploy/console/install.sh                                         # service only
#   sudo bash deploy/console/install.sh --domain console.example.com --email ops@example.com
#
# Run it from the repository (a git clone, or a `git archive` copy). Re-running it installs a new
# release next to the old ones, switches /opt/oauth-console/current and restarts the service.
# Roll back with:
#   sudo ln -sfn /opt/oauth-console/releases/<previous> /opt/oauth-console/current && sudo systemctl restart oauth-console
#
# Settings live in /etc/oauth-console/console.env (created from .env.example on the first run).
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR=/opt/oauth-console
CONFIG_DIR=/etc/oauth-console
SERVICE_USER=oauth-console
NODE_MAJOR=20
DOMAIN=""
EMAIL=""
export DEBIAN_FRONTEND=noninteractive

usage() {
  cat <<'EOF'
Usage: sudo bash deploy/console/install.sh [--domain NAME --email ADDRESS]

  --domain NAME    also install nginx for this host name: HTTPS on 443 to the console on
                   127.0.0.1:3000, with a Let's Encrypt certificate (needs DNS and port 80 open)
  --email ADDRESS  contact address for Let's Encrypt (with --domain)
  --no-certbot     with --domain: write the nginx site but get the certificate yourself
EOF
}

CERTBOT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
    --email) EMAIL=${2:?--email needs a value}; shift 2 ;;
    --no-certbot) CERTBOT=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

info() { echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run this script as root: sudo bash $0"
[[ -f "${SOURCE_DIR}/server.js" && -f "${SOURCE_DIR}/package.json" ]] || fail "${SOURCE_DIR} is not the repository root (no server.js)."
[[ -z "$DOMAIN" || -n "$EMAIL" || $CERTBOT -eq 0 ]] || fail "--domain needs --email for Let's Encrypt (or --no-certbot)."

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt "$NODE_MAJOR" ]]; then
  info "Installing Node.js ${NODE_MAJOR} from NodeSource"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
info "Using Node.js $(node --version)"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "Creating system user ${SERVICE_USER}"
  useradd --system --home-dir "$INSTALL_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 755 "$INSTALL_DIR" "$INSTALL_DIR/releases"
install -d -m 750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"

VERSION="$(node -p "require('${SOURCE_DIR}/package.json').version")"
RELEASE_DIR="${INSTALL_DIR}/releases/${VERSION}-$(date +%Y%m%d%H%M%S)"
info "Installing release ${RELEASE_DIR}"
install -d -m 755 "$RELEASE_DIR" "$RELEASE_DIR/gateway"
# The console runs the gateway's flow and policy modules, serves its charts and its README.
cp -r "${SOURCE_DIR}"/{app.js,server.js,package.json,package-lock.json,config,controllers,middleware,models,public,routes,scripts,services,utils,views,docs} "$RELEASE_DIR/"
cp -r "${SOURCE_DIR}/gateway/src" "${SOURCE_DIR}/gateway/ui" "${SOURCE_DIR}/gateway/README.md" "$RELEASE_DIR/gateway/"
[[ -f "${SOURCE_DIR}/README.md" ]] && cp "${SOURCE_DIR}/README.md" "$RELEASE_DIR/"
(cd "$RELEASE_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
ln -sfn "$RELEASE_DIR" "${INSTALL_DIR}/current"

if [[ ! -f "${CONFIG_DIR}/console.env" ]]; then
  info "Creating ${CONFIG_DIR}/console.env from .env.example: fill it in before starting"
  install -m 640 -o root -g "$SERVICE_USER" "${SOURCE_DIR}/.env.example" "${CONFIG_DIR}/console.env"
fi

install -m 644 "${SOURCE_DIR}/deploy/console/oauth-console.service" /etc/systemd/system/oauth-console.service

if [[ -n "$DOMAIN" ]]; then
  info "Installing nginx for ${DOMAIN}"
  apt-get install -y nginx
  install -d -m 755 /var/www/letsencrypt
  ln -sfn /etc/nginx/sites-available/oauth-console /etc/nginx/sites-enabled/oauth-console
  rm -f /etc/nginx/sites-enabled/default
  if [[ $CERTBOT -eq 1 && ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    info "Getting a Let's Encrypt certificate for ${DOMAIN}"
    apt-get install -y certbot
    # The HTTPS site can't load before its certificate exists: serve the challenge over HTTP first.
    cat > /etc/nginx/sites-available/oauth-console <<NGINX
server {
  listen 80;
  server_name ${DOMAIN};
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
}
NGINX
    systemctl enable --now nginx
    systemctl reload nginx
    certbot certonly --webroot -w /var/www/letsencrypt --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN"
    # certbot's timer renews it through the same webroot; reload nginx to pick up a renewed one.
    install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  fi
  sed "s/console.example.com/${DOMAIN}/g" "${SOURCE_DIR}/deploy/console/nginx.conf" > /etc/nginx/sites-available/oauth-console
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
fi

if [[ -d /run/systemd/system ]]; then
  systemctl daemon-reload
  if systemctl is-active --quiet oauth-console; then
    info "Restarting the running console on the new release"
    systemctl restart oauth-console
  fi
fi

cat <<EOF

Installed. Next steps:
  1. Fill in ${CONFIG_DIR}/console.env: JWT_SECRET, PKI_MASTER_KEY, DB_*, APP_URL, NODE_ENV=production
     ${DOMAIN:+and TRUST_PROXY=loopback (nginx runs on this machine)}
  2. Upgrading an existing database? Back it up, then run the migration:
       sudo -u ${SERVICE_USER} bash -c 'set -a; . ${CONFIG_DIR}/console.env; cd ${INSTALL_DIR}/current && npm run migrate-data'
     and again with "-- --apply" once the plan looks right.
  3. Start it:
       sudo systemctl enable --now oauth-console
       journalctl -u oauth-console -f
  4. Open 443 (and 80 for certificate renewals) to users and API clients. Open 3443 only to
     pull-mode gateways. Allow outbound 9443 to push-mode gateways.
EOF
