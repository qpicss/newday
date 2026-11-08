# Deploy on Azure

Step by step: the console on an Ubuntu VM with Azure Database for MySQL Flexible Server, and a gateway in its own resource group and virtual network with VMs behind a Standard Load Balancer. Read [Deploying to the cloud](cloud-deployment.md) first for the plan, the architecture and the network rules.

## What you get

| Part | Azure resources | Script |
|---|---|---|
| Console | Resource group `<prefix>-console`. Virtual network `10.50.0.0/16`. VM `Standard_B2s` (Ubuntu 24.04) with a static public IP and a managed identity. MySQL Flexible Server `Standard_B1ms` in a delegated subnet, with private DNS. A Key Vault with RBAC and purge protection. | `deploy/azure/provision-console.sh` |
| Gateway | Resource group `<prefix>-gw-<gateway>`. Container registry (Basic). Key Vault with the credentials file. Virtual network `10.60.0.0/16`. 2 VMs `Standard_B2s` with static public IPs and managed identities. A Standard Load Balancer. | `deploy/azure/provision-gateway.sh` |

## Before you start

- Azure CLI, signed in with `az login`, with the subscription selected (`az account set -s <id>`). You need to be able to create resources and **role assignments**: Owner, or Contributor plus User Access Administrator.
- The scripts give your own account **Key Vault Secrets Officer** on the vaults they create. They read your account with `az ad signed-in-user show`. When you sign in as a service principal, assign that role yourself.
- An SSH key: `ssh-keygen -t ed25519`.
- DNS for two names you control, such as `console.example.com` and `api.example.com`.
- No local Docker needed: the image is built in Azure by ACR Tasks.

Set these once in your shell, from the repository root:

```bash
export LOCATION=westeurope
export PREFIX=oauth
export ADMIN_CIDR="$(curl -s https://checkip.amazonaws.com)/32"
export SSH_KEY=~/.ssh/id_ed25519.pub
export CONSOLE_DOMAIN=console.example.com
```

## 1. Create the console's infrastructure

```bash
bash deploy/azure/provision-console.sh
```

It takes about 10 to 15 minutes and prints the console's IP, the vault's name and the next commands. In order, it:

1. Creates the resource group and the virtual network. The `console` subnet gets a network security group: 80 and 443 from the internet, 22 from `ADMIN_CIDR`, and 3443 from `LINK_CIDRS` (pull mode only). The `db` subnet is delegated to MySQL.
2. Creates the Key Vault (RBAC, soft delete and purge protection). It writes `jwt-secret`, `pki-master-key`, `db-password`, `db-user` and `db-name`, and keeps any that already exist.
3. Creates the MySQL Flexible Server. It is reachable only inside the virtual network, through a private DNS zone, with 7 days of backups and a `newday` database. TLS is required, which is why the console runs with `DB_SSL=true`.
4. Creates the VM with a system-assigned managed identity, which gets **Key Vault Secrets User** on the vault.

Vault and server names must be unique across Azure, so the script adds a random suffix. Pass `KEY_VAULT=` and `DB_SERVER=` to choose them. Because of purge protection, a deleted vault's name stays taken for 90 days.

If the region doesn't offer MySQL 8.4, use 8.0:

```bash
MYSQL_VERSION=8.0.21 bash deploy/azure/provision-console.sh
```

For production, turn on high availability (zone-redundant where offered) and, if you like, geo-redundant backups:

```bash
az mysql flexible-server update -g oauth-console -n <server> --high-availability ZoneRedundant
```

Then create a DNS **A** record: `console.example.com` → the VM's IP. With Azure DNS:

```bash
az network dns record-set a add-record -g <dns resource group> -z example.com -n console -a <console ip>
```

## 2. Install the console

From the repository on your machine:

```bash
CONSOLE_IP=<console ip>
git archive --format=tar.gz -o oauth.tar.gz HEAD
scp oauth.tar.gz azureuser@$CONSOLE_IP:
ssh azureuser@$CONSOLE_IP
```

On the VM:

```bash
mkdir -p oauth && tar -xzf oauth.tar.gz -C oauth && cd oauth
# Node.js 20, the oauth-console service, nginx and a Let's Encrypt certificate (DNS must point here)
sudo bash deploy/console/install.sh --domain console.example.com --email ops@example.com
# console.env from Key Vault, using the VM's managed identity: secrets, DB_SSL=true, APP_URL, TRUST_PROXY
sudo CLOUD=azure VAULT=<vault name> DOMAIN=console.example.com bash deploy/cloud/console-env.sh
sudo systemctl enable --now oauth-console
journalctl -u oauth-console -f     # "Database connected successfully", "Gateway link listening on port 3443"
```

Open `https://console.example.com`, register, and make yourself platform admin: see [First platform admin](cloud-deployment.md#first-platform-admin).

For invitation emails, add the SMTP settings to `/etc/oauth-console/console.env` and restart. With Azure Communication Services Email, use its SMTP host `smtp.azurecomm.net`, port 587, and the SMTP username and Entra application secret it gives you.

## 3. Prepare the gateway in the console

1. Sign in as an org admin. Open **Gateways → New gateway**, named `public`, with the public URL `https://api.example.com`.
2. Add a connection handler on port `8443`, protocol **https**, with your certificate for `api.example.com` (**Custom certificate**). Azure Load Balancer passes TCP through, so the nodes end TLS, and clients must trust that certificate. Get one from your CA, or from Let's Encrypt with a DNS challenge.
3. **Download credentials** to `public-credentials.json`.

Or with the API: see [Connect a gateway with the API](cloud-deployment.md#connect-a-gateway-with-the-api), with `"protocol":"https"`, `"tlsMode":"custom"`, `certificatePem` and `privateKeyPem`.

Prefer to end TLS in Azure instead? Put an **Application Gateway** (with your certificate) in front of an `http` handler, and keep `/readyz` on 9080 as its health probe. Application Gateway sets `X-Forwarded-For` for the gateway. The scripts don't build that option.

## 4. Create the gateway's infrastructure

```bash
CONSOLE_CIDR=<console ip>/32 GATEWAY=public CREDENTIALS_FILE=./public-credentials.json \
  bash deploy/azure/provision-gateway.sh
```

In order, it:

1. Creates the resource group and a container registry with the admin user off. It builds `gateway/` there (`az acr build`) as `<registry>.azurecr.io/oauth-gateway:<version>`.
2. Creates a Key Vault and stores the credentials file in it as the secret `credentials`.
3. Creates a separate virtual network. Its network security group allows:
   - 8443 from the internet;
   - 9080 from `AzureLoadBalancer` (health probe);
   - 9443 from `CONSOLE_CIDR` only;
   - 9445 and 22 from `ADMIN_CIDR`.
4. Creates the Standard Load Balancer:
   - port 443 to 8443 on the nodes, with a probe on `/readyz` at 9080;
   - outbound SNAT off, since each node has its own public IP.
5. Creates the nodes (`NODES=2`). Each gets a static public IP and a managed identity with **AcrPull** on the registry and **Key Vault Secrets User** on the vault, and joins the load balancer's pool.
6. The nodes' custom data is `deploy/cloud/gateway-node.sh`. It:
   - installs Docker and the Azure CLI;
   - signs in with the managed identity;
   - writes the credentials from Key Vault and starts the container `gateway`.

   It retries while the role assignments are still applying.

Delete the local credentials file once the nodes are up: `rm public-credentials.json`.

Check a node (it starts within about 5 minutes; the Azure CLI install takes a while):

```bash
ssh azureuser@<node ip> 'sudo docker ps --filter name=gateway; curl -s localhost:9080/healthz'
# first-boot log: sudo cat /var/log/cloud-init-output.log
```

## 5. Connect and deploy

1. On the gateway's page in the console, add the node addresses the script printed: `https://<node ip>:9443`. The console checks each one.
2. Attach the catalog, turn on auto-push, and click **Push configuration**.
3. Create a DNS **A** record: `api.example.com` → the load balancer's IP.
4. Check the probe sees the nodes. In the portal: Load balancer → **Insights** or **Metrics** → *Health Probe Status*. Or call through the load balancer: `curl -I https://api.example.com/<base path>/<path>`.
5. Run the checks of [Phase 7](cloud-deployment.md#phase-7-verify).

## Update the gateways

Build a new tag in the registry, then move the nodes one at a time with Run Command (no SSH needed):

```bash
RG=oauth-gw-public; ACR=<registry name>
az acr build -r $ACR -t oauth-gateway:1.1.0 gateway
IMAGE=$ACR.azurecr.io/oauth-gateway:1.1.0

for vm in $(az vm list -g $RG --query '[].name' -o tsv); do
  echo "== $vm"
  az vm run-command invoke -g $RG -n $vm --command-id RunShellScript \
    --scripts "/usr/local/sbin/oauth-gateway-node $IMAGE" --query 'value[0].message' -o tsv
  # check before moving on
  az vm run-command invoke -g $RG -n $vm --command-id RunShellScript --scripts 'curl -fsS localhost:9080/healthz' \
    --query 'value[0].message' -o tsv | grep -q '"status"' || { echo "$vm is not healthy, stopping"; break; }
done
```

Then push from the console.

## Update the console

```bash
az mysql flexible-server backup create -g oauth-console -n <server> --backup-name before-$(date +%Y%m%d%H%M)
git archive --format=tar.gz -o oauth.tar.gz HEAD && scp oauth.tar.gz azureuser@$CONSOLE_IP:
ssh azureuser@$CONSOLE_IP 'rm -rf oauth && mkdir oauth && tar -xzf oauth.tar.gz -C oauth && cd oauth && sudo bash deploy/console/install.sh'
```

Run the migration if the release needs one (the installer prints the command), as in [Updating](cloud-deployment.md#updating).

## Optional: Redis for exact rate limits

Create an Azure Cache for Redis with a private endpoint in the gateway virtual network (or Azure Managed Redis). On each node, point the gateway at it:

```bash
sudo REDIS_URL=rediss://:<access key>@<name>.redis.cache.windows.net:6380 oauth-gateway-node
```

## Remove everything

Each part is one resource group:

```bash
az group delete -n oauth-gw-public --yes
az group delete -n oauth-console --yes      # take a backup of the database first if you may need it
```

The Key Vaults stay in a soft-deleted state for 90 days (purge protection is on in the console's vault). Keep a copy of `jwt-secret` and `pki-master-key` with any database backup you keep. Without them it can't be used.
