#!/usr/bin/env bash
# oauth-gateway-node
# Starts (or updates) one gateway node on an Ubuntu VM in AWS or Azure, as a Docker container.
# The provisioning scripts pass it as the VM's user data / custom data, with the settings below
# filled in above it. The first run saves the settings in /etc/oauth-gateway/node.env and
# installs this script as /usr/local/sbin/oauth-gateway-node. To move the node to another image
# later (one node at a time):
#
#   sudo oauth-gateway-node 123456789012.dkr.ecr.eu-central-1.amazonaws.com/oauth/gateway:1.1.0
#
# The data volume stays, so the node serves its last configuration at once.
#
#   CLOUD          aws | azure
#   IMAGE          registry image, e.g. 123456789012.dkr.ecr.eu-central-1.amazonaws.com/oauth/gateway:1.0.0
#                  or oauthgw.azurecr.io/oauth-gateway:1.0.0
#   NODE_NAME      name shown in the console (gw-1, gw-2, ...)
#   HANDLER_PORTS  connection handler ports to publish, space-separated (e.g. "8443")
#   CREDENTIALS    aws: Secrets Manager secret id; azure: "<vault name>/<secret name>"
#   REGION         aws only
#   MANAGEMENT_URL optional: the console's link address, for pull mode
#   REDIS_URL      optional: shared rate limits across the nodes
#
# The VM's identity must be allowed to read the secret and pull the image (the provisioning
# scripts set that up). The credentials never touch the user data.
set -euo pipefail

CONFIG_DIR=/etc/oauth-gateway
SETTINGS="$CONFIG_DIR/node.env"
SELF=/usr/local/sbin/oauth-gateway-node
KEYS=(CLOUD REGION IMAGE NODE_NAME HANDLER_PORTS CREDENTIALS MANAGEMENT_URL REDIS_URL)
export DEBIAN_FRONTEND=noninteractive

# Settings of the last run fill in whatever isn't set; an image given as argument wins.
if [[ -f "$SETTINGS" ]]; then
  while IFS='=' read -r key value; do
    [[ " ${KEYS[*]} " == *" $key "* && -z "${!key:-}" ]] && printf -v "$key" '%s' "$value"
  done < "$SETTINGS"
fi
[[ -n "${1:-}" ]] && IMAGE=$1
: "${CLOUD:?}" "${IMAGE:?}" "${NODE_NAME:?}" "${CREDENTIALS:?}"
HANDLER_PORTS=${HANDLER_PORTS:-8443}

install -d -m 755 "$CONFIG_DIR"
for key in "${KEYS[@]}"; do printf '%s=%s
' "$key" "${!key:-}"; done > "$SETTINGS"
chmod 644 "$SETTINGS"
if [[ "$(readlink -f "$0")" != "$SELF" ]]; then
  # A copy without the provisioning settings above it, for later updates.
  { echo '#!/usr/bin/env bash'; sed -n '/^# oauth-gateway-node$/,$p' "$0"; } > "$SELF.new"
  chmod 755 "$SELF.new"
  mv "$SELF.new" "$SELF"
fi

log() { echo "==> $*"; }
# Role assignments made just before the VM started can take a few minutes to apply.
retry() {
  local attempt
  for attempt in $(seq 1 30); do
    "$@" && return 0
    log "Not allowed yet (attempt ${attempt}), retrying in 20 s" >&2
    sleep 20
  done
  return 1
}

if ! command -v docker >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  log "Installing Docker and jq"
  apt-get update -y
  apt-get install -y docker.io jq curl
  systemctl enable --now docker
fi

case "$CLOUD" in
  aws)
    : "${REGION:?}"
    if [[ ! -x /snap/bin/aws ]]; then log "Installing the AWS CLI"; snap install aws-cli --classic; fi
    AWS="/snap/bin/aws --region $REGION"
    read_credentials() { $AWS secretsmanager get-secret-value --secret-id "$CREDENTIALS" --query SecretString --output text; }
    registry_login() { $AWS ecr get-login-password | docker login --username AWS --password-stdin "${IMAGE%%/*}"; }
    ;;
  azure)
    if ! command -v az >/dev/null 2>&1; then log "Installing the Azure CLI"; curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash; fi
    # The VM's managed identity: no stored login.
    retry az login --identity --allow-no-subscriptions --output none
    read_credentials() { az keyvault secret show --vault-name "${CREDENTIALS%%/*}" --name "${CREDENTIALS#*/}" --query value --output tsv; }
    registry_login() { az acr login --name "${IMAGE%%.*}"; }
    ;;
  *) echo "CLOUD must be aws or azure" >&2; exit 2 ;;
esac

log "Writing the credentials file"
retry read_credentials > "$CONFIG_DIR/credentials.json.new"
jq -e .gatewayId "$CONFIG_DIR/credentials.json.new" >/dev/null || { echo "The secret is not a gateway credentials file" >&2; exit 1; }
# The container runs as the image's "node" user (uid 1000).
chown 1000:1000 "$CONFIG_DIR/credentials.json.new"
chmod 600 "$CONFIG_DIR/credentials.json.new"
mv "$CONFIG_DIR/credentials.json.new" "$CONFIG_DIR/credentials.json"

log "Pulling ${IMAGE}"
retry registry_login
docker pull "$IMAGE"

ports=(-p 9443:9443 -p 9445:9445 -p 9080:9080)
for port in $HANDLER_PORTS; do ports+=(-p "${port}:${port}"); done
env=(-e "GATEWAY_NODE_NAME=${NODE_NAME}")
[[ -n "${MANAGEMENT_URL:-}" ]] && env+=(-e "GATEWAY_MANAGEMENT_URL=${MANAGEMENT_URL}")
[[ -n "${REDIS_URL:-}" ]] && env+=(-e "GATEWAY_REDIS_URL=${REDIS_URL}")

if docker inspect gateway >/dev/null 2>&1; then
  log "Replacing the running container"
  docker rm -f gateway >/dev/null
fi
docker run -d --name gateway --restart unless-stopped \
  "${ports[@]}" "${env[@]}" \
  -v "$CONFIG_DIR/credentials.json:/etc/oauth-gateway/credentials.json:ro" \
  -v gateway-data:/data \
  --log-opt max-size=50m --log-opt max-file=5 \
  "$IMAGE"

log "Waiting for /healthz"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9080/healthz >/dev/null 2>&1; then
    log "Node ${NODE_NAME} is up. /readyz turns healthy after the console's first push."
    exit 0
  fi
  sleep 2
done
docker logs --tail 50 gateway >&2
echo "The node did not become healthy" >&2
exit 1
