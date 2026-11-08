#!/usr/bin/env bash
# Writes /etc/oauth-console/console.env on the console VM from the cloud's secret store, so the
# secrets live in AWS SSM Parameter Store or Azure Key Vault and not in a script or user data.
# Run it after deploy/console/install.sh, and again after changing a secret; then restart:
#
#   sudo CLOUD=aws   REGION=eu-central-1 PREFIX=oauth     DOMAIN=console.example.com bash deploy/cloud/console-env.sh
#   sudo CLOUD=azure VAULT=oauth-console-kv               DOMAIN=console.example.com bash deploy/cloud/console-env.sh
#   sudo systemctl restart oauth-console
#
# Values read (AWS: parameters /<PREFIX>/console/<NAME>; Azure: secrets named in lower case with
# dashes, e.g. jwt-secret): JWT_SECRET, PKI_MASTER_KEY, DB_HOST, DB_NAME, DB_USER, DB_PASSWORD.
# Other lines already in console.env (SMTP_*, GATEWAY_*, ...) are kept.
set -euo pipefail

: "${CLOUD:?aws or azure}" "${DOMAIN:?the console host name, e.g. console.example.com}"
ENV_FILE=/etc/oauth-console/console.env
CONFIG_DIR=/etc/oauth-console
SECRETS=(JWT_SECRET PKI_MASTER_KEY DB_HOST DB_NAME DB_USER DB_PASSWORD)

[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ -d $CONFIG_DIR ]] || { echo "Run deploy/console/install.sh first" >&2; exit 1; }

case "$CLOUD" in
  aws)
    : "${REGION:?}" "${PREFIX:?}"
    if [[ ! -x /snap/bin/aws ]]; then snap install aws-cli --classic; fi
    read_secret() { /snap/bin/aws --region "$REGION" ssm get-parameter --with-decryption --name "/${PREFIX}/console/$1" --query Parameter.Value --output text; }
    # RDS server certificates are signed by Amazon's own CAs, which Node doesn't ship.
    curl -fsSL -o "$CONFIG_DIR/rds-global-bundle.pem" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
    chmod 644 "$CONFIG_DIR/rds-global-bundle.pem"
    DB_TLS=("DB_SSL=true" "DB_SSL_CA=$CONFIG_DIR/rds-global-bundle.pem")
    ;;
  azure)
    : "${VAULT:?}"
    if ! command -v az >/dev/null 2>&1; then curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash; fi
    az login --identity --allow-no-subscriptions --output none
    read_secret() { local name="${1,,}"; az keyvault secret show --vault-name "$VAULT" --name "${name//_/-}" --query value --output tsv; }
    # Azure Database for MySQL's certificates chain to DigiCert roots that Node already trusts.
    DB_TLS=("DB_SSL=true")
    ;;
  *) echo "CLOUD must be aws or azure" >&2; exit 2 ;;
esac

managed=(NODE_ENV PORT APP_URL TRUST_PROXY GATEWAY_LINK_PUBLIC_URL DB_SSL DB_SSL_CA DB_PORT "${SECRETS[@]}")
pattern="^($(IFS='|'; echo "${managed[*]}"))="

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
{
  echo "# Written by deploy/cloud/console-env.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Secrets come from ${CLOUD}."
  echo "NODE_ENV=production"
  echo "PORT=3000"
  echo "APP_URL=https://${DOMAIN}"
  echo "TRUST_PROXY=${TRUST_PROXY:-loopback}"
  echo "GATEWAY_LINK_PUBLIC_URL=https://${DOMAIN}:3443"
  echo "DB_PORT=3306"
  printf '%s\n' "${DB_TLS[@]}"
  for name in "${SECRETS[@]}"; do
    value="$(read_secret "$name")"
    [[ -n "$value" ]] || { echo "Secret $name is empty" >&2; exit 1; }
    echo "${name}=${value}"
  done
  # Settings you added yourself, such as SMTP_HOST, stay.
  [[ -f $ENV_FILE ]] && grep -Ev "$pattern|^# Written by" "$ENV_FILE" | grep -Ev '^\s*$' || true
} > "$tmp"

install -m 640 -o root -g oauth-console "$tmp" "$ENV_FILE"
echo "Wrote ${ENV_FILE}. Restart the console: sudo systemctl restart oauth-console"
