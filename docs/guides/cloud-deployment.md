# Deploying to the cloud

How to run the console (management) and the gateways on AWS or Azure as separate deployments: the plan of action, the architecture, the network rules and the settings they share. Step-by-step instructions with scripts are in [Deploy on AWS](deploy-aws.md) and [Deploy on Azure](deploy-azure.md).

The scripts live in the repository under `deploy/`:

| Script | Runs on | Does |
|---|---|---|
| `deploy/aws/provision-console.sh` | your machine | VPC, RDS for MySQL, secrets in SSM Parameter Store, the console VM |
| `deploy/aws/provision-gateway.sh` | your machine | ECR image, credentials in Secrets Manager, a VPC, gateway VMs, a Network Load Balancer |
| `deploy/azure/provision-console.sh` | your machine | virtual network, Azure Database for MySQL, Key Vault, the console VM |
| `deploy/azure/provision-gateway.sh` | your machine | ACR image, credentials in Key Vault, a virtual network, gateway VMs, a Standard Load Balancer |
| `deploy/console/install.sh` | the console VM | installs the console as the `oauth-console` systemd service, with nginx and Let's Encrypt |
| `deploy/cloud/console-env.sh` | the console VM | writes `/etc/oauth-console/console.env` from SSM or Key Vault |
| `deploy/cloud/gateway-node.sh` | each gateway VM | starts the gateway container; later `oauth-gateway-node <image>` updates it |

The scripts have been checked for syntax only. Run them in a test account or subscription first.

## What you deploy

| | Console (management) | Gateway |
|---|---|---|
| What it is | The Node.js app in this repository, with a MySQL database | The Node.js app in `gateway/`, as a Docker image. It has no database. |
| Serves | The web console, the REST API, `POST /oauth/token` for access tokens, and the gateway link (3443) | Your APIs, on the connection handler ports. Also an admin UI (9445), health checks and metrics (9080), and a management port for pushes (9443) |
| Instances | **One process.** Sign-in rate limits and auto-push timers live in memory. | Any number of nodes behind a load balancer, all with the same credentials file |
| State | Everything is in MySQL. The private keys there are sealed with `PKI_MASTER_KEY`. | The last configuration, on its data volume. A restarted node serves at once. |
| Who calls it | People, CI scripts, API clients asking for tokens | API clients. The console, in push mode. |

Why deploy them separately:

- Gateways take all API traffic. The console doesn't, so each can be sized and scaled on its own.
- Gateways keep serving with their last configuration while the console is down, upgraded or restored.
- Gateways can run near their backends: in another region, account, subscription or cloud. Only the console's address needs to reach them, or theirs the console.
- A gateway exposes only its handler ports to the internet. The console's database stays private.

## Architecture

```text
                   people, CI, API clients asking for tokens
                                   │ HTTPS 443
                                   ▼
 ┌──────────────── console network (VPC / VNet) ────────────────┐
 │  console VM                                                  │
 │    nginx :443 (Let's Encrypt) ──► console :3000              │
 │    gateway link :3443 (mTLS, pull nodes only)                │
 │                 │ 3306 (TLS)                                 │
 │                 ▼                                            │
 │    managed MySQL (RDS / Azure Database for MySQL), private   │
 └─────────────────┬────────────────────────────────────────────┘
                   │ push: HTTPS 9443, mTLS, from the console's public IP only
                   ▼
 ┌──────────────── gateway network (separate VPC / VNet) ───────┐
 │  load balancer :443 ──► node 1 :8443   node 2 :8443   ...    │
 │      probes /readyz on :9080                                 │
 │  admin UI :9445 (your address only)                          │
 │        │                                                     │
 │        ▼ HTTP(S) to your backends                            │
 └──────────────────────────────────────────────────────────────┘
                   ▲
                   │ HTTPS 443: API calls with Bearer tokens
              API clients
```

API clients get a token from the console (`https://console.example.com/oauth/token`) and call the API through the gateway (`https://api.example.com/<base path>/...`). The gateway checks the token with the public key in its configuration. It never calls the console per request. See [Getting an access token](access-tokens.md).

## Plan of action

Work through the phases in order. Each ends with a check that it is done.

### Phase 0: Decide

| Decision | Options | Recommendation |
|---|---|---|
| Cloud and region | AWS, Azure, or the console in one and the gateways in the other | Run the console where your team and database are. Run the gateways near the backends they call. |
| Host names | One for the console, one per gateway | `console.example.com` and `api.example.com`. You need to be able to create DNS records for both. |
| How the console reaches nodes | **Push**: the console connects to each node on 9443. **Pull**: nodes connect to the console's link on 3443. | Push for fixed VMs (what the scripts build). Pull for nodes that come and go (scale sets, autoscaling groups) or that the console can't reach. |
| Where API TLS ends | At the load balancer (AWS NLB with an ACM certificate; the handler is `http`) or on the nodes (an `https` handler with your certificate, TCP passed through) | AWS: at the NLB. Azure: on the nodes, since Azure Load Balancer works at layer 4. |
| Exact rate limits across nodes | Without Redis each node enforces its share of a limit. With `GATEWAY_REDIS_URL` the nodes share counters. | Start without. Add ElastiCache or Azure Cache for Redis when the limits must be exact. |
| Database availability | Single instance, or Multi-AZ / zone-redundant HA | Single for test. HA for production (`MULTI_AZ=true` on AWS, or HA in the Azure portal). |
| Sizes | Console: 2 vCPU, 2 to 4 GB. Database: the smallest burstable class. Gateways: 2 vCPU, 2 GB each, at least 2 nodes. | Start small: they all scale vertically without a reinstall, and gateways also by adding nodes. |

**Done when** you have the host names, the region(s), push or pull, and where TLS ends.

### Phase 1: Prepare

1. Install the AWS CLI v2 (`aws configure`) or the Azure CLI (`az login`) on your machine, plus `openssl`, `git` and, for AWS, Docker.
2. Find your public address for the admin rules (SSH, admin UI): `curl -s https://checkip.amazonaws.com`, then use it as `ADMIN_CIDR=<ip>/32`.
3. AWS: create or pick an EC2 key pair. Azure: have an SSH public key (`ssh-keygen -t ed25519`).
4. Check out the release you will deploy, and run the tests: `npm ci && npm test`.

**Done when** `aws sts get-caller-identity` or `az account show` answers, and the tests pass.

### Phase 2: Console infrastructure

Run `deploy/aws/provision-console.sh` or `deploy/azure/provision-console.sh`. It creates the network, the private MySQL database, the secrets (generated by the script, stored in the secret store and never printed) and the VM with its static IP. Write down the IP it prints.

Then create the DNS record: `console.example.com` → that IP.

**Done when** the database is available, the VM answers SSH, and `dig +short console.example.com` returns the IP.

### Phase 3: Install the console

On the console VM:

1. Copy the code (`git archive`) and run `sudo bash deploy/console/install.sh --domain console.example.com --email ops@example.com`. That installs Node.js 20, the service, nginx and a Let's Encrypt certificate.
2. Run `deploy/cloud/console-env.sh` to write the settings from the secret store.
3. Start it: `sudo systemctl enable --now oauth-console`. On an empty database it creates the tables and its certificate authority.
4. Create the first platform admin (see [First platform admin](#first-platform-admin)).
5. Optional: add `SMTP_*` to `/etc/oauth-console/console.env` for invitation emails, then restart.

**Done when** `https://console.example.com/login` loads with a valid certificate, you are signed in as a platform admin, and `journalctl -u oauth-console` shows `Database connected successfully`.

### Phase 4: Create the gateway in the console

As an org admin of the organization that will run the gateway:

1. **Gateways → New gateway**, with the public URL `https://api.example.com`.
2. Add a connection handler: port `8443`. Use protocol `http` when the AWS NLB ends TLS, or `https` with your certificate (**Custom certificate**) when the nodes do.
3. **Download credentials.** This file holds the gateway's private key. The next phase puts it in the secret store; delete your local copy after that.

**Done when** you have the credentials file and the handler's port and protocol.

### Phase 5: Gateway infrastructure

Run `deploy/aws/provision-gateway.sh` or `deploy/azure/provision-gateway.sh` with `CONSOLE_CIDR=<console IP>/32` and the credentials file. It builds the image, stores the credentials, and creates the gateway network, the VMs and the load balancer. The nodes start the container by themselves within a few minutes.

**Done when** each node answers `curl http://<node ip>:9080/healthz` from inside the network (or `sudo docker ps` on the node shows `gateway` as healthy). Until the first push, `/readyz` fails and the load balancer shows the nodes as unhealthy. That is expected.

### Phase 6: Connect and deploy

1. In the console, on the gateway's page, add each node address the script printed: `https://<node ip>:9443`. The console checks each one at once.
2. Attach the catalog and turn on auto-push.
3. **Push configuration.** The load balancer turns healthy once `/readyz` passes.
4. Create the DNS record for the API: `api.example.com` → the load balancer (a CNAME on AWS, an A record on Azure).

The same can be scripted: see [Connect a gateway with the API](#connect-a-gateway-with-the-api).

**Done when** every node shows the deployed configuration under **Nodes**, and the setup checklist on the gateway page is complete.

### Phase 7: Verify

1. As a developer, create an application, subscribe it to a product, and have the subscription approved.
2. Get a token: `curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://console.example.com/oauth/token`.
3. Call an API through the gateway: `curl -H "Authorization: Bearer $TOKEN" https://api.example.com/<base path>/<path>`.
4. Check **Live requests** on the gateway page: every step of the call is listed.
5. Stop one node (`sudo docker stop gateway`). Calls keep working through the other one, and the console marks it **Unreachable**. Start it again.
6. Stop the console (`sudo systemctl stop oauth-console`). The gateway keeps serving, but new tokens can't be issued. Start it again.

**Done when** all six behave as described.

### Phase 8: Harden and operate

- Confirm the database backups (RDS automated backups / Azure backup retention: 7 days in the scripts) and keep `JWT_SECRET` and `PKI_MASTER_KEY` in a second place outside the cloud account. A database backup is useless without the master key.
- Point monitoring at each node's `/metrics` (Prometheus on 9080) and alert on the load balancer's unhealthy host count.
- Keep the admin rules (22, 9445) limited to your own addresses, or close 22 and use AWS Session Manager / Azure Bastion.
- Decide who may sign up. Anyone who can open the console can register an account and an organization. To prevent that, limit port 443 on the console to your networks. The console has no setting to turn registration off.
- Plan upgrades: [Updating](#updating).

**Done when** backups, secrets and alerts are in place and an upgrade has been rehearsed in the test environment.

## Network: who talks to whom

| From | To | Port | Why | Opened by the scripts |
|---|---|---|---|---|
| Everyone | Console | 443, 80 | Web console, REST API, `/oauth/token`. 80 only redirects and renews the certificate. | yes |
| Console | MySQL | 3306 | Database, over TLS, inside the console network | yes |
| Console | Each gateway node | 9443 | Push mode: configuration, status, usage, request log, flow tests, certificate renewal. Mutual TLS. | yes, from `CONSOLE_CIDR` only |
| Gateway nodes | Console | 3443 | Pull mode only: register, fetch configuration, report usage, check admin UI sign-ins. Mutual TLS. | only with `LINK_CIDRS` |
| API clients | Gateway load balancer | 443 | API traffic | yes |
| Load balancer | Gateway nodes | handler port (8443) | API traffic. Both load balancers keep the client's address. | yes |
| Load balancer | Gateway nodes | 9080 | Health probe `GET /readyz` | yes, from inside the network only |
| You | Gateway nodes | 9445 | Admin UI | yes, from `ADMIN_CIDR` only |
| You | All VMs | 22 | SSH | yes, from `ADMIN_CIDR` only |
| Gateway nodes | Your backends | as needed | Upstream calls | outbound is open |
| Console | SMTP server | 587 / 465 | Invitation emails | outbound is open |

Never terminate TLS for 9443 or 3443 at a load balancer or proxy: both check client certificates themselves. Forward them as plain TCP if anything sits in between.

## Settings for the console in the cloud

`deploy/cloud/console-env.sh` writes these to `/etc/oauth-console/console.env`. See [Configuration](configuration.md) for every setting.

```bash
NODE_ENV=production                 # Secure session cookie
PORT=3000                           # nginx proxies 443 to it
APP_URL=https://console.example.com # token issuer, invitation links, link certificate
TRUST_PROXY=loopback                # nginx on the same VM: rate limits see the caller's address
GATEWAY_LINK_PUBLIC_URL=https://console.example.com:3443
DB_HOST=...                         # RDS endpoint, or <server>.mysql.database.azure.com
DB_PORT=3306
DB_NAME=newday
DB_USER=oauthadmin
DB_PASSWORD=...                     # from the secret store
DB_SSL=true                         # Azure requires TLS; use it with RDS too
DB_SSL_CA=/etc/oauth-console/rds-global-bundle.pem   # AWS only
JWT_SECRET=...                      # from the secret store, never changes
PKI_MASTER_KEY=...                  # from the secret store, never changes
```

Notes:

- **`APP_URL` is the token issuer.** Changing it later invalidates the tokens in circulation until they expire (10 minutes) and changes the link certificate. Pick the final name before go-live.
- **`TRUST_PROXY`.** Use `loopback` for nginx on the VM, as the scripts set up. If you put a cloud load balancer (ALB, Application Gateway) in front of nginx, use `2`. If the load balancer talks to the console directly, use `1`. Without it, every caller shares the proxy's sign-in limit. Set it only when there really is a proxy, or callers could pick their own address.
- **Host name.** The console compares a browser's `Origin` with the `Host` header to block cross-site requests. Any proxy in front must pass the original `Host` (nginx: `proxy_set_header Host $host`; Azure Application Gateway: don't override the host name).
- **Upload sizes.** OpenAPI imports and policies can be a few MB. nginx allows 8 MB (`client_max_body_size`).

## First platform admin

A new database has no platform admin. Create one:

1. Open `https://console.example.com/register` and register. You become the admin of a new organization.
2. Promote the account in the database, from the console VM:

   ```bash
   sudo apt-get install -y mysql-client
   source <(sudo grep -E '^DB_(HOST|NAME|USER|PASSWORD)=' /etc/oauth-console/console.env)
   MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -u "$DB_USER" --ssl-mode=REQUIRED "$DB_NAME" \
     -e "UPDATE Users SET role='admin' WHERE email='you@example.com';"
   ```

3. Sign out and in again. **Admin** appears in the menu. From then on, promote others in the console ([Guide for site admins](../users/site-admins.md)).

## Connect a gateway with the API

Phases 4 and 6 as a script, for CI or repeated environments. It uses the [REST API](api-reference.md) as an org admin.

```bash
BASE=https://console.example.com
TOKEN=$(curl -s -H "Content-Type: application/json" -d '{"email":"admin@example.com","password":"..."}' $BASE/auth/login | jq -r .token)
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# Phase 4: the gateway, its handler (http: the AWS NLB ends TLS), the credentials file
GATEWAY=$(curl -s "${auth[@]}" -d '{"name":"public","publicUrl":"https://api.example.com"}' $BASE/api/org/gateways | jq -r .gateway.id)
curl -s "${auth[@]}" -d '{"name":"api","port":8443,"protocol":"http"}' $BASE/api/org/gateways/$GATEWAY/handlers | jq .handler.id
curl -s "${auth[@]}" -o public-credentials.json $BASE/api/org/gateways/$GATEWAY/credentials

# Phase 5: run deploy/aws/provision-gateway.sh or deploy/azure/provision-gateway.sh with that file

# Phase 6: the nodes, the catalog, a push
for ip in 203.0.113.21 203.0.113.22; do
  curl -s "${auth[@]}" -d "{\"name\":\"gw-${ip##*.}\",\"url\":\"https://${ip}:9443\"}" $BASE/api/org/gateways/$GATEWAY/nodes | jq '{node: .node.name, check}'
done
curl -s "${auth[@]}" -X PUT -d "{\"catalogId\":\"$CATALOG\",\"autoPush\":true}" $BASE/api/org/gateways/$GATEWAY | jq '.gateway.catalog'
curl -s "${auth[@]}" -X POST $BASE/api/org/gateways/$GATEWAY/push | jq
curl -s "${auth[@]}" $BASE/api/org/gateways/$GATEWAY/status | jq
rm public-credentials.json   # it is in the secret store now
```

Each download of the credentials issues a new certificate. Download once per gateway, and revoke the ones you don't use under **Credentials** on the gateway page.

## Updating

**Console** (a few seconds of downtime; gateways keep serving):

1. Back up the database: an RDS snapshot (`aws rds create-db-snapshot`) or an Azure on-demand backup (`az mysql flexible-server backup create`).
2. Copy the new release to the VM and run `sudo bash deploy/console/install.sh` again. It installs the release next to the old ones and restarts the service.
3. If the release notes mention a migration: run `npm run migrate-data` (the installer prints the full command), check the plan, then run it with `-- --apply`. See [Operations](operations.md#schema-and-data-migrations).
4. Roll back by pointing `/opt/oauth-console/current` at the previous release and restarting.

**Gateways** (no downtime with two or more nodes):

1. Build and push a new image tag. AWS: `IMAGE_TAG=1.1.0` with the commands in [Deploy on AWS](deploy-aws.md#update-the-gateways). Azure: `az acr build`.
2. On each node, one at a time: `sudo oauth-gateway-node <registry>/<image>:1.1.0`. It pulls the image, replaces the container and waits for `/healthz`. The load balancer moves traffic away while the node is down. Use SSM Run Command or `az vm run-command` to do this without SSH.
3. Push from the console, so the nodes get any new configuration fields.

For gateways installed with `gateway/deploy/install.sh` instead of these scripts, use `gateway/deploy/update.sh` ([Update a running gateway](../../gateway/README.md#update-a-running-gateway)).

## Scaling and availability

- **Console.** Scale it vertically (a larger VM). It must stay one process. Protect it with database HA, backups and the two secrets. Rebuilding it means a new VM with the same `console.env` and database. Gateways serve throughout.
- **Gateways.** Add nodes (`NODES=3`, or re-run the node part of the script) and register them. For exact shared rate limits, add Redis in the gateway network and run `sudo REDIS_URL=redis://<host>:6379 oauth-gateway-node` on each node. The setting is saved in `/etc/oauth-gateway/node.env`.
- **Zones.** The AWS script spreads nodes over two availability zones. On Azure, add `--zone 1/2/3` to `az vm create` in regions with zones, and use zone-redundant public IPs.

## Mixing clouds

The console and the gateways only meet over 9443 (push) or 3443 (pull), so they can run in different clouds. For example, the console on AWS and a gateway on Azure:

1. Provision the console on AWS. Note its Elastic IP.
2. Run `deploy/azure/provision-gateway.sh` with `CONSOLE_CIDR=<Elastic IP>/32`.
3. Add the Azure node addresses in the console, and push.

In pull mode, open the console's 3443 to the gateway nodes' public IPs (`LINK_CIDRS`) and pass `MANAGEMENT_URL=https://console.example.com:3443` to the gateway script.

## Go-live checklist

- [ ] `APP_URL` and the host names are final, with valid certificates.
- [ ] `JWT_SECRET` and `PKI_MASTER_KEY` are stored in the secret store and in a second place.
- [ ] `NODE_ENV=production`, `TRUST_PROXY` and `DB_SSL=true` are set.
- [ ] Database backups are on, and one restore has been tested.
- [ ] 9443 is open only from the console's address; 9445 and 22 only from yours.
- [ ] At least two gateway nodes are behind the load balancer, in different zones.
- [ ] The local copies of the credentials files are deleted.
- [ ] Monitoring scrapes `/metrics`; alerts cover unhealthy nodes and console downtime.
- [ ] SMTP works (send yourself an invitation).
- [ ] Sign-up is limited if the console must not be open to everyone.
- [ ] A console upgrade and a gateway image update have been rehearsed.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Database connection failed` on start | Wrong `DB_*`, or TLS: Azure needs `DB_SSL=true`; RDS with `DB_SSL=true` needs `DB_SSL_CA`. Test with the `mysql` command in [First platform admin](#first-platform-admin). |
| 403 on every save in the console | The proxy changes the `Host` header, so the CSRF check fails. Pass the original host. |
| Everyone gets 429 on sign-in after a few failures | `TRUST_PROXY` isn't set, so all callers share the proxy's address. |
| Node shows **Unreachable** | 9443 isn't open from the console's IP, the container isn't running (`sudo docker logs gateway`), or the node address is wrong. |
| Load balancer shows nodes unhealthy | No push yet (`/readyz` waits for a configuration and for every handler to listen), or the handler port in the console differs from `HANDLER_PORT`. |
| Node log: `Not allowed yet ... retrying` | The VM's role assignment isn't applied yet. It retries for 10 minutes. If it still fails, check the instance role / managed identity permissions. |
| Clients get certificate errors from the gateway | The handler uses a certificate issued by the console, which only the console's CA trusts. Use an ACM certificate on the NLB, or a custom certificate on the handler. |
| `401` with a token that works elsewhere | The token's issuer is `APP_URL`. A token from another console, or from before `APP_URL` changed, is refused. |
