# Configuration

The console reads its settings from environment variables. In development, put them in `.env` at the repository root (start from `.env.example`). `.env` is git-ignored.

The gateway has its own settings, listed in the [gateway README](../../gateway/README.md#settings).

## Required

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs session tokens. The console refuses to start without it. Use a long random string, and keep it stable: without `PKI_MASTER_KEY`, the key that seals stored private keys is derived from it. |

## Server

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port of the console |
| `APP_URL` | none | The console's public address, for example `https://console.example.com`. Used in invitation links, as the token issuer and in the gateway link certificate. Set it in production. |
| `NODE_ENV` | none | `production` adds `Secure` to the session cookie. Serve the console over HTTPS when you set it. |

## Database

| Variable | Default | Purpose |
|---|---|---|
| `DB_DIALECT` | `mysql` | `mysql`, or `sqlite` for local runs and tests |
| `DB_HOST` | `127.0.0.1` | MySQL host |
| `DB_PORT` | `3306` | MySQL port |
| `DB_NAME` | `newday` | Database name |
| `DB_USER` | `root` | Database user |
| `DB_PASSWORD` | empty | Database password |
| `DB_STORAGE` | `:memory:` | SQLite file, when `DB_DIALECT=sqlite` |
| `DB_SYNC_ALTER` | off | `true` lets Sequelize alter existing tables on startup. Leave it off and use `npm run migrate-data` instead. |

## Email

Without `SMTP_HOST`, invitations aren't emailed. The console shows the invitation link to share instead.

| Variable | Default | Purpose |
|---|---|---|
| `SMTP_HOST` | none | Mail server; turns email on |
| `SMTP_PORT` | `587` | Mail server port |
| `SMTP_SECURE` | `false` | `true` for TLS from the start (usually port 465) |
| `SMTP_USER` | none | Mail server user |
| `SMTP_PASS` | none | Mail server password |
| `MAIL_FROM` | `SMTP_USER` | Sender address |

## Keys and certificates

| Variable | Default | Purpose |
|---|---|---|
| `PKI_MASTER_KEY` | derived from `JWT_SECRET` | 32 random bytes, base64 (`openssl rand -base64 32`). Seals the private keys stored in the database: the management CA, the console's certificates and uploaded handler keys. Set it in production, back it up, and never change it afterwards. |

## Gateway link

The link is an mTLS listener that pull-mode gateways call to register, fetch configuration, report usage and check admin UI sign-ins. It only accepts certificates issued by the console's CA.

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_LINK_ENABLED` | `true` | `false` turns the link off (push mode only) |
| `GATEWAY_LINK_PORT` | `3443` | Port of the link |
| `GATEWAY_LINK_HOST` | `0.0.0.0` | Address it listens on |
| `GATEWAY_LINK_PUBLIC_URL` | `APP_URL` host, port 3443 | The address gateways use. Its host name goes into the link certificate, together with `localhost`, `127.0.0.1` and `host.docker.internal`. The certificate is reissued when this changes. |

## Gateway pushes and usage

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_AUTO_PUSH` | `true` | `false` turns auto-push off for every gateway, whatever their own setting |
| `GATEWAY_AUTO_PUSH_DELAY_MS` | `2000` | How long after the last change an auto-push waits |
| `GATEWAY_USAGE_COLLECT_MS` | `60000` | How often usage is collected from push nodes; `0` turns it off. Pull nodes report usage themselves. |

## Rate limits on sign-in and tokens

Counted in memory, per console process.

| Variable | Default | Limit |
|---|---|---|
| `LOGIN_RATE_LIMIT_MAX` | `10` | Failed sign-ins per 15 minutes |
| `REGISTER_RATE_LIMIT_MAX` | `20` | Registrations per hour |
| `TOKEN_RATE_LIMIT_MAX` | `30` | Requests to `/oauth/token` per 15 minutes |
