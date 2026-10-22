# API examples

End-to-end examples of the console's REST API, for scripts and CI pipelines. Each step uses values from the previous ones. The full list of endpoints is in the [REST API reference](api-reference.md).

The examples use `curl` and `jq`. Set these first:

```bash
BASE=http://localhost:3000
```

## Sign in

```bash
TOKEN=$(curl -s -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","password":"your-password"}' \
  $BASE/auth/login | jq -r .token)

auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
```

The token is valid for 24 hours. Every `/api/org` call acts on your selected organization:

```bash
curl -s "${auth[@]}" $BASE/api/me/organizations | jq '{current, organizations}'
curl -s "${auth[@]}" -X PUT -d '{"organizationId":"<id>"}' $BASE/api/me/organization
```

## Provider: publish an API

**Create a catalog.**

```bash
CATALOG=$(curl -s "${auth[@]}" -d '{"name":"Shop","description":"Public shop APIs"}' \
  $BASE/api/org/catalogs | jq -r .catalog.id)
```

**Import an OpenAPI document.** The `content` is the document as text, JSON or YAML, up to 2 MB.

```bash
API=$(jq -n --rawfile content orders.yaml --arg catalogId "$CATALOG" '{content: $content, catalogId: $catalogId}' \
  | curl -s "${auth[@]}" -d @- $BASE/api/org/apis/import \
  | tee /dev/stderr | jq -r .api.id)
```

The answer holds the `api` and what was added to the `dictionary`:

```json
{
  "api": { "id": "…", "name": "Orders", "version": "1.0.0", "basePath": "/orders", "operations": [ … ] },
  "dictionary": { "fieldsAdded": 11, "objectsAdded": 4, "fieldsReused": 0, "objectsReused": 0, "notes": [] }
}
```

**Set where the gateway serves it.**

```bash
curl -s "${auth[@]}" -X PUT -d '{"basePath":"/shop"}' $BASE/api/org/apis/$API | jq .api.basePath
```

A base path already used by another API answers `409`.

**Replace the document later**, for example from CI. Send the `updatedAt` you read, so a change made in the meantime isn't overwritten (`409`):

```bash
UPDATED=$(curl -s "${auth[@]}" $BASE/api/org/apis/$API | jq -r .api.updatedAt)
jq -n --rawfile content orders.yaml --arg updatedAt "$UPDATED" '{content: $content, updatedAt: $updatedAt}' \
  | curl -s "${auth[@]}" -X PUT -d @- $BASE/api/org/apis/$API/spec | jq '.api.operationCount'
```

**Create a product, add the API, and publish it.**

```bash
PRODUCT=$(curl -s "${auth[@]}" -d "{\"name\":\"Shop Starter\",\"catalogId\":\"$CATALOG\"}" \
  $BASE/api/org/products | jq -r .product.id)

curl -s "${auth[@]}" -d "{\"apiId\":\"$API\"}" $BASE/api/org/products/$PRODUCT/apis > /dev/null

curl -s "${auth[@]}" -X PUT -d '{
  "status": "published",
  "rateLimitEnabled": true, "rateLimitRequests": 60, "rateLimitPeriod": "minute",
  "billingPlan": "free"
}' $BASE/api/org/products/$PRODUCT | jq '.product | {status, rateLimit, billing}'
```

| Field | Values |
|---|---|
| `status` | `draft`, `published` (needs at least one API) |
| `rateLimitPeriod` | `second`, `minute`, `hour`, `day` |
| `billingPlan` | `free`, `flat`, `usage` |
| `billingPrice`, `billingCurrency`, `billingInterval` | For paid plans: a price, one of `USD EUR GBP CAD AUD JPY CHF INR`, and `month` or `year` |

## Provider: run a gateway

```bash
GATEWAY=$(curl -s "${auth[@]}" -d '{"name":"Local","publicUrl":"http://localhost:8080"}' \
  $BASE/api/org/gateways | jq -r .gateway.id)

curl -s "${auth[@]}" -d '{"name":"public","port":8080,"protocol":"http"}' \
  $BASE/api/org/gateways/$GATEWAY/handlers | jq .handler
```

For HTTPS, send `"protocol":"https"`, and either nothing (the console issues a certificate) or `"tlsMode":"custom"` with `certificatePem` and `privateKeyPem`.

Download the credentials and start a node from the gateway page (see [Tutorial 4](../tutorials/04-run-a-gateway.md)). Then attach the catalog and push:

```bash
curl -s "${auth[@]}" -X PUT -d "{\"catalogId\":\"$CATALOG\",\"autoPush\":true}" $BASE/api/org/gateways/$GATEWAY | jq '.gateway | {catalog, autoPush}'
curl -s "${auth[@]}" -X POST $BASE/api/org/gateways/$GATEWAY/push | jq
curl -s "${auth[@]}" $BASE/api/org/gateways/$GATEWAY/status | jq
```

See what a push would send, with secrets hidden:

```bash
curl -s "${auth[@]}" $BASE/api/org/gateways/$GATEWAY/config | jq '.config.apis[0]'
```

## Developer: get access and call the API

**Create an application.** The secret is in this answer only.

```bash
curl -s "${auth[@]}" -d '{"name":"Shop app","redirectUris":["https://localhost/callback"]}' \
  $BASE/api/applications > app.json
APP=$(jq -r .application.id app.json)
CLIENT_ID=$(jq -r .application.clientId app.json)
CLIENT_SECRET=$(jq -r .application.clientSecret app.json)
```

Keep `app.json` somewhere safe, or delete it once the secret is stored.

**Find a product and request access.**

```bash
curl -s "${auth[@]}" $BASE/api/catalog | jq '.products[] | {id, name}'
curl -s "${auth[@]}" -d "{\"productId\":\"$PRODUCT\"}" $BASE/api/applications/$APP/subscriptions | jq .subscription.status
```

**Approve it** (an org admin of the product's organization):

```bash
SUB=$(curl -s "${auth[@]}" "$BASE/api/org/subscriptions?status=pending" | jq -r '.subscriptions[0].id')
curl -s "${auth[@]}" -X PUT -d '{"status":"approved"}' $BASE/api/org/subscriptions/$SUB | jq .subscription.status
```

Decisions: `approved` or `rejected` for a pending request, `revoked` for an approved one.

**Get a token and call the API.**

```bash
ACCESS_TOKEN=$(curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials \
  $BASE/oauth/token | jq -r .access_token)

curl -i -H "Authorization: Bearer $ACCESS_TOKEN" http://localhost:8080/shop/orders
```

**Rotate the secret.**

```bash
NEW=$(curl -s "${auth[@]}" -d '{"name":"2026 rotation"}' $BASE/api/applications/$APP/credentials)
echo "$NEW" | jq '.credential | {id, clientId, clientSecret}'
# deploy the new pair, then remove the old extra set:
curl -s "${auth[@]}" -X DELETE $BASE/api/applications/$APP/credentials/<old credential id>
```

## Org admin: people

```bash
# Invite someone; without SMTP, share inviteUrl yourself
curl -s "${auth[@]}" -d '{"email":"sam@example.com","orgRole":"member"}' $BASE/api/org/invitations | jq '{inviteUrl, emailSent}'

# Make a member an admin
curl -s "${auth[@]}" -X PUT -d '{"orgRole":"admin"}' $BASE/api/org/members/<user id> | jq .member
```

More in [Managing people](managing-people.md).

## Site admin: users and organizations

```bash
# A new organization with an existing account as its first admin
curl -s "${auth[@]}" -d '{"name":"Acme","adminEmail":"owner@acme.test"}' $BASE/api/admin/organizations | jq .organization

# Make someone a site admin
curl -s "${auth[@]}" -X PUT -d '{"role":"admin"}' $BASE/api/admin/users/<user id> | jq '.user | {email, role}'
```

## Data dictionary

```bash
# A field, then an object made of it
FIELD=$(curl -s "${auth[@]}" -d '{"name":"sku","schema":{"type":"string","pattern":"^[A-Z0-9-]{4,20}$"}}' \
  $BASE/api/org/dictionary/fields | jq -r .field.id)

curl -s "${auth[@]}" -d "{\"name\":\"OrderLine\",\"properties\":[{\"name\":\"sku\",\"fieldId\":\"$FIELD\",\"required\":true}]}" \
  $BASE/api/org/dictionary/objects | jq .object.preview

# Use the object as POST /orders' request body, as a list
curl -s "${auth[@]}" -X PUT -d "{\"source\":{\"type\":\"object\",\"id\":\"<object id>\"},\"isArray\":true,\"required\":true}" \
  "$BASE/api/org/apis/$API/operations/body?method=post&path=%2Forders" | jq .api.updatedAt
```

## Handling errors

Every error is JSON with an `error` message:

```json
{ "error": "Add at least one API before publishing this product" }
```

| Status | Meaning |
|---|---|
| `400` | The input is invalid; the message says what to fix |
| `401` | No session token, or it expired; sign in again |
| `403` | Your role doesn't allow it, or a browser request came from another site |
| `404` | It doesn't exist, or belongs to another organization |
| `409` | A conflict: a name or base path in use, a stale `updatedAt`, a schema that would be replaced (`conflicts` lists it; resend with `"replace": true`), or the last admin |
| `413` | The body is too large |
| `429` | Too many sign-in or token attempts; wait and retry |
