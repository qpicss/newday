# Development

How the console is built, how to test it and the conventions to follow when you change it. `CLAUDE.md` at the repository root has more detail for each area.

## Running locally

```bash
npm install
cp .env.example .env        # set JWT_SECRET
npm run dev:sqlite          # SQLite, seeded accounts, no MySQL needed
npm run dev                 # or against MySQL, restarting on changes
```

There is no build step and no linter. Check a file you changed with `node --check <file>`.

## Tests

```bash
npm test                                            # console and gateway tests
node --test test/auth.test.js                       # one file
node --test --test-name-pattern="invitation" test/  # tests whose name matches
cd gateway && npm test                              # gateway tests only
```

Tests use `node:test` and `supertest` against in-memory SQLite. Every console test file requires `./helpers` first: it sets up the test environment before the app is loaded. Tests that start gateways in-process pass port `0` for their management, admin and health ports.

Some security rules have their own tests: secrets that must never appear in responses, tenancy (another organization's records answer `404`), CSRF and the absence of inline scripts in views.

## Architecture

```
server.js          syncs the database, starts the gateway link, listens
app.js             the Express app (what tests load)
routes/            /auth, /oauth, /api/* (JSON) and /developer/* (pages)
middleware/        authentication, organization roles, rate limits
controllers/       request handlers; serialize* helpers shape what is returned
services/          gateway configuration, push, link server and tasks, auto-push, usage, dictionary
utils/             OpenAPI parsing and editing, the dictionary, certificates, validation, view helpers
models/            Sequelize models and their associations (models/index.js)
views/             EJS templates saved as .html, with shared partials
public/            page scripts (public/js), one stylesheet (public/css/style.css)
gateway/           the gateway runtime, a separate Node project
```

- **Express 5, Sequelize, EJS.** Pages are rendered on the server; page scripts add behavior. MySQL in production, SQLite for tests and local runs.
- **Models** are always loaded through `require('../models')`, where all associations are defined. Associations have no database foreign keys, so deletes cascade by hand inside a transaction.
- **Multi-tenancy.** `middleware/auth.js` resolves the selected organization on every request and sets `req.user.organizationId` and `req.user.orgRole`. Every tenant query filters on `organizationId`.
- **Gateway configuration** is built in `services/gatewayConfig.js` and validated again by the gateway in `gateway/src/runtime.js`. Change its shape in both places.
- **OpenAPI editing** happens in `utils/openapi.js` (parsing and validation), `utils/openapiDesign.js` (operations, bodies, responses), `utils/schemaDesign.js` (`components.schemas`) and `utils/dictionary*.js` (the dictionary and its import).

## Front end

- Helmet's Content Security Policy blocks inline scripts and `on*=` attributes. Put page code in `public/js/<page>.js` and load it with `<script src>`.
- Every page loads `public/js/ui.js` first. It provides `window.UI` (`sendJson`, `bindForm`, `toast`, `flash`, `confirm`, `setLoading`) and declarative attributes such as `data-action`, `data-copy` and `data-filter`. Prefer them to new fetch code.
- Shared template pieces are in `views/partials/`. Include them with the `.html` extension, for example `include('partials/icon.html', { name: 'plus' })`.
- The schema editor (`public/js/schema-editor.js` with `views/partials/schema-editor.html`) is shared by the Schemas tab, inline body schemas and object fields. It uses fixed element ids, so a page can hold one.
- **Guided tours** are defined in `public/js/tour.js`, loaded on every page from `views/partials/head.html`. A tour matches a page by its path, and each step points at an element with a CSS selector. Steps whose element isn't on the page are skipped. When you add or restructure a page, update its tour.
- **Documentation** in `docs/` is also served in the console at `/developer/docs` by `services/docs.js`, which renders the Markdown with `marked`, escapes raw HTML and turns links between files into console URLs. Only the pages listed in its `SECTIONS` are served; add new files there (a test fails if a file in `docs/` is missing from it).
- One stylesheet, with design tokens at the top. Breakpoints are 760px and 960px; below 760px tables become stacked rows.

## Changing the database schema

- New tables are created on startup.
- New columns on existing tables, and data conversions, go into `scripts/migrate-data.js`. Keep it safe to re-run, and make it dry-run unless given `--apply`.
- Back up MySQL before applying migrations to a real database.

## Conventions

- Keep to the existing Express, Sequelize, JWT and server-rendered architecture.
- Never weaken authentication or authorization to make something work.
- Controllers answer server errors with a generic message through `utils/http.js` `sendServerError`. Never send `error.message` to clients.
- Serializers never include `password`, `clientSecret`, `secretHash` or `tokenHash`.
- Records of another organization answer `404`, not `403`.
- Keep API and page contracts stable unless a change needs otherwise.
