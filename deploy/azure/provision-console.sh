#!/usr/bin/env bash
# Creates the console (management) side on Azure with the Azure CLI:
#   - a resource group and a virtual network with a subnet for the console VM and one delegated
#     to the database
#   - Azure Database for MySQL Flexible Server, reachable only inside the network (private DNS),
#     with 7 days of backups
#   - a Key Vault (RBAC) holding the console's secrets (jwt-secret, pki-master-key, db-*)
#   - an Ubuntu 24.04 VM with a static public IP and a managed identity that may read them
#
#   az login
#   LOCATION=westeurope PREFIX=oauth ADMIN_CIDR=198.51.100.7/32 SSH_KEY=~/.ssh/id_ed25519.pub \
#     bash deploy/azure/provision-console.sh
#
# Optional: RESOURCE_GROUP (<PREFIX>-console), VM_SIZE (Standard_B2s), DB_SKU (Standard_B1ms),
# DB_TIER (Burstable), MYSQL_VERSION (8.4; use 8.0.21 where 8.4 isn't offered), VNET_PREFIX (10.50),
# CONSOLE_DOMAIN (used in the printed next steps), LINK_CIDRS (pull-mode gateway addresses allowed
# to reach the link on 3443, space-separated; none by default), KEY_VAULT and DB_SERVER (globally
# unique names; a random suffix by default).
#
# Run it once per environment. Existing secrets in the vault are kept, so a second run never
# replaces jwt-secret or pki-master-key.
set -euo pipefail

: "${LOCATION:?set LOCATION, e.g. westeurope}" "${ADMIN_CIDR:?set ADMIN_CIDR to your address, e.g. 198.51.100.7/32}"
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}
[[ -f "$SSH_KEY" ]] || { echo "No public key at $SSH_KEY (set SSH_KEY)" >&2; exit 2; }
PREFIX=${PREFIX:-oauth}
RG=${RESOURCE_GROUP:-${PREFIX}-console}
NET=${VNET_PREFIX:-10.50}
VM_SIZE=${VM_SIZE:-Standard_B2s}
DB_SKU=${DB_SKU:-Standard_B1ms}
DB_TIER=${DB_TIER:-Burstable}
MYSQL_VERSION=${MYSQL_VERSION:-8.4}
CONSOLE_DOMAIN=${CONSOLE_DOMAIN:-console.example.com}
SUFFIX=$(openssl rand -hex 3)
KV=${KEY_VAULT:-${PREFIX}-console-${SUFFIX}}
DB_SERVER=${DB_SERVER:-${PREFIX}-console-db-${SUFFIX}}
DB_NAME=newday
DB_USER=oauthadmin
VNET="${PREFIX}-console-vnet"
VM="${PREFIX}-console"
TAGS="project=${PREFIX}"

az() { command az --output none "$@"; }
azq() { command az --output tsv "$@"; }
step() { echo; echo "==> $*"; }

step "Resource group ${RG} in ${LOCATION}"
az group create -n "$RG" -l "$LOCATION" --tags "$TAGS"

step "Network ${NET}.0.0/16"
az network vnet create -g "$RG" -n "$VNET" --address-prefixes "${NET}.0.0/16" --subnet-name console --subnet-prefixes "${NET}.1.0/24" --tags "$TAGS"
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n db --address-prefixes "${NET}.2.0/24" --delegations Microsoft.DBforMySQL/flexibleServers
az network nsg create -g "$RG" -n "${VM}-nsg" --tags "$TAGS"
rule() { az network nsg rule create -g "$RG" --nsg-name "${VM}-nsg" -n "$1" --priority "$2" --protocol Tcp --access Allow --direction Inbound --source-address-prefixes "$3" --destination-port-ranges $4; }
rule https 100 Internet "80 443"
rule ssh 110 "$ADMIN_CIDR" 22
priority=120
for cidr in ${LINK_CIDRS:-}; do rule "link-${priority}" "$priority" "$cidr" 3443; priority=$((priority + 1)); done
az network vnet subnet update -g "$RG" --vnet-name "$VNET" -n console --network-security-group "${VM}-nsg"

step "Key Vault ${KV}"
az keyvault create -g "$RG" -n "$KV" -l "$LOCATION" --enable-rbac-authorization true --retention-days 90 --enable-purge-protection true --tags "$TAGS"
KV_ID=$(azq keyvault show -n "$KV" --query id)
ME=$(azq ad signed-in-user show --query id)
az role assignment create --role "Key Vault Secrets Officer" --assignee-object-id "$ME" --assignee-principal-type User --scope "$KV_ID"
secret_exists() { command az keyvault secret show --vault-name "$KV" -n "$1" --query id -o tsv >/dev/null 2>&1; }
set_once() {
  if secret_exists "$1"; then echo "    $1 exists, kept"; return; fi
  # The role assignment above can take a minute to apply.
  for _ in $(seq 1 20); do
    if command az keyvault secret set --vault-name "$KV" -n "$1" --value "$2" --output none 2>/dev/null; then echo "    $1 created"; return; fi
    sleep 10
  done
  echo "Could not write $1 to ${KV}" >&2; exit 1
}
set_once jwt-secret "$(openssl rand -base64 48 | tr -d '\n')"
set_once pki-master-key "$(openssl rand -base64 32)"
set_once db-password "$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 28)Aa1"
set_once db-user "$DB_USER"
set_once db-name "$DB_NAME"
DB_PASSWORD=$(azq keyvault secret show --vault-name "$KV" -n db-password --query value)

step "Azure Database for MySQL ${DB_SERVER} (${DB_TIER} ${DB_SKU}, MySQL ${MYSQL_VERSION}); this takes 5 to 10 minutes"
az mysql flexible-server create -g "$RG" -n "$DB_SERVER" -l "$LOCATION" \
  --admin-user "$DB_USER" --admin-password "$DB_PASSWORD" \
  --sku-name "$DB_SKU" --tier "$DB_TIER" --version "$MYSQL_VERSION" --storage-size 32 --backup-retention 7 \
  --vnet "$VNET" --subnet db --private-dns-zone "${DB_SERVER}.private.mysql.database.azure.com" \
  --tags "$TAGS" --yes
az mysql flexible-server db create -g "$RG" -s "$DB_SERVER" -d "$DB_NAME"
set_once db-host "${DB_SERVER}.mysql.database.azure.com"

step "VM ${VM} (${VM_SIZE}, Ubuntu 24.04)"
az vm create -g "$RG" -n "$VM" --image Canonical:ubuntu-24_04-lts:server:latest --size "$VM_SIZE" \
  --vnet-name "$VNET" --subnet console --nsg "" \
  --public-ip-address "${VM}-ip" --public-ip-sku Standard \
  --admin-username azureuser --ssh-key-values "$SSH_KEY" \
  --assign-identity --os-disk-size-gb 30 --tags "$TAGS"
PRINCIPAL=$(azq vm show -g "$RG" -n "$VM" --query identity.principalId)
az role assignment create --role "Key Vault Secrets User" --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal --scope "$KV_ID"
CONSOLE_IP=$(azq network public-ip show -g "$RG" -n "${VM}-ip" --query ipAddress)

cat <<EOF

Done.
  Resource group ${RG}
  Console VM     ${VM}, public IP ${CONSOLE_IP}
  Database       ${DB_SERVER}.mysql.database.azure.com (private to ${VNET})
  Key Vault      ${KV}

Next:
  1. DNS: point ${CONSOLE_DOMAIN} at ${CONSOLE_IP} (an A record).
  2. Copy the code and install (from your machine, in the repository):
       git archive --format=tar.gz -o oauth.tar.gz HEAD
       scp oauth.tar.gz azureuser@${CONSOLE_IP}:
       ssh azureuser@${CONSOLE_IP} 'mkdir -p oauth && tar -xzf oauth.tar.gz -C oauth'
       ssh azureuser@${CONSOLE_IP} 'cd oauth && sudo bash deploy/console/install.sh --domain ${CONSOLE_DOMAIN} --email ops@example.com'
       ssh azureuser@${CONSOLE_IP} 'cd oauth && sudo CLOUD=azure VAULT=${KV} DOMAIN=${CONSOLE_DOMAIN} bash deploy/cloud/console-env.sh'
       ssh azureuser@${CONSOLE_IP} 'sudo systemctl enable --now oauth-console'
  3. Gateways connect from ${CONSOLE_IP}: pass CONSOLE_CIDR=${CONSOLE_IP}/32 to the gateway script.
EOF
