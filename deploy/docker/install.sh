#!/usr/bin/env bash
# Installs the console with Docker, from the package deploy/docker/pack.sh builds: the console and
# MySQL as containers (plus nginx for HTTPS, and a gateway node if asked). It installs Docker
# when it's missing (that needs internet access), loads the images from the package, keeps the
# console's settings, and loads its database when the database is empty.
#
#   sudo bash install.sh                                                   # console on port 3000
#   sudo bash install.sh --domain console.example.com --cert console.crt --key console.key
#   sudo PFX_PASSWORD=... bash install.sh --domain console.mana2.ro --pfx mana2.ro.pfx
#
# Options:
#   --domain NAME --cert FILE --key FILE   HTTPS on 443 through an nginx container with your certificate
#                                          (PEM: server certificate first, then its chain; key without
#                                          a passphrase). Sets APP_URL=https://NAME.
#   --pfx FILE                             with --domain, instead of --cert and --key: a PFX (PKCS#12)
#                                          with the key, the certificate and its chain. Its password
#                                          comes from PFX_PASSWORD, --pfx-password-file, or a prompt.
#                                          A package built with PFX=... has it as console.pfx, used
#                                          when --domain has no --cert, --key or --pfx.
#   --pfx-password-file FILE               the PFX password, read from this file
#   --url URL                              without --domain: the address users open, for APP_URL
#                                          (e.g. http://203.0.113.10:3000)
#   --gateway FILE                         also run a gateway node here, with this credentials file
#   --replace-db                           the database already has data: replace it with the package's
#
# Run it again from a newer package to upgrade: it loads the new images and restarts the
# containers; the database is kept (unless --replace-db).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR=/opt/oauth-console-docker
DOMAIN=""
CERT=""
KEY=""
URL=""
PFX=""
PFX_PASSWORD_FILE=""
GATEWAY_CREDENTIALS=""
REPLACE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
    --cert) CERT=${2:?--cert needs a file}; shift 2 ;;
    --key) KEY=${2:?--key needs a file}; shift 2 ;;
    --pfx) PFX=${2:?--pfx needs a file}; shift 2 ;;
    --pfx-password-file) PFX_PASSWORD_FILE=${2:?--pfx-password-file needs a file}; shift 2 ;;
    --url) URL=${2:?--url needs a value}; shift 2 ;;
    --gateway) GATEWAY_CREDENTIALS=${2:?--gateway needs the credentials file}; shift 2 ;;
    --replace-db) REPLACE=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

info() { echo; echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
setting() {   # setting NAME VALUE FILE: set it, uncommenting or appending
  if grep -qE "^#? ?$1=" "$3"; then sed -i -E "s|^#? ?$1=.*|$1=$2|" "$3"; else echo "$1=$2" >> "$3"; fi
}
unset_setting() { sed -i -E "/^$1=/d" "$2"; }
has_systemd() { [[ -d /run/systemd/system ]]; }

[[ $EUID -eq 0 ]] || fail "Run as root: sudo bash $0"
[[ -f "$HERE/docker-compose.yml" && -f "$HERE/console.env" && -d "$HERE/images" ]] || fail "Run install.sh from the unpacked package."
if [[ -n "$DOMAIN" && -z "$CERT$KEY$PFX" && -f "$HERE/console.pfx" ]]; then
  PFX="$HERE/console.pfx"   # the certificate packed with the package
fi
if [[ -n "$PFX" ]]; then
  [[ -n "$DOMAIN" ]] || fail "--pfx needs --domain."
  [[ -z "$CERT$KEY" ]] || fail "Use --pfx or --cert and --key, not both."
  [[ -r "$PFX" ]] || fail "Can't read ${PFX}."
  command -v openssl >/dev/null 2>&1 || fail "openssl is needed to read the PFX: apt-get install openssl"
  if [[ -n "$PFX_PASSWORD_FILE" ]]; then
    PFX_PASSWORD="$(head -n 1 "$PFX_PASSWORD_FILE")"
  elif [[ -z "${PFX_PASSWORD+set}" ]]; then
    read -rsp "Password of ${PFX##*/}: " PFX_PASSWORD < /dev/tty; echo
  fi
  export PFX_PASSWORD
  # Split the PFX into what nginx reads: the certificate followed by its chain (without the
  # self-signed root, which clients must already trust), and the key without a passphrase.
  PFX_DIR="$(mktemp -d)"
  trap 'rm -rf "$PFX_DIR"' EXIT
  openssl pkcs12 -in "$PFX" -passin env:PFX_PASSWORD -nokeys -clcerts 2>/dev/null | openssl x509 > "$PFX_DIR/cert.pem" 2>/dev/null     || fail "Can't open ${PFX}: wrong password, or not a PFX with a certificate."
  openssl pkcs12 -in "$PFX" -passin env:PFX_PASSWORD -nocerts -nodes 2>/dev/null | openssl pkey > "$PFX_DIR/key.pem" 2>/dev/null     || fail "${PFX} has no private key."
  openssl pkcs12 -in "$PFX" -passin env:PFX_PASSWORD -nokeys -cacerts 2>/dev/null     | awk -v dir="$PFX_DIR" '/-----BEGIN CERTIFICATE-----/{n++; f=dir "/ca" n ".pem"} f{print > f} /-----END CERTIFICATE-----/{f=""}'
  cp "$PFX_DIR/cert.pem" "$PFX_DIR/fullchain.pem"
  for ca in "$PFX_DIR"/ca*.pem; do
    [[ -f "$ca" ]] || continue
    [[ "$(openssl x509 -in "$ca" -noout -subject)" == "subject=$(openssl x509 -in "$ca" -noout -issuer | sed 's/^issuer=//')" ]] && continue
    openssl x509 -in "$ca" >> "$PFX_DIR/fullchain.pem"
  done
  CERT="$PFX_DIR/fullchain.pem"
  KEY="$PFX_DIR/key.pem"
  echo "Certificate from ${PFX##*/}: $(openssl x509 -in "$CERT" -noout -subject | sed 's/^subject=//'), until $(openssl x509 -in "$CERT" -noout -enddate | sed 's/^notAfter=//')"
fi
if [[ -n "$DOMAIN" ]]; then
  [[ -n "$CERT" && -n "$KEY" ]] || fail "--domain needs --cert and --key, or --pfx."
  [[ -r "$CERT" && -r "$KEY" ]] || fail "Can't read ${CERT} or ${KEY}."
  if command -v openssl >/dev/null 2>&1; then
    [[ "$(openssl x509 -in "$CERT" -noout -pubkey | openssl sha256)" == "$(openssl pkey -in "$KEY" -pubout | openssl sha256)" ]]       || fail "The key does not belong to the certificate."
  fi
fi
[[ -z "$GATEWAY_CREDENTIALS" || -r "$GATEWAY_CREDENTIALS" ]] || fail "Can't read ${GATEWAY_CREDENTIALS}."

# --- Docker --------------------------------------------------------------------------------
info "Docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed: installing it from get.docker.com (needs internet access)"
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl ca-certificates; }
  curl -fsSL https://get.docker.com | sh
fi
if has_systemd && ! systemctl is-active --quiet docker; then
  echo "Starting the Docker service"
  systemctl enable --now docker
fi
docker info >/dev/null 2>&1 || fail "Docker is installed but not running: check 'systemctl status docker'."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing: apt-get install docker-compose-plugin (or docker-compose-v2)."
echo "Docker $(docker version --format '{{.Server.Version}}') is running, with $(docker compose version --short 2>/dev/null || echo compose)."

# The earlier non-Docker install (systemd service) would hold port 3000.
if has_systemd && { systemctl is-enabled --quiet oauth-console 2>/dev/null || systemctl is-active --quiet oauth-console; }; then
  echo "Stopping and disabling the oauth-console systemd service: Docker runs the console now."
  systemctl disable --now oauth-console >/dev/null 2>&1 || true
fi

# --- Images --------------------------------------------------------------------------------
info "Loading the images"
for image in "$HERE"/images/*.tar.gz; do
  gunzip -c "$image" | docker load | sed 's/^/    /'
done

# --- Files ---------------------------------------------------------------------------------
info "Files in ${DIR}"
install -d -m 750 "$DIR"
cp "$HERE/docker-compose.yml" "$HERE/nginx.conf" "$DIR/"
TAGS="$(cat "$HERE/image-tags")"   # CONSOLE_TAG=... GATEWAY_TAG=...

# .env: the MySQL passwords are made once. The database volume keeps the ones it was created with.
if [[ ! -f "$DIR/.env" ]]; then
  {
    echo "MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)"
    echo "MYSQL_PASSWORD=$(openssl rand -hex 24)"
  } > "$DIR/.env"
fi
for line in $TAGS; do setting "${line%%=*}" "${line#*=}" "$DIR/.env"; done
chmod 600 "$DIR/.env"

# console.env: the package's settings (with the JWT_SECRET that unlocks the stored keys). An
# earlier install's APP_URL and TRUST_PROXY are kept unless this run sets them.
tmp="$(mktemp)"
cp "$HERE/console.env" "$tmp"
if [[ -n "$DOMAIN" ]]; then
  setting APP_URL "https://${DOMAIN}" "$tmp"
  setting TRUST_PROXY 1 "$tmp"   # one proxy: the nginx container
elif [[ -n "$URL" ]]; then
  setting APP_URL "$URL" "$tmp"
  unset_setting TRUST_PROXY "$tmp"
elif [[ -f "$DIR/console.env" ]]; then
  for name in APP_URL TRUST_PROXY; do
    value="$(sed -n "s/^${name}=//p" "$DIR/console.env" | tail -1)"
    [[ -z "$value" ]] || setting "$name" "$value" "$tmp"
  done
fi
if [[ -f "$DIR/console.env" ]] && ! cmp -s "$tmp" "$DIR/console.env"; then
  cp -p "$DIR/console.env" "$DIR/console.env.before-$(date +%Y%m%d%H%M%S)"
fi
install -m 600 "$tmp" "$DIR/console.env"
rm -f "$tmp"

# Profiles go into .env as COMPOSE_PROFILES, so a plain `docker compose` in ${DIR} includes them.
# Earlier runs' profiles are kept.
profiles="$(sed -n 's/^COMPOSE_PROFILES=//p' "$DIR/.env" | tr ',' ' ')"
if [[ -n "$DOMAIN" ]]; then
  install -d -m 755 "$DIR/tls"
  install -m 644 "$CERT" "$DIR/tls/console.crt"
  install -m 600 "$KEY" "$DIR/tls/console.key"   # read by nginx's master process (root)
  profiles="$profiles https"
fi
if [[ -n "$GATEWAY_CREDENTIALS" ]]; then
  install -m 644 "$GATEWAY_CREDENTIALS" "$DIR/gateway-credentials.json"   # the container's user reads it
  profiles="$profiles gateway"
fi
profiles="$(echo $profiles | tr ' ' '\n' | sort -u | paste -sd, -)"
if [[ -n "$profiles" ]]; then setting COMPOSE_PROFILES "$profiles" "$DIR/.env"; fi
# Behind nginx, port 3000 is for nginx only.
setting CONSOLE_HTTP_BIND "$([[ ",$profiles," == *,https,* ]] && echo 127.0.0.1 || echo 0.0.0.0)" "$DIR/.env"
compose() { (cd "$DIR" && docker compose "$@"); }

# --- Database ------------------------------------------------------------------------------
info "MySQL"
compose up -d mysql
for _ in $(seq 1 90); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q mysql)")" == healthy ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q mysql)")" == healthy ]] || { compose logs --tail 30 mysql; fail "MySQL did not start."; }
sql() { compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot "$@"' sh "$@"; }
tables="$(sql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='newday'")"

if [[ -f "$HERE/newday.sql" ]] && { [[ "$tables" == 0 ]] || [[ $REPLACE -eq 1 ]]; }; then
  compose stop console >/dev/null 2>&1 || true
  if [[ "$tables" != 0 ]]; then
    echo "Replacing the ${tables} tables in newday"
    sql -e "DROP DATABASE newday; CREATE DATABASE newday CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
  fi
  echo "Loading newday.sql (users, gateways, certificates and keys)"
  compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot newday' < "$HERE/newday.sql"
  echo "Loaded: $(sql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='newday'") tables, $(sql -N -e 'SELECT COUNT(*) FROM newday.Users') users, $(sql -N -e 'SELECT COUNT(*) FROM newday.SystemKeys') system keys."
elif [[ "$tables" != 0 ]]; then
  echo "The database already has ${tables} tables: kept. (--replace-db replaces it with the package's.)"
else
  echo "Empty database: the console creates its tables on first start."
fi

# --- Start ---------------------------------------------------------------------------------
info "Starting the containers"
compose up -d --remove-orphans
echo "Schema check (a dry run of the migration):"
compose exec -T console node scripts/migrate-data.js 2>&1 | tail -2 | sed 's/^/    /' || true
for _ in $(seq 1 45); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q console)")" == healthy ]] && break
  sleep 2
done
compose ps
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q console)")" == healthy ]] || { compose logs --tail 30 console; fail "The console did not become healthy."; }

address="$(sed -n 's/^APP_URL=//p' "$DIR/console.env" | tail -1)"
cat <<EOF

The console runs: ${address:-http://<this server>:3000}
  Files and settings: ${DIR} (console.env, .env with the MySQL passwords)
  Logs:      docker compose --project-directory ${DIR} logs -f console
  Restart:   docker compose --project-directory ${DIR} restart console
  First admin of a new database (after registering):
             docker compose --project-directory ${DIR} exec console node scripts/platform-admin.js you@example.com
  Back up:   docker compose --project-directory ${DIR} exec -T mysql sh -c 'MYSQL_PWD="\$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction newday' > newday-backup.sql

Ports: $([[ -n "$DOMAIN" ]] && echo "443 and 80 (nginx)" || echo "3000 (console)") for users and API clients, 3443 for pull-mode gateways only$([[ -n "$GATEWAY_CREDENTIALS" ]] && echo ", and 9443/9445/8443 for the gateway node"). MySQL is not published.
Gateways keep their credentials: the certificate authority is in the database.
This package folder holds the console's secrets and data: delete it once the console works.
EOF
