#!/usr/bin/env bash
# Creates one gateway on Azure, in its own resource group and virtual network, with the Azure CLI:
#   - an Azure Container Registry with the gateway image, built in Azure from gateway/ (no local
#     Docker needed)
#   - a Key Vault holding the gateway's credentials file
#   - NODES Ubuntu 24.04 VMs running the gateway container, each with a static public IP so the
#     console can push to it, and a managed identity that may pull the image and read the secret
#   - a Standard Load Balancer in front of the connection handler port
#
#   az login
#   LOCATION=westeurope PREFIX=oauth GATEWAY=public ADMIN_CIDR=198.51.100.7/32 \
#   CONSOLE_CIDR=203.0.113.10/32 CREDENTIALS_FILE=./public-credentials.json \
#     bash deploy/azure/provision-gateway.sh
#
# CONSOLE_CIDR is the console's outbound address: only it may reach the management port 9443.
# CREDENTIALS_FILE is downloaded from the gateway's page in the console.
#
# Optional:
#   NODES (2), VM_SIZE (Standard_B2s), HANDLER_PORT (8443: the handler's port in the console,
#   "https" there: the load balancer passes TCP through), PUBLIC_PORT (443), IMAGE_TAG (the
#   gateway's package.json version), VNET_PREFIX (10.60), SSH_KEY (~/.ssh/id_ed25519.pub),
#   RESOURCE_GROUP (<PREFIX>-gw-<GATEWAY>), ACR and KEY_VAULT (globally unique names; random
#   suffix by default), MANAGEMENT_URL (the console link, for pull mode instead of pushes).
#
# Run it once per gateway. To roll out a new image later, see deploy/cloud/gateway-node.sh.
set -euo pipefail

: "${LOCATION:?}" "${ADMIN_CIDR:?}" "${CREDENTIALS_FILE:?the credentials file from the console}"
[[ -n "${MANAGEMENT_URL:-}" || -n "${CONSOLE_CIDR:-}" ]] || { echo "Set CONSOLE_CIDR (push) or MANAGEMENT_URL (pull)" >&2; exit 2; }
[[ -f "$CREDENTIALS_FILE" ]] || { echo "No file $CREDENTIALS_FILE" >&2; exit 2; }
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}
[[ -f "$SSH_KEY" ]] || { echo "No public key at $SSH_KEY (set SSH_KEY)" >&2; exit 2; }
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX=${PREFIX:-oauth}
GATEWAY=${GATEWAY:-gateway}
NAME="${PREFIX}-gw-${GATEWAY}"
RG=${RESOURCE_GROUP:-$NAME}
NET=${VNET_PREFIX:-10.60}
NODES=${NODES:-2}
VM_SIZE=${VM_SIZE:-Standard_B2s}
HANDLER_PORT=${HANDLER_PORT:-8443}
PUBLIC_PORT=${PUBLIC_PORT:-443}
IMAGE_TAG=${IMAGE_TAG:-$(node -p "require('${REPO_ROOT}/gateway/package.json').version" 2>/dev/null || echo 1.0.0)}
SUFFIX=$(openssl rand -hex 3)
ACR=${ACR:-$(echo "${PREFIX}gw${SUFFIX}" | tr -dc 'a-z0-9')}
KV=${KEY_VAULT:-${PREFIX}-gw-${SUFFIX}}
IMAGE="${ACR}.azurecr.io/oauth-gateway:${IMAGE_TAG}"
TAGS="project=${PREFIX} gateway=${GATEWAY}"

az() { command az --output none "$@"; }
azq() { command az --output tsv "$@"; }
step() { echo; echo "==> $*"; }

step "Resource group ${RG} in ${LOCATION}"
az group create -n "$RG" -l "$LOCATION" --tags $TAGS

step "Image ${IMAGE} (built by ACR Tasks)"
az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled false --tags $TAGS
command az acr build -r "$ACR" -t "oauth-gateway:${IMAGE_TAG}" "${REPO_ROOT}/gateway"
ACR_ID=$(azq acr show -n "$ACR" --query id)

step "Credentials in Key Vault ${KV}"
az keyvault create -g "$RG" -n "$KV" -l "$LOCATION" --enable-rbac-authorization true --retention-days 90 --tags $TAGS
KV_ID=$(azq keyvault show -n "$KV" --query id)
az role assignment create --role "Key Vault Secrets Officer" --assignee-object-id "$(azq ad signed-in-user show --query id)" --assignee-principal-type User --scope "$KV_ID"
for attempt in $(seq 1 20); do
  command az keyvault secret set --vault-name "$KV" -n credentials --file "$CREDENTIALS_FILE" --encoding utf-8 --output none 2>/dev/null && break
  [[ $attempt -eq 20 ]] && { echo "Could not store the credentials in ${KV}" >&2; exit 1; }
  sleep 10   # the role assignment takes a moment to apply
done
echo "    Stored. Delete the local copy once the nodes are up: it holds the gateway's private key."

step "Network ${NET}.0.0/16"
az network vnet create -g "$RG" -n "${NAME}-vnet" --address-prefixes "${NET}.0.0/16" --subnet-name nodes --subnet-prefixes "${NET}.1.0/24" --tags $TAGS
az network nsg create -g "$RG" -n "${NAME}-nsg" --tags $TAGS
rule() { az network nsg rule create -g "$RG" --nsg-name "${NAME}-nsg" -n "$1" --priority "$2" --protocol Tcp --access Allow --direction Inbound --source-address-prefixes "$3" --destination-port-ranges "$4"; }
rule api 100 Internet "$HANDLER_PORT"              # API traffic (the load balancer keeps the client's address)
rule probe 110 AzureLoadBalancer 9080              # health probe: /readyz
rule admin-ui 120 "$ADMIN_CIDR" 9445
rule ssh 130 "$ADMIN_CIDR" 22
[[ -n "${CONSOLE_CIDR:-}" ]] && rule management 140 "$CONSOLE_CIDR" 9443   # console pushes (mTLS)
az network vnet subnet update -g "$RG" --vnet-name "${NAME}-vnet" -n nodes --network-security-group "${NAME}-nsg"

step "Load balancer ${PUBLIC_PORT} -> ${HANDLER_PORT}"
az network public-ip create -g "$RG" -n "${NAME}-lb-ip" --sku Standard --allocation-method Static --tags $TAGS
az network lb create -g "$RG" -n "${NAME}-lb" --sku Standard --public-ip-address "${NAME}-lb-ip" \
  --frontend-ip-name api --backend-pool-name nodes --tags $TAGS
az network lb probe create -g "$RG" --lb-name "${NAME}-lb" -n ready --protocol Http --port 9080 --path /readyz --interval 5
# The nodes have their own public IPs for outbound traffic.
az network lb rule create -g "$RG" --lb-name "${NAME}-lb" -n api --protocol Tcp \
  --frontend-port "$PUBLIC_PORT" --backend-port "$HANDLER_PORT" --frontend-ip-name api --backend-pool-name nodes \
  --probe-name ready --disable-outbound-snat true --idle-timeout 15

step "Nodes: ${NODES} x ${VM_SIZE}"
NODE_URLS=()
for i in $(seq 1 "$NODES"); do
  vm="${NAME}-${i}"
  custom_data="$(mktemp)"
  {
    echo "#!/usr/bin/env bash"
    printf 'CLOUD=azure\nIMAGE=%q\nNODE_NAME=%q\nHANDLER_PORTS=%q\nCREDENTIALS=%q\nMANAGEMENT_URL=%q\n' \
      "$IMAGE" "gw-${i}" "$HANDLER_PORT" "${KV}/credentials" "${MANAGEMENT_URL:-}"
    echo "export CLOUD IMAGE NODE_NAME HANDLER_PORTS CREDENTIALS MANAGEMENT_URL"
    cat "${REPO_ROOT}/deploy/cloud/gateway-node.sh"
  } > "$custom_data"
  az vm create -g "$RG" -n "$vm" --image Canonical:ubuntu-24_04-lts:server:latest --size "$VM_SIZE" \
    --vnet-name "${NAME}-vnet" --subnet nodes --nsg "" \
    --public-ip-address "${vm}-ip" --public-ip-sku Standard \
    --admin-username azureuser --ssh-key-values "$SSH_KEY" \
    --assign-identity --custom-data "$custom_data" --os-disk-size-gb 30 --tags $TAGS
  rm -f "$custom_data"
  principal=$(azq vm show -g "$RG" -n "$vm" --query identity.principalId)
  az role assignment create --role AcrPull --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal --scope "$ACR_ID"
  az role assignment create --role "Key Vault Secrets User" --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal --scope "$KV_ID"
  nic_id=$(azq vm show -g "$RG" -n "$vm" --query 'networkProfile.networkInterfaces[0].id')
  ip_config=$(azq network nic show --ids "$nic_id" --query 'ipConfigurations[0].name')
  az network nic ip-config address-pool add -g "$RG" --nic-name "${nic_id##*/}" --ip-config-name "$ip_config" \
    --lb-name "${NAME}-lb" --address-pool nodes
  ip=$(azq network public-ip show -g "$RG" -n "${vm}-ip" --query ipAddress)
  NODE_URLS+=("gw-${i}  https://${ip}:9443  (admin UI https://${ip}:9445)")
done
LB_IP=$(azq network public-ip show -g "$RG" -n "${NAME}-lb-ip" --query ipAddress)

cat <<EOF

Done. The nodes install Docker and start the gateway in the next few minutes (they wait for
their role assignments to apply).
  Load balancer  ${LB_IP}  (port ${PUBLIC_PORT})
  Nodes:
$(printf '    %s\n' "${NODE_URLS[@]}")

Next, in the console (gateway "${GATEWAY}"):
  1. The handler: port ${HANDLER_PORT}, protocol https, with your API name's certificate
     (Custom certificate), so clients trust it.
  2. $( [[ -n "${MANAGEMENT_URL:-}" ]] && echo "Pull mode: the nodes register themselves under Nodes." || echo "Add each node address above (https://<ip>:9443) under Nodes. The console checks it at once." )
  3. Attach the catalog and push.
  4. DNS: point your API name (e.g. api.example.com) at ${LB_IP} (an A record), and set it as the
     gateway's public URL.
EOF
