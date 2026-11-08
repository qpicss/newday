# Getting an access token

To call an API through a gateway, an application sends an access token with each request. This page explains where tokens come from, how to ask for one and what to check when it doesn't work. It assumes you already have a client ID and secret for an application with approved access. [Tutorial 5](../tutorials/05-call-an-api.md) shows how to get those.

## Where tokens come from

| | Address | What it does |
|---|---|---|
| **Management console** | Its own address, for example `https://console.example.com` (`http://localhost:3000` when you run it locally) | Issues tokens at `/oauth/token` |
| **Gateway** | The public URL of the gateway, for example `https://api.example.com` | Serves your APIs and checks the tokens |

Ask the **console** for the token, then call the **gateway** with it. The gateway doesn't issue tokens. Sending a token request to the gateway's address returns `404 not_found`, because no API matches `/oauth/token`, and **Live requests** shows it as *Route: No API operation matches /oauth/token*.

The gateway checks tokens with the console's public key, which it receives with each configuration push. It never calls the console while serving requests, so the gateway server doesn't need to reach the console. The application asking for tokens does.

## Ask for a token

Send the client ID and secret with the `client_credentials` grant:

```bash
export CLIENT_ID=<client ID>
export CLIENT_SECRET=<client secret>

curl -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  https://console.example.com/oauth/token
```

In PowerShell, use `curl.exe`, not `curl`:

```powershell
$ClientId = '<client ID>'
$ClientSecret = '<client secret>'
curl.exe -u "${ClientId}:${ClientSecret}" -d grant_type=client_credentials https://console.example.com/oauth/token
```

You can send the credentials as `client_id` and `client_secret` form fields instead of HTTP Basic. The answer:

```json
{ "access_token": "eyJhbGciOiJSUzI1NiIs...", "token_type": "Bearer", "expires_in": 600 }
```

## Call the API with it

Send the token in the `Authorization` header to the gateway's address, followed by the API's base path and the operation's path:

```bash
ACCESS_TOKEN=$(curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials \
  https://console.example.com/oauth/token | jq -r .access_token)

curl -H "Authorization: Bearer $ACCESS_TOKEN" https://api.example.com/shop/orders
```

An API whose access is **Public**, or an operation marked **No token** on the API's page, needs no token. The gateway ignores one if you send it.

## What to take into account

- **Tokens last 10 minutes** (`expires_in` is in seconds). Keep using the same token until it is about to expire, then ask for a new one. Don't ask for a new token for every call.
- **Failed token requests are limited.** After 30 failed requests from one address within 15 minutes (`TOKEN_RATE_LIMIT_MAX`), the console answers `429` until the window ends. Successful requests don't count.
- **The console has to be reachable by the application.** If the console runs on a private machine, outside callers can't get tokens. Publish it on its own address, for example with a reverse proxy, and set `APP_URL` to that address (see [Configuration](configuration.md)).
- **Changing `APP_URL` changes the tokens.** The console writes `APP_URL` into each token as its issuer, and gateways only accept tokens from the issuer in their configuration. After changing it, restart the console, push every gateway, and ask for new tokens.
- **Approved access is needed.** A valid token is refused with `403 forbidden` until the application has approved access to a published product that includes the API, and the gateway has received the configuration with it. Auto-push sends it on its own; otherwise push the gateway.
- **Keep clocks right.** The gateway checks the token's expiry time against its own clock. Keep the console and gateway servers synchronised (NTP), or tokens can look expired early.
- **Keep the secret out of browsers and apps on users' devices.** The client credentials grant is for servers. A website calling an API from the browser should go through a public API, or through a server of its own that holds the secret.
- **Use HTTPS** for the console's token endpoint everywhere except on your own machine.

## When it fails

| Answer | From | Meaning |
|---|---|---|
| `404 not_found` | Gateway | The token request went to the gateway. Send it to the console's address. Also returned for a call whose path matches no API. |
| `400 invalid_request` | Console | `grant_type` is missing. |
| `400 unsupported_grant_type` | Console | Only `client_credentials` is supported. |
| `401 invalid_client` | Console | The client ID or secret is wrong. |
| `429` | Console | Too many failed token requests from your address. Wait up to 15 minutes. |
| `401 invalid_request` | Gateway | The call has no `Authorization: Bearer` header. |
| `401 invalid_token` | Gateway | The token expired, was issued under a different `APP_URL`, or was not issued by this console. Ask for a new one, and push the gateway if you changed `APP_URL`. |
| `403 forbidden` | Gateway | The application has no approved access to a product with this API, or the gateway hasn't received it yet. |
| `429 rate_limited` | Gateway | The product's rate limit is reached. Wait for the number of seconds in `Retry-After`. |

The gateway's **Live requests** page shows each call's steps. The **Access** step tells you whether the token was accepted, or why it was refused.
