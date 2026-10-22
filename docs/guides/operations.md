# Operations

How to run the console in production, change its database schema safely, back it up and look after gateway certificates.

## Production checklist

- Run on Node.js 20 or later, against MySQL 8 (or MariaDB).
- Set `JWT_SECRET` and `PKI_MASTER_KEY` to random values, store them in your secret manager, and back them up. Losing `PKI_MASTER_KEY` makes the stored private keys unreadable, so every gateway would need new credentials.
- Set `APP_URL` to the public HTTPS address, and `NODE_ENV=production` so the session cookie is `Secure`.
- Put the console behind a reverse proxy that terminates HTTPS. Keep the gateway link port (3443) reachable by pull-mode gateways. It does its own mutual TLS, so pass it through as TCP rather than terminating it.
- If gateways reach the console under a different name than `APP_URL`, set `GATEWAY_LINK_PUBLIC_URL`.
- Configure SMTP so invitations are emailed.
- Run one console process. The sign-in rate limits and auto-push timers live in memory.

See [Configuration](configuration.md) for every setting.

## Starting and stopping

```bash
npm start
```

The process exits with a message if `JWT_SECRET` is missing, if the database is unreachable, or if the port is in use. Use a supervisor (systemd, pm2 or a container runtime) to keep it running.

On startup the console:

- creates tables that don't exist yet;
- creates the management certificate authority on the first run, and reissues the console's own certificates when they near expiry or when the link host names change;
- starts the gateway link (unless `GATEWAY_LINK_ENABLED=false`).

It does **not** change existing tables. That is the job of the migration.

## Schema and data migrations

When an upgrade adds columns or changes stored data, run the migration script. It is safe to run again: anything already in the new format is skipped.

1. **Back up the database first** (see below). MySQL can't roll schema changes back.
2. See what would change:

   ```bash
   npm run migrate-data
   ```

3. Apply it:

   ```bash
   npm run migrate-data -- --apply
   ```

4. Restart the console.

The script applies schema changes first, then converts data in one transaction. The header of `scripts/migrate-data.js` lists everything it does.

`DB_SYNC_ALTER=true` lets Sequelize alter tables on startup instead. Don't use it in production.

## Backups

Back up the MySQL database, and keep `JWT_SECRET` and `PKI_MASTER_KEY` with it. The database holds the sealed private keys; without the master key they can't be opened.

```bash
mysqldump --single-transaction --routines --triggers -u <user> -p <database> > backups/console-$(date +%Y%m%d-%H%M%S).sql
```

On Windows with WAMP, `mysqldump` is under `C:\wamp64\bin\mysql\<version>\bin`. The `backups/` folder is git-ignored.

To restore, load the dump into an empty database and start the console with the same `JWT_SECRET` and `PKI_MASTER_KEY`.

Gateways keep their last configuration on disk, so they keep serving traffic while the console is down or being restored.

## Gateway certificates

Every gateway has certificates issued by the console's CA. The gateway page lists them under **Credentials**:

- **Renew** issues a new certificate. Push nodes get it straight away; pull nodes pick it up at their next heartbeat. Nodes switch without restarting.
- **Revoke** blocks a certificate on the link and for pushes. Use it when a credentials file leaks, after renewing.
- The dashboard warns 30 days before a certificate in use expires.

To trust gateway admin UIs and HTTPS handlers whose certificates the console issued, trust the management CA. Its certificate is the `managementCa` entry of every gateway credentials file, and the **Gateways** page shows its SHA-256 fingerprint to compare.

## Deploying gateways

The [gateway README](../../gateway/README.md) covers Docker, Docker Compose clusters with Redis, Ubuntu with systemd, upgrades and rollbacks, and every node setting. In short:

- Build or pull the `oauth-server-gateway` image, or run `gateway/deploy/install.sh` on Ubuntu.
- Start each node with the gateway's credentials file. Use pull mode (`GATEWAY_MANAGEMENT_URL`) when the console can't reach the nodes.
- Put a load balancer in front of a cluster. Set `GATEWAY_REDIS_URL` for exact shared rate limits.

## Monitoring

- **Console:** HTTP access logs on stdout (Apache combined format).
- **Gateways:** `/healthz`, `/readyz` and Prometheus `/metrics` on port 9080; JSON logs on stdout; the console's **Live requests** page and usage charts. Off-load request records to your log pipeline or an OpenTelemetry collector in each gateway's **Observability** settings.

## Upgrading

1. Back up the database.
2. Update the code and run `npm install`.
3. Run `npm run migrate-data`, check the plan, then run it with `-- --apply`.
4. Restart the console.
5. Upgrade gateways as described in the gateway README. Push once they're running, so they get any new configuration fields.
