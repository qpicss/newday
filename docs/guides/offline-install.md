# Installing the console without internet access

How to install the console (management) on a Linux server that can't reach the internet: a private subnet without a NAT gateway, or an isolated network. You build one bundle on a machine that has internet access, copy it to the server and install it there. Nothing is downloaded on the server.

The console needs no internet access at runtime either. It talks only to its database, to your gateways, and to an SMTP relay if you set one.

| Script | Runs on | Does |
|---|---|---|
| `deploy/offline/build-bundle.sh` | a machine with internet access | builds `dist/oauth-console-<version>-linux-<arch>.tar.gz` |
| `install.sh`, inside the bundle | the server | installs Node.js, the console, its service and, with `--domain`, nginx |

For the cloud infrastructure around the console (network, database, secrets), see [Deploying to the cloud](cloud-deployment.md). This page replaces [Phase 3](cloud-deployment.md#phase-3-install-the-console) there.

## What's in the bundle

| Folder | Holds |
|---|---|
| `app/` | The console with its production dependencies already installed. They are all plain JavaScript, so a bundle built on Windows, macOS or Linux runs on Linux. |
| `node/` | The Node.js release for Linux, checked against the SHA-256 that nodejs.org publishes for it. It is installed under `/opt/oauth-console/node` and doesn't touch any other Node.js on the server. |
| `certs/` | Amazon's RDS CA bundle, for TLS to RDS for MySQL. |
| `nginx/` | Only with `NGINX_FOR`: nginx and the packages it needs, as a small apt repository for one Ubuntu release. |
| `install.sh`, `oauth-console.service`, `nginx.conf`, `console.env.example` | The installer and the files it installs. |
| `BUNDLE` | The version, commit, build time, Node.js release and architecture. |

## What the server needs

- Ubuntu 22.04 or 24.04, x64 or arm64, matching the bundle.
- About 300 MB of disk for each release.
- These network paths. None of them leave your network:

| From | To | Port | For |
|---|---|---|---|
| Users, CI, API clients | the console | 443 (nginx), or 3000 behind your own load balancer | the web console, the REST API and `POST /oauth/token` |
| the console | MySQL | 3306 | the database |
| the console | push-mode gateway nodes | 9443 | configuration pushes and status checks |
| pull-mode gateway nodes | the console | 3443 | the gateway link |
| the console | your SMTP relay | 587 | invitation emails (optional) |

The server's clock must be right, because tokens and certificates depend on it. Ubuntu images on AWS and Azure sync with the cloud's own time service, which works without internet access.

## 1. Build the bundle

On a machine with internet access, Node.js 20 or newer and npm, from the repository at the release you want to install:

```bash
git checkout <release>
npm ci && npm test
bash deploy/offline/build-bundle.sh
```

It writes `dist/oauth-console-1.0.0-linux-x64.tar.gz` and its `.sha256` file. Options:

| Setting | Default | Meaning |
|---|---|---|
| `NGINX_FOR` | none | `noble` (Ubuntu 24.04) or `jammy` (22.04): also pack nginx for that release, for `install.sh --domain` on a server without nginx. Needs Docker on the build machine. |
| `ARCH` | `x64` | `arm64` for AWS Graviton or Azure Cobalt servers |
| `NODE_MAJOR` | `22` | the Node.js line; the bundle gets its newest release |
| `NODE_VERSION` | | an exact release instead, such as `22.20.0` |
| `RDS_CA` | `true` | `false` leaves out Amazon's RDS CA bundle (on Azure, say) |
| `OUT_DIR` | `dist` | where to write the bundle |

For example, for an Ubuntu 24.04 Graviton server that needs nginx:

```bash
ARCH=arm64 NGINX_FOR=noble bash deploy/offline/build-bundle.sh
```

The bundle is built for one architecture. With `NGINX_FOR`, it is also built for one Ubuntu release: the installer refuses a server that doesn't match.

## 2. Copy it to the server

Copy both files, the `.tar.gz` and the `.sha256`, by whatever route reaches the server.

**Through a jump host or VPN** (any cloud):

```bash
scp -J admin@bastion.example.com dist/oauth-console-1.0.0-linux-x64.tar.gz* ubuntu@10.40.11.20:
```

**AWS, through S3.** Add an S3 gateway endpoint to the console's VPC: it's free and it reaches S3 in the same region without internet access. Then upload the bundle and download it on the server with a pre-signed URL. The server needs no AWS CLI:

```bash
# on your machine
aws s3 cp dist/oauth-console-1.0.0-linux-x64.tar.gz s3://<bucket>/
aws s3 presign s3://<bucket>/oauth-console-1.0.0-linux-x64.tar.gz --expires-in 3600
# on the server
curl -fo oauth-console-1.0.0-linux-x64.tar.gz '<the pre-signed URL>'
```

To sign in to a private instance without SSH, use Session Manager. It needs interface endpoints for `ssm`, `ssmmessages` and `ec2messages` in the VPC. The instance role from `deploy/aws/provision-console.sh` already allows it.

**Azure, through Azure Bastion** (Standard SKU, with native client support):

```bash
az network bastion tunnel -n <bastion> -g <resource group> --target-resource-id <vm id> --resource-port 22 --port 2222 &
scp -P 2222 dist/oauth-console-1.0.0-linux-x64.tar.gz* azureuser@127.0.0.1:
```

Or put the bundle in a storage account that has a private endpoint in the virtual network, and download it on the server with `curl` and a SAS URL.

## 3. Install

On the server:

```bash
sha256sum -c oauth-console-1.0.0-linux-x64.tar.gz.sha256
tar -xzf oauth-console-1.0.0-linux-x64.tar.gz
cd oauth-console-1.0.0-linux-x64
sudo bash install.sh --domain console.corp.example --cert console.crt --key console.key
```

The installer:

1. Installs Node.js into `/opt/oauth-console/node`.
2. Creates the `oauth-console` system user.
3. Copies the console to `/opt/oauth-console/releases/<version>-<time>` and points `/opt/oauth-console/current` at it.
4. On the first run, creates `/etc/oauth-console/console.env` with a new random `JWT_SECRET` and `PKI_MASTER_KEY`. With `--domain`, it also sets `APP_URL` and `TRUST_PROXY=loopback`. Later runs leave the file alone.
5. Copies the RDS CA bundle to `/etc/oauth-console/rds-global-bundle.pem`.
6. Installs the `oauth-console` systemd service, which runs the bundled Node.js.
7. Adds two commands, `oauth-console-migrate` and `oauth-console-admin`.
8. With `--domain`, sets up nginx:
   - installs nginx from the bundle if it isn't already installed;
   - copies the certificate and key to `/etc/nginx/tls/`;
   - writes a site that serves HTTPS on 443, redirects 80 to it, and proxies to the console on `127.0.0.1:3000`.

Options:

| Option | Meaning |
|---|---|
| `--domain NAME` | serve HTTPS through nginx for this host name |
| `--cert FILE`, `--key FILE` | the certificate (PEM, the server certificate first, then its chain) and its key, without a passphrase. Let's Encrypt can't reach an offline server, so use your company CA or a certificate you bought. |
| `--start` | start the console, or restart it, once installed |

### Where HTTPS ends

Pick one option:

- **nginx on the server** (`--domain`, as above). It is the simplest.
- **Your internal load balancer** (an internal AWS Application Load Balancer with an ACM certificate, or an Azure Application Gateway):
  - run `install.sh` without `--domain`;
  - send the load balancer's traffic to port 3000 on the server, with a health check on `/login`;
  - set `TRUST_PROXY=1` and `APP_URL=https://<the name users open>` in `console.env`.

  The load balancer must keep the `Host` header the browser sent. Both of these do, by default. The console compares `Origin` with `Host` on every change made from the browser.

Either way, the gateway link (3443) is never proxied. It does its own mutual TLS, so pull-mode gateways connect to the console's port 3443 directly. A load balancer in front of it must pass TCP through.

## 4. Settings

Fill in `/etc/oauth-console/console.env` (`sudo nano /etc/oauth-console/console.env`). The full list is in [Configuration](configuration.md).

```bash
DB_HOST=oauth-console-db.abc123.eu-central-1.rds.amazonaws.com
DB_NAME=newday
DB_USER=newday
DB_PASSWORD=<password>
APP_URL=https://console.corp.example
# Amazon RDS:
DB_SSL=true
DB_SSL_CA=/etc/oauth-console/rds-global-bundle.pem
# Azure Database for MySQL: only DB_SSL=true (its CA is one Node.js already trusts)
```

`deploy/cloud/console-env.sh` can't help here: it installs the AWS or Azure CLI from the internet. Copy the values from SSM Parameter Store or Key Vault on your own machine instead. Or install the CLI in your server image and add a VPC endpoint (`ssm`) or a Key Vault private endpoint.

**Moving an existing console to this server?** Replace the generated `JWT_SECRET` and `PKI_MASTER_KEY` with that console's values. The database's private keys are sealed with them, and new values can't open them.

## 5. Start, and the first platform admin

```bash
sudo systemctl enable --now oauth-console
journalctl -u oauth-console -f       # "Database connected successfully", "Server running on port 3000"
```

On an empty database the console creates its tables and its certificate authority on this first start.

Then make yourself the first platform admin. You don't need a MySQL client on the server:

1. Open `https://console.corp.example/register` and register.
2. On the server:

   ```bash
   sudo oauth-console-admin you@example.com
   ```

3. Sign out and in again. **Admin** now appears in the menu.

## Updating

Build a bundle of the new release, copy it, and run its installer. It installs the new release next to the old ones, keeps `console.env`, and restarts the console if it is running.

```bash
# back up the database first (an RDS snapshot, or an Azure on-demand backup)
tar -xzf oauth-console-1.1.0-linux-x64.tar.gz && cd oauth-console-1.1.0-linux-x64
sudo bash install.sh
sudo oauth-console-migrate               # dry run: shows what would change
sudo oauth-console-migrate --apply       # only if the dry run lists changes
sudo systemctl restart oauth-console
```

Pass `--domain`, `--cert` and `--key` again only to replace the certificate or change the host name.

To roll back, point `current` at the previous release:

```bash
ls /opt/oauth-console/releases
sudo ln -sfn /opt/oauth-console/releases/<previous> /opt/oauth-console/current
sudo systemctl restart oauth-console
```

Old releases stay until you delete them: `sudo rm -rf /opt/oauth-console/releases/<old>`. Keep the one `current` points at.

Operating system updates also need a source on an offline server. Use your cloud's patching service with an internal mirror (AWS Systems Manager Patch Manager, Azure Update Manager), or rebuild the server image regularly.

## Gateways without internet access

Gateway nodes need Docker and the gateway image. The provisioning scripts download both on first boot. Without internet access:

1. **Docker:** install it in your node image, or use a distribution that includes it.
2. **The image:** get it to the node one of two ways:
   - from a registry the node can reach privately: ECR through VPC endpoints (`ecr.api`, `ecr.dkr` and the S3 gateway endpoint), or ACR through a private endpoint. Then run `deploy/cloud/gateway-node.sh` as usual;
   - or by hand:

     ```bash
     # on a machine with Docker
     docker build -t oauth-gateway:1.0.0 gateway
     docker save oauth-gateway:1.0.0 | gzip > oauth-gateway-1.0.0.tar.gz
     # on the node, after copying the file
     gunzip -c oauth-gateway-1.0.0.tar.gz | sudo docker load
     ```

     Then start it as in the [gateway README](../../gateway/README.md).
3. **The credentials file:** copy it the same way. It holds the gateway's private key, so delete your local copy afterwards.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `This bundle is for linux-x64; this server is arm64` | Build the bundle with `ARCH=arm64`. |
| `nginx isn't installed and this bundle has none` | Build the bundle with `NGINX_FOR=noble` (or `jammy`), or install nginx from your own mirror. You can also end HTTPS at your load balancer instead. |
| `The bundle's nginx is for Ubuntu noble; this server runs jammy` | Build the bundle with the server's release. |
| `A production dependency has native code` (during the build) | A new dependency needs a compiled part. Build the bundle on Linux with the server's architecture. |
| `nginx: [emerg] ... key values mismatch` | The certificate and key don't belong together, or the chain is in the wrong order: put the server certificate first. |
| The console stops at start-up with a database error | Check `DB_*`, and that the security group or network security group allows 3306 from the console. RDS: `DB_SSL_CA` must point at `rds-global-bundle.pem`. |
| `403` on every change in the browser | A proxy changed the `Host` header. Keep `proxy_set_header Host $host` in nginx, and the original host on your load balancer. |
| All users get rate-limited together | `TRUST_PROXY` is missing, so the console sees the proxy's address. Set `loopback` behind nginx, or `1` behind one load balancer. |
