#!/usr/bin/env bash
# Installs the OAuth Server gateway as a systemd service on Ubuntu 22.04 or 24.04.
#
#   sudo ./deploy/install.sh            # from the gateway/ folder (or gateway/deploy/install.sh from the repo root)
#
# Re-running it installs a new release next to the old ones and switches /opt/oauth-gateway/current.
# Roll back with:  sudo ln -sfn /opt/oauth-gateway/releases/<previous> /opt/oauth-gateway/current && sudo systemctl restart oauth-gateway
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR=/opt/oauth-gateway
CONFIG_DIR=/etc/oauth-gateway
DATA_DIR=/var/lib/oauth-gateway
SERVICE_USER=oauth-gateway
NODE_MAJOR=20
export DEBIAN_FRONTEND=noninteractive

if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root: sudo $0" >&2
  exit 1
fi

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt "$NODE_MAJOR" ]]; then
  echo "==> Installing Node.js ${NODE_MAJOR} from NodeSource"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
echo "==> Using Node.js $(node --version)"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> Creating system user ${SERVICE_USER}"
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 755 "$INSTALL_DIR" "$INSTALL_DIR/releases"
install -d -m 750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"

VERSION="$(node -p "require('${SOURCE_DIR}/package.json').version")"
RELEASE_DIR="${INSTALL_DIR}/releases/${VERSION}-$(date +%Y%m%d%H%M%S)"
echo "==> Installing release ${RELEASE_DIR}"
install -d -m 755 "$RELEASE_DIR"
cp -r "${SOURCE_DIR}/src" "${SOURCE_DIR}/ui" "${SOURCE_DIR}/package.json" "${SOURCE_DIR}/package-lock.json" "$RELEASE_DIR/"
[[ -f "${SOURCE_DIR}/README.md" ]] && cp "${SOURCE_DIR}/README.md" "$RELEASE_DIR/"
(cd "$RELEASE_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
ln -sfn "$RELEASE_DIR" "${INSTALL_DIR}/current"

if [[ ! -f "${CONFIG_DIR}/gateway.env" ]]; then
  install -m 640 -o root -g "$SERVICE_USER" "${SOURCE_DIR}/deploy/gateway.env.example" "${CONFIG_DIR}/gateway.env"
fi

install -m 644 "${SOURCE_DIR}/deploy/oauth-gateway.service" /etc/systemd/system/oauth-gateway.service

if [[ -d /run/systemd/system ]]; then
  systemctl daemon-reload
  if systemctl is-active --quiet oauth-gateway; then
    echo "==> Restarting the running gateway on the new release"
    systemctl restart oauth-gateway
  fi
else
  echo "==> systemd is not running here; the unit was installed but not loaded"
fi

cat <<EOF

Installed. Next steps:
  1. Copy the credentials file downloaded from the gateway's page in the console:
       sudo install -m 600 -o ${SERVICE_USER} <name>-credentials.json ${CONFIG_DIR}/credentials.json
  2. Optional settings: ${CONFIG_DIR}/gateway.env
  3. Start it:
       sudo systemctl enable --now oauth-gateway
       journalctl -u oauth-gateway -f
  4. Open TCP 9443 (management) to the console, and your handler ports to clients.
     Then add https://<this server>:9443 as a node in the console and push.
EOF
