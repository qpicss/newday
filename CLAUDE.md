# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                      # node server.js against MySQL (settings from .env)
npm run dev                    # same, with nodemon
npm run dev:sqlite             # run on ./dev.sqlite, seeding admin@example.com/admin12345 and dev@example.com/dev12345
npm test                       # node:test over test/ and gateway/test/ (in-memory SQLite, no MySQL needed; oldapp/ is excluded)
node --test test/auth.test.js                          # one test file
node --test --test-name-pattern="invitation" test/     # tests whose name matches
npm run migrate-data           # dry run of schema + data migrations against the configured DB
npm run migrate-data -- --apply
```

No linter or build step. Check edited JS with `node --check <file>`.

`server.js` exits if `JWT_SECRET` is unset, if the database is unreachable, or if the port is already in use. Schema changes are **not** applied on startup: `sequelize.sync()` only creates missing tables, and `alter` runs only with `DB_SYNC_ALTER=true`. New columns on existing tables go into `scripts/migrate-data.js`. That script must stay safe to re-run, and it dry-runs unless given `--apply`. Back up MySQL first (`mysqldump`, WAMP binary under `C:\wamp64\bin\mysql\*\bin`; dumps go in the git-ignored `backups/`).

## Architecture

Express 5 + Sequelize (MySQL by default; `DB_DIALECT=sqlite` + `DB_STORAGE` for tests and local runs) with server-rendered EJS templates saved as `.html`.

- **`app.js` builds the app; `server.js` only syncs the DB and listens.** Tests import `app.js` through `test/helpers.js`. The helper sets the SQLite/test environment *before* requiring the app, so every test file must require `./helpers` first.
- **Always load models via `require('../models')`** (`models/index.js`), not individual model files, because all associations are defined there. Associations use `constraints: false` (no DB foreign keys), so deletes cascade manually inside `sequelize.transaction(...)`: tokens and subscriptions when an app is deleted, product links when an API is deleted, and so on.
- **Multi-tenancy:** a user belongs to any number of organizations through `Membership` rows (`role`: `admin` | `member`). `User.organizationId` is the organization currently selected (switched with `PUT /api/me/organization`).
  - `middleware/auth.js` runs `services/membership.js` `resolveActiveOrganization` on every request. It sets `req.user.organizationId`, `req.user.orgRole` (the role there), `req.user.organization` and `req.user.memberships`. Never read or write `User.orgRole` directly: it is a legacy column.
  - The platform-wide `User.role` (`admin` | `user`) is separate and gates `/developer/admin` and `/api/admin`. Platform admins may select any organization and then act as its admin (`req.user.actingAsPlatformAdmin`).
  - Registering creates an organization with the new user as its admin. Invitations add memberships: existing accounts accept with their password. An organization always keeps at least one admin.
  - Tenant data (catalogs, APIs, products, gateways, invitations, members) is always queried with `organizationId: req.user.organizationId`. Records from another organization should return 404, not 403.
- **Domain flow:** organization → catalogs → products and APIs.
  - An `Api` holds an OpenAPI 3.x document in `spec`; parsing, validation and editing live in `utils/openapi.js`.
  - **Data dictionary** (org admins, `/developer/dictionary`, `/api/org/dictionary`): `DictionaryField` (one value's schema, stored 3.0-style and rendered per document version by `utils/dictionary.js`) and `DictionaryObject` + `DictionaryProperty` (each property a field or another object, possibly itself). Names are unique per organization ignoring case.
    - Importing an API fills it (`utils/dictionaryImport.js` plans, `services/dictionary.js` `importIntoDictionary` writes; a clashing name with a different schema gets a qualified name such as `Order.id`).
    - The API designer (`/developer/apis/:id/design` and `/source`, `controllers/apiDesignController.js`, `utils/openapiDesign.js`) writes dictionary objects into `components.schemas` marked `x-dictionary-id`, and field-based parameters/bodies marked `x-dictionary-field`. Documents never change when the dictionary does: `utils/dictionarySync.js` shows what is out of date and `POST /api/org/apis/:id/components/refresh` updates it. A same-named schema the dictionary didn't write is only replaced with `replace: true` (409 with `conflicts` otherwise) unless its content is identical.
    - Object fields may carry a structure (`properties`/`required`, nested schemas without `$ref`), edited on the field page with the same schema editor.
    - The schema editor is `public/js/schema-editor.js` + `views/partials/schema-editor.html` (`SchemaEditor.create`). The schema designer (`/developer/apis/:id/schemas`, `public/js/schema-designer.js`) uses it and edits one `components.schemas` entry in the browser (tree, inspector, undo) and saves it with `PUT /api/org/apis/:id/schemas/:name` (`controllers/schemaDesignController.js`, `utils/schemaDesign.js`): shape and `$ref` checks, rename with every reference, deletes refused while the schema is used. Saving changed content drops the `x-dictionary-id` mark.
    - Body and response schemas written inline in an operation open in the same editor at `/developer/apis/:id/design/schema` (`PUT /api/org/apis/:id/operations/content-schema`, keeping `x-dictionary-field` only while the schema matches the field, or with `updateField`), and `POST …/content-schema/move` turns one into a named `components.schemas` entry.
    - The old `oldapp/` (MySQL schema `platform`) is the previous designer, kept for reference only.
  - Every `Api` and `ApiProduct` belongs to one `Catalog` (`catalogId`, required when creating). A product only takes APIs from its own catalog, through `ProductApi`. `CatalogProduct` is a legacy table used only by the migration.
  - Products carry rate-limit and billing settings (the gateway enforces rate limits; billing is stored only).
  - Members see the published products of the selected organization only (`/api/catalog`, `/developer/catalogs`).
  - An `Application` belongs to the organization it was created in (`organizationId`) and can only subscribe to that organization's products.
  - A `Subscription` starts `pending`; only an admin of the product's organization can move it to `approved`, `rejected` or `revoked`.
  - A gateway is created without a catalog and can only be attached to one while it runs (`isGatewayRunning` in `services/gatewayPush.js`).
- **Shared handlers with scope flags:** the admin routes reuse `applicationController` handlers by setting `req.applicationScope = 'all'`. Page routes in `routes/console.js` reuse each controller's `serialize*` helpers.

### Routing and auth

- `/auth/*` handles register, login, logout and accept-invite, with in-memory rate limiters from `middleware/rateLimit.js`. Tests call `resetRateLimits()`.
- API routes:
  - `/api/applications/*` — the signed-in user's own apps, plus their subscriptions.
  - `/api/org/*` — tenant routes for the selected organization (`requireOrganization`, plus `requireOrgAdmin` for management).
  - `/api/me/*` — the signed-in user's organizations: list, create, switch, leave.
  - `/api/catalog/*` — the cross-organization catalog.
  - `/api/admin/*` — platform admin, including `/api/admin/organizations` (members, catalogs).
- `/developer/*` page routes: `routes/developer.js` mounts `routes/console.js` for the organization, API, product and catalog pages.
- `middleware/auth.js` `authenticate` accepts `Authorization: Bearer <jwt>` or the HttpOnly `token` cookie, and loads `req.user` together with its organization.
  - **CSRF rule:** a cookie-authenticated request that isn't GET/HEAD/OPTIONS must carry a same-origin `Origin` or `Referer`, otherwise it gets a 403.
  - Unauthenticated `/developer/*` page requests redirect to `/login`.
- Controllers return generic error messages through `utils/http.js` `sendServerError`. Never send `error.message` to clients.

### Security invariants (covered by tests)

- Client secrets and invitation tokens are stored only as SHA-256 hashes, and the plain value is shown once. Serializers must never include `clientSecret`, `secretHash`, `tokenHash` or `password`.
- An application can have up to 10 extra credential sets (`ApplicationCredential`, `/api/applications/:id/credentials`). `/oauth/token` accepts them, but the token's subject is still the application's original `clientId`, so gateways, subscriptions and usage stay keyed by the application.
- Redirect URIs must be https (http only for localhost) with no fragment (`utils/validation.js` `parseRedirectUris`). `Application.redirectUris` is stored as JSON but its getter returns an array, and it still reads the legacy newline-separated format.

### Frontend constraints

- Helmet's default CSP blocks inline scripts and inline `on*=` handlers. `test/security.test.js` fails if any view or partial has them. All page JS lives in `public/js/*.js`, loaded with `<script src>`.
- Every page loads `public/js/ui.js` first. It exposes `window.UI` (`sendJson`, `bindForm`, `toast`, `flash`, `confirm`, `setLoading`) and handles declarative attributes:
  - `data-action` with `data-method`, `data-body`, `data-confirm-*`, `data-success`, `data-redirect` and `data-no-reload`: buttons that call the API.
  - `data-copy` / `data-copy-target`: copy-to-clipboard.
  - `data-toggle-password`: show/hide a password field.
  - `data-filter` + `data-search`: client-side search filtering.

  Prefer these over writing new fetch code.
- Shared template pieces live in `views/partials/` (`head`, `app-nav`, `icon` (inline SVG by name), table partials). Include them with the `.html` extension, e.g. `include('partials/icon.html', { name: 'plus' })`. Helpers such as `initials`, `formatDate`, `formatBilling`, `formatRateLimit` and `subscriptionStatus` are registered on `app.locals` from `utils/viewHelpers.js`.
- Guided tours: `public/js/tour.js` (loaded on every page by `views/partials/head.html`, started by the header's `data-tour-start` button) holds one tour per page, matched by path, with steps pointing at CSS selectors; steps whose element is missing are skipped. Update a page's tour when you restructure the page.
- User documentation lives in `README.md` and `docs/` (role guides in `docs/users/`, tutorials, guides, API reference and examples). The console serves `docs/` and `gateway/README.md` at `/developer/docs` (**Docs** in the menu) through `services/docs.js` (`marked`, raw HTML escaped, only pages listed in `SECTIONS`; `test/docs.test.js` checks every file is listed and every link resolves). Update the docs when a feature or setting they describe changes.
- One design system lives in `public/css/style.css` (CSS variables at the top). Mobile breakpoints are 760px and 960px; below 760px, tables become stacked rows.

## Gateway (`gateway/`)

The gateway is a separate Node project with its own `package.json`, Dockerfile, `deploy/` folder (compose cluster with Redis, systemd unit, Ubuntu `install.sh`), admin UI (`gateway/ui/`) and README. It has no database. Run `cd gateway && npm test`; the root `npm test` runs `gateway/test` too.

- **Configuration flow:** management builds a config in `services/gatewayConfig.js`.
  - It contains published products, APIs (operations, upstream, `basePath`, policy, `connectionId`), approved subscriptions, handlers (ports and port policies), connections (secrets decrypted), observability, admin and `management.linkUrl`.
  - Push nodes get it from `services/gatewayPush.js` (`PUT /v1/config`). Pull nodes fetch it from the console link (`services/linkServer.js`, mTLS on `GATEWAY_LINK_PORT`, default 3443, started by `server.js`).
  - The config hash drives the "changes not deployed" state.
  - Push is the default the setup checklist offers (the console needs no route from the node). `services/gatewayMonitor.js` (started by `server.js`, `GATEWAY_MONITOR_MS`, default 30000) checks every push node's `/v1/status`, records `lastSeenAt`/`lastError` (shown as Unreachable), and resends the deployed config (`pushToNode`) to a node reporting an older version, but only while the built hash still equals `lastPushedHash`. Adding a push node checks it at once (`check` in the response).
  - Change the config shape in both places: `services/gatewayConfig.js` and `gateway/src/runtime.js` (gateway validation).
  - `redactConfig` must hide every secret in the preview.
- **Nodes and handlers:** `services/gatewayNodes.js` builds every node's addresses and start command.
  - A node has a `host` and a `portOffset`: nodes on one Docker host publish container ports at port + offset. Adding a pull node registers it ahead of time, and the node takes over that entry when it connects with the same `GATEWAY_NODE_NAME`.
  - A handler with `nodeId` runs on that node only. The config lists its `nodes` by name, and each gateway drops the handlers meant for other nodes before applying the config (`forThisNode` in `gateway/src/gateway.js`).
  - Pull nodes take console tasks (flow tests, the live request log) over the link (`services/linkTasks.js`, targeted by node name and queued while the node is busy).
- **Auto-push:**
  - The `autoPushAfterChanges` middleware on `/api/org` debounces a push per organization (`services/autoPush.js`).
  - Tests set `GATEWAY_AUTO_PUSH=false` in `test/helpers.js`.
  - Owner-side changes outside `/api/org`, such as an app deleted or access removed, call `scheduleAutoPush` directly.
- **mTLS and certificates:** `utils/pki.js` keeps a self-signed management CA plus keys in `SystemKeys`. Private keys are sealed by `utils/secretBox.js` (`PKI_MASTER_KEY`, falling back to a key derived from `JWT_SECRET`).
  - Gateway certs are `CN=gateway:<id>`, and every issued cert is recorded in `GatewayCredential` (for revocation, renewal and expiry warnings).
  - Management's client cert and the link server cert are `CN=oauth-server-management`.
  - Revoked fingerprints are refused by both the link and pushes.
- **Consumer auth:** `POST /oauth/token` (client credentials) issues RS256 JWTs (`utils/gatewayTokens.js`). The gateway verifies them with the key from the config and checks the approved subscription.
- **Admin UI:** the node serves it on port 9445 with its own certificate. Two sign-ins, both for org admins of the gateway's organization only: a one-time ticket from `POST /api/org/gateways/:id/nodes/:nodeId/admin-ticket` (RS256 with the token key, audience `oauth-server-gateway-admin`, 60 s, bound to the gateway, checked by `gateway/src/adminTicket.js` with the config's token keys, so it works without the link), or email and password verified by the console (`POST /v1/admin-login` on the link, pull nodes only).
- **Usage and observability:** the gateway's `observability/` modules hold metrics, the request log, off-load and usage. Usage reaches `UsageRecord` (daily) through the link, or through `services/usageCollector.js` for push nodes. `services/usage.js` `usageSeries` feeds `views/partials/usage-card.html`. Its charts come from `gateway/ui/charts.js`, served to the console as `/js/charts.js`.
- **Policies:**
  - Policy code runs in `gateway/src/policy.js` inside worker threads (`policyRunner.js` / `policyWorker.js`). It exports a function or `{ onRequest, onResponse }`.
  - The `vm` timeout stops sync loops; the runner spawns a replacement and kills the worker for anything else.
  - Don't reintroduce `microtaskMode: 'afterEvaluate'`: a timeout inside it corrupts Node's async hooks.
  - Management only syntax-checks policies, by importing `gateway/src/policy.js`. Test runs (`POST /api/org/policies/test`) execute on a gateway node, never in the console.
- **Checking steps** (`validateRequest`, `validateBody`, `security` in `gateway/src/flow.js`; run by `gateway/src/checks.js`):
  - Validate steps check the matched operation's `contract` (header/query parameters and requestBody, `$ref`s resolved by `utils/openapiContract.js`, validated by `gateway/src/schema.js`). `services/gatewayConfig.js` adds `contract` only when the API's flow or any port policy uses a Validate step (`usesContract`), so other configs and their hashes stay unchanged. The flow test sends the chosen API's operations the same way.
  - Security (`gateway/src/threats.js`): injection patterns, limits, IP lists and brute-force lockout. Lockout counts live in memory per node (`createFailureTracker`), and the pipeline counts the final status through `state.watches`. Findings carry the rule and location, never the value.
- **Tests:** in-process gateways must pass `adminPort: 0` (and `managementPort`/`healthPort: 0`) to avoid port clashes.

## Repository conventions (from `.github/agents/DevelopOauth.agent.md`)

- Work within the existing Express / Sequelize / JWT / server-rendered architecture. Don't introduce a new framework or authentication architecture unless asked.
- Never weaken authentication or authorization to make something pass, and never expose raw database or auth errors to users.
- Preserve existing API and UI contracts unless the task requires changing them. Avoid unrelated refactors. Don't commit.
