# REST API

Everything the console's pages do goes through this JSON API, so you can automate it: import APIs from CI, publish products, push gateways.

## Authentication

Sign in to get a session token, then send it as a bearer token:

```bash
TOKEN=$(curl -s -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"..."}' \
  http://localhost:3000/auth/login | jq -r .token)

curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/org/apis
```

- Session tokens last 24 hours.
- Requests act in the user's **selected organization**. Switch it with `PUT /api/me/organization`.
- The browser uses an HttpOnly `token` cookie instead. A cookie-authenticated request that changes something must come with a same-origin `Origin` or `Referer` header, or it is refused with `403`.
- Errors are JSON: `{ "error": "message" }`, with `400` for invalid input, `401` unauthenticated, `403` not allowed, `404` not found (including records of other organizations) and `409` conflicts.

This is different from **`POST /oauth/token`**, which gives *applications* tokens to call APIs through a gateway (see [Tutorial 5](../tutorials/05-call-an-api.md)).

For end-to-end scripts see [API examples](api-examples.md). For managing site admins, org admins and members, with request bodies and recipes, see [Managing people](managing-people.md).

## Accounts: `/auth`

| Method | Path | |
|---|---|---|
| POST | `/auth/register` | `{ name, email, password, organizationName }`. Creates the user and an organization with them as admin. Returns `{ token, user }`. |
| POST | `/auth/login` | `{ email, password }`. Returns `{ token, user }`. |
| POST | `/auth/logout` | Clears the session cookie |
| POST | `/auth/accept-invite` | Accepts an invitation, for a new or an existing account |

## Your organizations: `/api/me`

| Method | Path | |
|---|---|---|
| GET | `/api/me/organizations` | Organizations you belong to, with your role in each |
| POST | `/api/me/organizations` | Creates an organization with you as admin |
| PUT | `/api/me/organization` | `{ organizationId }`. Selects the organization you work in. |
| DELETE | `/api/me/organizations/:id` | Leaves an organization (not as its last admin) |

## Applications: `/api/applications`

Your own applications.

| Method | Path | |
|---|---|---|
| GET, POST | `/api/applications` | List, create. Creating returns the client secret once. |
| GET, PUT, DELETE | `/api/applications/:id` | Read, update, delete |
| GET, POST | `/api/applications/:id/credentials` | Extra credential sets (up to 10); creating returns its secret once |
| DELETE | `/api/applications/:id/credentials/:credentialId` | Removes a credential set |
| GET, POST | `/api/applications/:id/subscriptions` | Access to products; POST `{ productId }` requests access |
| DELETE | `/api/applications/:id/subscriptions/:subscriptionId` | Withdraws a request or gives up access |

## Browsing products: `/api/catalog`

| Method | Path | |
|---|---|---|
| GET | `/api/catalog` | Published products of the selected organization |
| GET | `/api/catalog/:id` | One published product |

## Organization management: `/api/org`

All of these act on the selected organization. Members can read the organization (`GET /api/org`) and its member list (`GET /api/org/members`); everything else needs an admin.

**Organization and people**

| Method | Path | |
|---|---|---|
| GET, PUT | `/api/org` | The organization |
| GET, POST | `/api/org/members` | Members; POST `{ email, orgRole, name?, password? }` adds an existing or new user directly |
| PUT, DELETE | `/api/org/members/:id` | Changes a role (`{ orgRole }`), removes a member |
| GET, POST | `/api/org/invitations` | Invitations; POST `{ email, orgRole }` |
| POST | `/api/org/invitations/:id/resend` | Resends an invitation |
| DELETE | `/api/org/invitations/:id` | Revokes it |

**Catalogs, APIs and products**

| Method | Path | |
|---|---|---|
| GET, POST | `/api/org/catalogs` | Catalogs |
| PUT, DELETE | `/api/org/catalogs/:id` | |
| POST | `/api/org/catalogs/:id/push` | Pushes the gateway attached to the catalog |
| GET, POST | `/api/org/apis` | APIs; POST creates one from endpoints you describe |
| POST | `/api/org/apis/import` | `{ content, catalogId }`: an OpenAPI 3.0 or 3.1 document as JSON or YAML text (up to 2 MB) |
| GET, PUT, DELETE | `/api/org/apis/:id` | An API; PUT also sets `basePath`, `policyId` and `connectionId` |
| GET, PUT | `/api/org/apis/:id/spec` | The OpenAPI document; PUT replaces it (409 if it changed since `updatedAt`) |
| POST | `/api/org/apis/:id/spec/validate` | Checks a document without saving |
| GET, POST | `/api/org/products` | Products |
| GET, PUT, DELETE | `/api/org/products/:id` | A product: details, publish state, rate limit, billing |
| POST | `/api/org/products/:id/apis` | `{ apiId }`: adds an API of the same catalog |
| DELETE | `/api/org/products/:id/apis/:apiId` | Removes it |
| GET | `/api/org/subscriptions` | Access requests to your products |
| PUT | `/api/org/subscriptions/:id` | `{ status }`: `approved`, `rejected` or `revoked` |

**API designer.** Operations are named with `?method=post&path=/orders` in the query.

| Method | Path | |
|---|---|---|
| POST, PUT, DELETE | `/api/org/apis/:id/operations` | Adds an endpoint, changes its summary and details, removes it |
| POST, PUT, DELETE | `/api/org/apis/:id/operations/parameters` | A parameter (`&in=query&name=limit` to change or remove one) |
| PUT, DELETE | `/api/org/apis/:id/operations/body` | The request body, described by a dictionary object, a document schema or a dictionary field |
| PUT, DELETE | `/api/org/apis/:id/operations/responses` | A response (`&status=200`) |
| PUT | `/api/org/apis/:id/operations/content-schema` | The schema of a body or response written in the endpoint (`&contentType=…`, plus `&status=…` for a response) |
| POST | `/api/org/apis/:id/operations/content-schema/move` | Moves it into `components.schemas`; `{ name? }` |
| POST | `/api/org/apis/:id/components/refresh` | Rewrites what came from the dictionary with its current version |
| POST | `/api/org/apis/:id/schemas` | Creates a schema in `components.schemas` |
| PUT, DELETE | `/api/org/apis/:id/schemas/:name` | Saves (and renames) or deletes one |
| POST | `/api/org/apis/:id/schemas/:name/dictionary` | Adds it and the schemas it uses to the dictionary |
| POST | `/api/org/apis/:id/dictionary` | Adds the whole document's schemas and parameters to the dictionary |

**Data dictionary**

| Method | Path | |
|---|---|---|
| GET | `/api/org/dictionary` | Fields and objects |
| POST | `/api/org/dictionary/fields` | `{ name, description, schema }` |
| GET, PUT, DELETE | `/api/org/dictionary/fields/:id` | |
| POST | `/api/org/dictionary/objects` | `{ name, description, properties: [{ name, fieldId or objectId, isArray, required }] }` |
| GET, PUT, DELETE | `/api/org/dictionary/objects/:id` | PUT replaces the whole property list |

**Gateways, policies and connections**

| Method | Path | |
|---|---|---|
| GET, POST | `/api/org/gateways` | Gateways; POST `{ name, publicUrl }` |
| GET, PUT, DELETE | `/api/org/gateways/:id` | A gateway, including its catalog and auto-push |
| POST | `/api/org/gateways/:id/nodes` | Registers a node |
| PUT, DELETE | `/api/org/gateways/:id/nodes/:nodeId` | |
| POST | `/api/org/gateways/:id/handlers` | Opens a port |
| PUT, DELETE | `/api/org/gateways/:id/handlers/:handlerId` | |
| PUT | `/api/org/gateways/:id/observability` | Metrics, tracing, request log, off-load and usage settings |
| GET | `/api/org/gateways/:id/config` | The configuration a push would send, with secrets hidden |
| POST | `/api/org/gateways/:id/push` | Pushes it to the nodes |
| GET | `/api/org/gateways/:id/status` | Asks every node for its status |
| GET | `/api/org/gateways/:id/requests` | The request log of the nodes |
| GET | `/api/org/gateways/:id/usage` | Usage per day |
| GET | `/api/org/gateways/:id/credentials` | Issued certificates |
| POST | `/api/org/gateways/:id/renew` | Issues a new certificate |
| POST | `/api/org/gateways/:id/credentials/:credentialId/revoke` | Revokes one |
| GET, POST | `/api/org/policies` | Policies (flows) |
| GET, PUT, DELETE | `/api/org/policies/:id` | |
| POST | `/api/org/policies/test` | Runs a flow on a gateway node against a sample request |
| GET, POST | `/api/org/connections` | Upstream connections |
| GET, PUT, DELETE | `/api/org/connections/:id` | |

## Platform admin: `/api/admin`

Platform admins only.

| Method | Path | |
|---|---|---|
| GET, POST | `/api/admin/users` | All users |
| GET, PUT, DELETE | `/api/admin/users/:id` | |
| PUT | `/api/admin/users/:id/password` | Sets a password |
| GET | `/api/admin/users/:id/applications` | A user's applications |
| GET | `/api/admin/applications` | All applications |
| GET, PUT, DELETE | `/api/admin/applications/:id` | |
| GET, POST, DELETE | `/api/admin/applications/:id/credentials[/:credentialId]` | |
| GET, POST | `/api/admin/organizations` | All organizations |
| GET, PUT, DELETE | `/api/admin/organizations/:id` | Deleting removes everything the organization owns |
| POST, PUT, DELETE | `/api/admin/organizations/:id/members[/:userId]` | |

## Client tokens: `/oauth/token`

```
POST /oauth/token
Authorization: Basic base64(client_id:client_secret)     (or client_id and client_secret form fields)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

Returns `{ "access_token": "...", "token_type": "Bearer", "expires_in": 600 }`. Only the client credentials grant is supported. The token is an RS256 JWT that gateways verify with the console's public key.
