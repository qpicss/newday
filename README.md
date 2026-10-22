# OAuth Server

An API management platform you run yourself. Describe your APIs with OpenAPI, bundle them into products, let developers register applications and request access, and serve the traffic through gateways that check OAuth tokens, enforce rate limits and run your policies.

It has two parts:

- **The console** (this directory): an Express app with server-rendered pages and a REST API. It is where organizations design APIs, publish products, approve access and run gateways.
- **The gateway** ([`gateway/`](gateway/README.md)): a separate Node.js runtime with no database. It serves API traffic with the configuration it gets from the console, over mutual TLS.

```
 developer ──► POST /oauth/token ──► console ──── configuration (mTLS) ────► gateway nodes
     │            (client credentials)                                          │
     └──────────────── Authorization: Bearer <token> ──────────────────────────►├──► your upstream APIs
```

## Features

- **Organizations and roles.** Users belong to any number of organizations, as admin or member. Invitations by email or by link, and a platform admin role across all of them.
- **Catalogs, APIs and products.** Import OpenAPI 3.0 or 3.1 documents, group APIs into products with a rate limit and a billing plan, and publish them to your organization's developers.
- **API designer.** Edit endpoints, parameters, request bodies and responses without touching YAML. The **schema designer** edits `components.schemas` as a tree, and the **source editor** edits the whole document with validation.
- **Data dictionary.** Fields and objects defined once and reused across APIs. Importing an API fills it, and you can see which documents are out of date when it changes.
- **Applications and access.** Developers register clients, request access to products and get tokens with the client credentials grant. Each application can have up to 10 extra credential sets for rotation.
- **Gateways.**
  - Push or pull configuration, single nodes or clusters (shared rate limits with Redis), HTTP and HTTPS ports.
  - Request flows built in a visual editor: scripts, conditions, service calls, OpenAPI request and body validation, and threat protection.
  - Upstream connections with retries, circuit breakers, credentials and mTLS.
- **Observability.** Live request log, Prometheus metrics, W3C tracing, off-loading to HTTP or OpenTelemetry, and usage charts per application, product and API.
- **Guided tours and built-in docs.** The **?** button in the console header walks you through the page you are on, and **Docs** in the menu opens this documentation with a guide for each role.

## Quick start

You need Node.js 20 or later. MySQL is optional for a first look.

```bash
npm install
cp .env.example .env              # then set JWT_SECRET to a long random string
npm run dev:sqlite                # SQLite in ./dev.sqlite, no MySQL needed
```

Open <http://localhost:3000> and sign in as `admin@example.com` / `admin12345` (platform admin) or `dev@example.com` / `dev12345`. These accounts are seeded for local use only. Or register a new account, which creates your own organization.

To run against MySQL, create an empty database, fill in the `DB_*` settings in `.env` and run `npm start`.

To serve traffic you also need a gateway. See [Run a gateway](docs/tutorials/04-run-a-gateway.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, configure and sign in for the first time |
| [Concepts](docs/concepts.md) | Organizations, catalogs, products, applications and gateways, and how they fit |
| [Users and roles](docs/users/README.md) | Developers, org admins and site admins: what each can do, with a guide for each |
| [Tutorials](docs/README.md#tutorials) | From an OpenAPI file to a working API call, step by step |
| [Configuration](docs/guides/configuration.md) | Every environment variable |
| [REST API](docs/guides/api-reference.md) | The console's endpoints |
| [API examples](docs/guides/api-examples.md) | End-to-end scripts against the REST API |
| [Managing people](docs/guides/managing-people.md) | Site admins, org admins and members through the API |
| [Operations](docs/guides/operations.md) | Production setup, migrations, backups and certificates |
| [Security](docs/guides/security.md) | What is protected and how |
| [Development](docs/guides/development.md) | Architecture, tests and conventions |
| [Gateway](gateway/README.md) | Running nodes, policies, checks and settings |

## Commands

```bash
npm start                   # the console against MySQL (settings from .env)
npm run dev                 # the same, restarting on changes (nodemon)
npm run dev:sqlite          # the console on ./dev.sqlite, with the demo accounts
npm test                    # console and gateway tests, on in-memory SQLite
npm run migrate-data        # dry run of schema and data migrations
npm run migrate-data -- --apply
```

## Project layout

```
app.js, server.js     the Express app, and the process that syncs the database and listens
routes/               page routes (/developer) and API routes (/api, /auth, /oauth)
controllers/          request handlers
services/, utils/     gateway configuration, the link to gateways, OpenAPI, the dictionary, certificates
models/               Sequelize models; load them through models/index.js
views/, public/       EJS pages saved as .html, page scripts and the stylesheet
scripts/              local SQLite runner and the data migration
gateway/              the gateway runtime, with its own tests, Dockerfile and deploy files
docs/                 documentation and tutorials
test/                 console tests (node:test and supertest)
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
