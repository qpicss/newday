# Guide for developers and members

You build applications that call the APIs an organization publishes. This guide covers every page and option you have as a member. Org admins have all of these too.

## Your first hour

1. Accept your invitation, or register.
2. Open **Catalogs** and find a product you need.
3. Create an **application** and copy its client secret.
4. **Request access** to the product for your application, and wait for an admin to approve it.
5. Get a token and call the API.

[Tutorial 5: Call an API](../tutorials/05-call-an-api.md) walks through it with commands.

## Dashboard

- **Summary**: how many applications you have, how many products they're approved for, and your role in the selected organization.
- **Recent applications**, with a link to all of them.
- **Getting started**: the steps from a new account to your first API call, ticked off as you go.
- A notice when you're not in any organization, with a link to create one.

## Catalogs and products

**Catalogs** lists the catalogs of the selected organization. Open one to see its **published products**. Draft products aren't shown to members.

A product page shows:

- its **description** and the **APIs** it includes, with each API's endpoints and base URL;
- its **plan**: free, a flat price per month or year, or a price per request, and its rate limit;
- **Request access**: choose one of your applications and send the request;
- **Call it**: ready-made commands to get a token and call the first endpoint through the organization's gateway.

## Applications

An application is the identity your code uses to call APIs. **Applications** lists yours; **New application** creates one.

### Create

| Field | |
|---|---|
| Application name | Shown to admins when you request access |
| Description | Optional |
| Redirect URIs | One per line, up to 10. Must be https, except for `localhost`, and can't contain a `#` fragment. Kept for clients that need them; the client credentials grant doesn't use them. |
| Public key | Optional, under **Advanced**. A PEM public key kept with the application. |

After creating it, the page shows the **client ID** and **client secret**. Copy the secret straight away: the console stores only a hash of it and can never show it again.

### Manage

The application page has:

- **Settings**: change the name, description, redirect URIs and public key. A warning appears if stored redirect URIs no longer pass the rules.
- **API access**: every product the application has asked for, with its status. Withdraw a request or give up access here.
- **Credentials**: the original client ID and up to 10 extra client ID and secret pairs. Add one to rotate a secret without downtime, then remove the old one. Each new secret is shown once.
- **Usage**: the calls the application made through gateways.
- **Danger zone**: delete the application. Its credentials and access stop working at once.

### Access statuses

| Status | Meaning |
|---|---|
| Pending | Waiting for an admin of the organization |
| Approved | The application can call the product's APIs |
| Rejected | Refused; you can ask again |
| Revoked | Access was approved, then taken away |

## Getting tokens and calling APIs

```bash
curl -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://console.example.com/oauth/token
```

The answer has an `access_token` valid for 10 minutes (`expires_in: 600`). Send it to the gateway:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" https://api.example.com/orders/v1/orders
```

- Cache the token and ask for a new one shortly before it expires, rather than for every call.
- The console limits token requests per client address (30 per 15 minutes by default).
- Tokens from any of the application's credential sets work the same way.

What the gateway answers when something is wrong:

| Status | Fix |
|---|---|
| `401` | Get a new token; check you're using this console's token endpoint |
| `403` | Your application has no approved access to a product with this API |
| `404`, `405` | Check the base path, the path and the method against the product page |
| `413` | The body is too large |
| `415`, `422` | The request doesn't match the API's OpenAPI document; the answer lists each problem |
| `429` | Rate limit reached; wait for the seconds in `Retry-After` |
| `502`, `503`, `504` | The API's backend is down or slow; try again later |

## Organizations

- The switcher at the top left shows the organization you work in. Switch to another of yours there.
- **Organization** in the menu lists your organizations and the members of the selected one.
- If you belong to no organization, you can create one and become its admin. Otherwise ask an admin to invite you.
- **Leave** an organization from the same page. Your applications created there stay yours but can only use that organization's products.

## Your profile

**My profile** shows your account details and lets you sign out. Ask a site admin to change your name, email or password.

## Using the API instead of the pages

Everything above can be scripted. Sign in with `POST /auth/login`, then call `/api/applications` and `/api/catalog` with the token. See the [REST API reference](../guides/api-reference.md) and [API examples](../guides/api-examples.md).
