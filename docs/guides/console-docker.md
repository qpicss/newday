# Running the console with Docker

The console can run as containers, like the gateway: the console and its MySQL database on one Docker host, with nginx in front for HTTPS and, if you like, a gateway node next to them. This is also the simplest way to move a running console, with its data, settings and certificates, to another server.

| File | Does |
|---|---|
| `Dockerfile` (repository root) | the console image, `oauth-console:<version>` |
| `deploy/docker/docker-compose.yml` | the stack: `mysql`, `console`, and the profiles `https` (nginx) and `gateway` |
| `deploy/docker/pack.sh` | packs everything for a server: the four images, the stack, the console's settings and its database |
| `deploy/docker/install.sh` | runs on the server: installs Docker when it's missing, loads the images, restores the database, starts the stack |
| `deploy/pki/create-ca.sh` | makes a private certificate chain for HTTPS: a root CA, an intermediate CA and a server certificate, with a PFX of it |

## Pack

On the machine where the console runs now, from the repository, with Docker running:

```bash
bash deploy/docker/pack.sh
```

It writes `dist/oauth-console-docker-<time>.tar.gz` and a `.sha256` file. The package holds:

- **Images:** the console, the gateway, MySQL 8.4 and nginx, saved with `docker save`, so the server doesn't need to reach a registry.
- **`console.env`:** the console's settings from `.env`, without the database connection, which the stack sets. `JWT_SECRET` and `PKI_MASTER_KEY` (if set) move unchanged, because the private keys in the database are sealed with them.
- **`newday.sql`:** a `mysqldump` of the database: users, organizations, APIs, products, gateways, the management CA, gateway credentials, handler certificates, connection secrets and usage. MySQL on Windows stores table names in lower case, while MySQL on Linux is case-sensitive. So the script gives every table the name the console uses (`users` becomes `Users`).

Options: `PFX=<file>` packs an HTTPS certificate as `console.pfx` (see [A private certificate](#a-private-certificate)), `NO_DB=true` for a server that should start empty, `PLATFORM=linux/arm64` for an Arm server, `MYSQLDUMP=<path>` when `mysqldump` isn't on the path (the script also looks under `C:\wamp64\bin\mysql`).

The package holds secrets and a full copy of the data. Copy it with `scp`, and delete it on both machines once the server works.

## Install

On the server (Ubuntu or Debian), from the unpacked package:

```bash
sha256sum -c oauth-console-docker-<time>.tar.gz.sha256
tar -xzf oauth-console-docker-<time>.tar.gz && cd oauth-console-docker-<time>
sudo bash install.sh --domain console.example.com --cert console.crt --key console.key
```

Without a certificate, the console answers on port 3000 over plain HTTP:

```bash
sudo bash install.sh --url http://203.0.113.10:3000
```

In order, the installer:

1. Checks that Docker and its Compose plugin are installed and running. If Docker is missing, it installs it from `get.docker.com`, which needs internet access.
2. Stops and disables an earlier `oauth-console` systemd service, which would hold port 3000.
3. Loads the images from the package.
4. Writes `/opt/oauth-console-docker`:
   - the stack;
   - `console.env`;
   - `.env`, with MySQL passwords made on the first run. They are kept afterwards, because the database volume uses them.
   - With `--domain`, the certificate in `tls/`. `APP_URL` is set to `https://<domain>`, `TRUST_PROXY=1` (one proxy: the nginx container), and port 3000 is published on `127.0.0.1` only.
5. Starts MySQL. If its database is empty, it loads `newday.sql`. A database with tables is kept, unless you pass `--replace-db`.
6. Starts the console (and nginx, and the gateway), runs a dry run of the migration, and waits until the console is healthy.

| Option | Meaning |
|---|---|
| `--domain NAME`, `--cert FILE`, `--key FILE` | HTTPS on 443 through nginx. The certificate is PEM, with the server certificate first and then its chain; the key has no passphrase. |
| `--pfx FILE` | with `--domain`, instead of `--cert` and `--key`: a PFX (PKCS#12) holding the key, the certificate and its chain. Its password comes from `PFX_PASSWORD`, `--pfx-password-file FILE`, or a prompt. A package built with `PFX=` uses its `console.pfx` when `--domain` comes alone. |
| `--url URL` | without `--domain`: the address users open, for `APP_URL` |
| `--gateway FILE` | also run a gateway node on this host, with that gateway's credentials file. Add `https://<this host>:9443` as its node in the console. |
| `--replace-db` | replace a database that already has data with the package's |

MySQL is not published: only the console reaches it.

## Operate

Everything runs from `/opt/oauth-console-docker`:

```bash
cd /opt/oauth-console-docker
docker compose ps
docker compose logs -f console
docker compose restart console
docker compose exec console node scripts/platform-admin.js you@example.com      # first platform admin
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction newday' > newday-backup.sql
```

`install.sh` writes the profiles it turned on (`https`, `gateway`) to `COMPOSE_PROFILES` in `.env`. So plain `docker compose` commands in this folder include nginx and the gateway.

**Upgrade:** build a new package with `NO_DB=true`, copy it to the server and run its `install.sh`. It loads the new images, keeps the database and the settings, and recreates the containers. Then run the migration if the release needs one:

```bash
docker compose exec console node scripts/migrate-data.js            # dry run
docker compose exec console node scripts/migrate-data.js --apply
```

## A private certificate

When the console's name can't get a public certificate (an internal name, or no Let's Encrypt), make your own chain:

```bash
bash deploy/pki/create-ca.sh
```

By default it makes the Mana2.ro chain. For another name, set `NAME="Example" DOMAIN=example.com OUT=example-pki PASSWORDS=example-pki-passwords.txt`. In `mana2-pki/` it writes:

| File | Is |
|---|---|
| `root-ca.crt`, `root-ca.key` | the root CA (10 years) |
| `intermediate-ca.crt`, `intermediate-ca.key` | the intermediate CA, signed by the root (5 years; it can sign server certificates only) |
| `mana2.ro.crt`, `mana2.ro.key` | the server certificate for `mana2.ro` and `*.mana2.ro`, signed by the intermediate (397 days) |
| `mana2.ro-fullchain.crt`, `ca-chain.crt` | the certificate with the intermediate (for a web server); the intermediate with the root |
| `mana2.ro.pfx` | the key, the certificate and the chain, in one file for `install.sh --pfx` |

Every private key is encrypted with its own random password. The passwords go to `mana2-pki-passwords.txt` in the repository folder. That file and `mana2-pki/` are git-ignored: never commit them. Keep the root CA's key offline once the chain exists.

Pack the certificate with the console, then install with it:

```bash
PFX=mana2-pki/mana2.ro.pfx bash deploy/docker/pack.sh
# on the server
sudo bash install.sh --domain mgmt01.mana2.ro          # asks for the PFX password
```

The wildcard `*.mana2.ro` covers the console (`mgmt01.mana2.ro`) and the gateway's public name (`console.mana2.ro`) alike. It covers one level only: `a.b.mana2.ro` needs a certificate of its own.

Browsers and API clients trust the certificate only once they trust the root CA. Install `root-ca.crt` on their machines (on Windows: the *Trusted Root Certification Authorities* store; on Ubuntu: copy it to `/usr/local/share/ca-certificates/mana2-root-ca.crt` and run `update-ca-certificates`). For curl: `--cacert root-ca.crt`.

## Gateways after a move

The certificate authority moves with the database, so every gateway keeps its credentials:

- **Push-mode nodes:** the new server must reach each node on 9443. Check the gateway's node list in the console, then push once.
- **Pull-mode nodes:** set `MANAGEMENT_URL` to `https://<new console name>:3443` and restart them.

The console reissues its link certificate for the new host name by itself.
