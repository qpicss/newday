#!/usr/bin/env bash
# Packs the console for a Docker host: every image it runs (console, gateway, MySQL, nginx), the
# compose stack, the installer, this console's settings and a dump of its database with all
# certificates and keys. Run it on the machine where the console runs now, from the repository,
# with Docker and the console's .env:
#
#   bash deploy/docker/pack.sh
#
# Writes dist/oauth-console-docker-<time>.tar.gz (+ .sha256). On the server:
#   tar -xzf oauth-console-docker-<time>.tar.gz && cd oauth-console-docker-<time>
#   sudo bash install.sh --help
#
# Options (environment):
#   NO_DB=true       leave out the database: the server starts with an empty one
#   MYSQLDUMP        the mysqldump program (default: on PATH, or WAMP's under C:\wamp64\bin\mysql)
#   PLATFORM         linux/amd64 (default) or linux/arm64: the server's platform
#   PFX              a PFX with the console's HTTPS certificate (e.g. mana2-pki/mana2.ro.pfx from
#                    deploy/pki/create-ca.sh): packed as console.pfx for install.sh --domain. Its
#                    password is not packed: the installer asks for it (or reads PFX_PASSWORD).
#
# The package holds the console's secrets and data: copy it with scp and delete it afterwards.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLATFORM=${PLATFORM:-linux/amd64}
MYSQL_IMAGE=mysql:8.4
NGINX_IMAGE=nginx:1.27-alpine

info() { echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

cd "$REPO_ROOT"
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || fail "Docker must be running"
[[ -f .env ]] || fail "No .env: run this where the console runs, with its settings."
env_value() { sed -n "s/^$1=//p" .env | tr -d '\r' | tail -1; }

CONSOLE_TAG="$(node -p "require('./package.json').version")"
GATEWAY_TAG="$(node -p "require('./gateway/package.json').version")"
NAME="oauth-console-docker-$(date +%Y%m%d-%H%M)"
OUT="${REPO_ROOT}/dist/${NAME}"
mkdir -p "$OUT/images"
# A failed run leaves nothing behind (the folder holds secrets).
trap '[[ $? -eq 0 ]] || rm -rf "$OUT"' EXIT

info "Images for ${PLATFORM}"
docker build --platform "$PLATFORM" -q -t "oauth-console:${CONSOLE_TAG}" . >/dev/null
docker build --platform "$PLATFORM" -q -t "oauth-server-gateway:${GATEWAY_TAG}" gateway >/dev/null
docker pull -q --platform "$PLATFORM" "$MYSQL_IMAGE" >/dev/null
docker pull -q --platform "$PLATFORM" "$NGINX_IMAGE" >/dev/null
for image in "oauth-console:${CONSOLE_TAG}" "oauth-server-gateway:${GATEWAY_TAG}" "$MYSQL_IMAGE" "$NGINX_IMAGE"; do
  file="$OUT/images/$(echo "$image" | tr ':/' '__').tar.gz"
  docker save "$image" | gzip > "$file"
  echo "    ${image}  $(du -h "$file" | cut -f1)"
done
printf 'CONSOLE_TAG=%s\nGATEWAY_TAG=%s\n' "$CONSOLE_TAG" "$GATEWAY_TAG" > "$OUT/image-tags"

info "Settings (console.env)"
# Everything but the database connection, which the stack sets. JWT_SECRET (and PKI_MASTER_KEY when
# set) must move unchanged: the private keys in the database are sealed with them.
{
  echo "# The console's settings, moved from $(hostname) on $(date +%Y-%m-%d)."
  echo "# KEEP JWT_SECRET (and PKI_MASTER_KEY, if set) UNCHANGED: the private keys in the database are"
  echo "# sealed with them. The database connection comes from docker-compose.yml."
  grep -E '^[A-Z_]+=' .env | tr -d '\r' | grep -vE '^(DB_[A-Z_]+|PORT|SESSION_SECRET|NODE_ENV)='
  grep -qE '^APP_URL=' .env || echo "# APP_URL=https://console.example.com"
} > "$OUT/console.env"
grep -q '^JWT_SECRET=.' "$OUT/console.env" || fail ".env has no JWT_SECRET"
if ! grep -q '^PKI_MASTER_KEY=' "$OUT/console.env"; then
  echo "# No PKI_MASTER_KEY: the stored keys are sealed with a key derived from JWT_SECRET. Don't add one." >> "$OUT/console.env"
fi

if [[ "${NO_DB:-false}" != true ]]; then
  if [[ -z "${MYSQLDUMP:-}" ]]; then
    MYSQLDUMP="$(command -v mysqldump 2>/dev/null || ls /c/wamp64/bin/mysql/*/bin/mysqldump.exe 2>/dev/null | tail -1 || true)"
  fi
  [[ -n "$MYSQLDUMP" ]] || fail "mysqldump not found: set MYSQLDUMP, or NO_DB=true"
  DB_NAME="$(env_value DB_NAME)"
  DB_PORT="$(env_value DB_PORT)"
  info "Database ${DB_NAME} (with ${MYSQLDUMP##*/})"
  MYSQL_PWD="$(env_value DB_PASSWORD)" "$MYSQLDUMP" -h "$(env_value DB_HOST)" -P "${DB_PORT:-3306}" \
    -u "$(env_value DB_USER)" --single-transaction --routines --triggers --events --hex-blob --no-tablespaces \
    --set-gtid-purged=OFF --default-character-set=utf8mb4 "${DB_NAME}" > "$OUT/newday.sql" 2> "$OUT/dump.err" \
    || { cat "$OUT/dump.err" >&2; fail "mysqldump failed"; }
  rm -f "$OUT/dump.err"
  # MySQL on Windows (and macOS) stores table names in lower case; on Linux they are case-sensitive.
  # Give every table the name the console's models use, or it would start on empty tables.
  DB_DIALECT=sqlite DB_STORAGE=:memory: JWT_SECRET=x DOTENV_CONFIG_QUIET=true node -e "
    const fs = require('fs');
    const sequelize = require('./config/database');
    require('./models');
    const names = Object.values(sequelize.models).map((m) => { const t = m.getTableName(); return typeof t === 'string' ? t : t.tableName; });
    const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const file = process.argv[1];
    let renamed = 0;
    const unknown = new Set();
    const sql = fs.readFileSync(file, 'utf8').replace(
      /(DROP TABLE IF EXISTS|CREATE TABLE|LOCK TABLES|ALTER TABLE|INSERT INTO|structure for table|data for table) \x60([^\x60]+)\x60/g,
      (all, keyword, table) => {
        const name = byLower.get(table.toLowerCase());
        if (!name) { unknown.add(table); return all; }
        renamed += 1;
        return keyword + ' \x60' + name + '\x60';
      });
    fs.writeFileSync(file, sql);
    console.log('    ' + (sql.match(/^CREATE TABLE/gm) || []).length + ' tables, ' + renamed + ' names matched to the models' + (unknown.size ? '; not a model: ' + [...unknown].join(', ') : ''));
  " "$OUT/newday.sql"
  chmod 600 "$OUT/newday.sql"
fi
chmod 600 "$OUT/console.env"

cp deploy/docker/install.sh deploy/docker/docker-compose.yml deploy/docker/nginx.conf "$OUT/"
if [[ -n "${PFX:-}" ]]; then
  [[ -f "$PFX" ]] || fail "No PFX at ${PFX}"
  install -m 600 "$PFX" "$OUT/console.pfx"
  info "Certificate: ${PFX} as console.pfx"
fi
cat > "$OUT/README.txt" <<EOF
OAuth Server console for Docker: package made $(date +%Y-%m-%d) from commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)

  images/              console ${CONSOLE_TAG}, gateway ${GATEWAY_TAG}, ${MYSQL_IMAGE}, ${NGINX_IMAGE} (${PLATFORM})
  console.env          the console's settings, with the secrets that unlock its stored keys
  newday.sql           its database: users, organizations, APIs, gateways, the certificate authority,
                       gateway credentials, handler certificates, connection secrets, usage
  docker-compose.yml   console + MySQL (+ nginx for HTTPS, + a gateway node)
  install.sh           the installer: sudo bash install.sh --help

CONTAINS SECRETS: copy it with scp, and delete it once the console works.

On the server (Ubuntu or Debian; Docker is installed if missing, which needs internet access):
  sudo bash install.sh --domain console.example.com --cert console.crt --key console.key
  sudo bash install.sh --url http://<server ip>:3000          (no HTTPS)
$([[ -n "${PFX:-}" ]] && echo "  sudo bash install.sh --domain <console name>               (HTTPS with console.pfx; asks for its password)")
EOF

info "Packing dist/${NAME}.tar.gz"
tar -C "${REPO_ROOT}/dist" --owner=0 --group=0 --mode='go-rwx' -czf "${REPO_ROOT}/dist/${NAME}.tar.gz" "$NAME"
echo "$(sha256 "${REPO_ROOT}/dist/${NAME}.tar.gz")  ${NAME}.tar.gz" > "${REPO_ROOT}/dist/${NAME}.tar.gz.sha256"
rm -rf "$OUT"
echo "Built dist/${NAME}.tar.gz ($(du -h "${REPO_ROOT}/dist/${NAME}.tar.gz" | cut -f1)). It holds secrets: copy it with scp."
