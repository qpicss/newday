# Tutorial 5: Call an API as a developer

In this tutorial you register an application, get access to the **Shop Starter** product, exchange the application's credentials for a token and call the API through the gateway.

**You need:** the gateway from [Tutorial 4](04-run-a-gateway.md), serving the **Shop** catalog.

**Time:** about 10 minutes.

You can do this as the organization admin. To see the developer's side, sign in as a member of the organization (see [Tutorial 7](07-work-as-a-team.md) to invite one) and let the admin approve.

## 1. Register an application

1. Click **Applications** in the header, then **New application**.
2. Enter a name, `Shop app`, and a redirect URI, `https://localhost/callback`. Redirect URIs must be https, except on `localhost`.
3. Create it.

The page shows the **client ID** and **client secret**. Copy the secret now: it is stored only as a hash and is never shown again. If you lose it, add a new credential set to the application.

## 2. Request access

1. Click **Catalogs**, open **Shop**, then **Shop Starter**.
2. Under **Request access**, choose **Shop app** and send the request.

The request is now **pending**.

## 3. Approve it

As an admin of the organization, open **Access requests** (linked from the dashboard), or the **Access requests** card of the product. Approve the request.

The approval is part of the gateway configuration. If auto-push is off, push the gateway again.

## 4. Get a token

The product page shows this command under **Call it**, with your console's address:

```bash
export CLIENT_ID=<your client ID>
export CLIENT_SECRET=<your client secret>

curl -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  http://localhost:3000/oauth/token
```

```json
{ "access_token": "eyJhbGciOiJSUzI1NiIs...", "token_type": "Bearer", "expires_in": 600 }
```

The token is valid for 10 minutes. Ask for a new one when it expires. The credentials can also be sent as `client_id` and `client_secret` form fields instead of HTTP Basic.

## 5. Call the API

```bash
export ACCESS_TOKEN=<the access_token>

curl -H "Authorization: Bearer $ACCESS_TOKEN" "http://localhost:8080/shop/orders?status=open"
```

The **Orders** API has no policy yet, so the gateway answers `200` with the body of your request, which is empty for a GET. A `200` confirms the whole path: token, approved access, route and rate limit. In [Tutorial 6](06-protect-an-api-with-a-flow.md) you add a flow that calls the real upstream.

## 6. See it in the console

- **Gateways → Local → Live requests** lists the call with its status, timings, application and trace ID. Headers and bodies are never stored.
- The usage charts on the gateway, product and application pages count it within a minute or two.

## When something fails

| Status | What it means |
|---|---|
| `401` | No token, an expired token, or a token from another console |
| `403` | The application has no approved access to a product with this API |
| `404` / `405` | The path or method isn't an operation of the OpenAPI document, or the base path is wrong |
| `429` | The product's rate limit was reached; wait for the time in `Retry-After` |

The full list is in the [gateway README](../../gateway/README.md#responses-from-the-gateway).

## Rotate a secret

On the application page, **Credentials** holds up to 10 extra client ID and secret pairs. To rotate without downtime:

1. Add a credential set and deploy its secret.
2. Remove the old one once nothing uses it.

Tokens from any of the application's credential sets act as the application, so its access and usage don't change.

## Next

[Protect the API with a flow](06-protect-an-api-with-a-flow.md).
