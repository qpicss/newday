# Security

What the console and gateways protect, and how. Report vulnerabilities privately to the maintainers rather than in a public issue.

## Accounts and sessions

- Passwords are hashed with bcrypt and must be at least 8 characters.
- A session is a JWT signed with `JWT_SECRET`, valid for 24 hours. Browsers keep it in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` when `NODE_ENV=production`. API clients send it as a bearer token.
- Sign-in, registration and `/oauth/token` are rate limited per client address (see [Configuration](configuration.md#rate-limits-on-sign-in-and-tokens)).

## Cross-site requests

- A request authenticated by the cookie that changes something (anything but GET, HEAD and OPTIONS) must carry a same-origin `Origin` or `Referer` header. Otherwise it is refused with `403`.
- Helmet sets a strict Content Security Policy: no inline scripts and no inline event handlers. All page code is in `public/js`. A test fails if a view adds inline script.

## Tenancy

- Every organization's data is queried with the organization selected by the signed-in user.
- Records of another organization answer `404`, so their existence isn't revealed.
- Only admins of an organization manage it. Platform admins can act in any organization, and the console shows a banner when they do.
- An organization always keeps at least one admin.

## Secrets

| Secret | How it is stored |
|---|---|
| Client secrets (and extra credential sets) | SHA-256 hash only; shown once when created |
| Invitation tokens | SHA-256 hash only; the link is shown or emailed once |
| Private keys (management CA, console certificates, uploaded handler keys) | Sealed with `PKI_MASTER_KEY` (AES-256-GCM) |
| Connection credentials for upstreams | Sealed; sent to gateways only inside the mTLS-protected configuration |

Responses never include passwords, client secrets, hashes or tokens. The configuration preview hides every secret. Server errors answer with a generic message; details go to the console's log only.

## OAuth tokens for applications

- `POST /oauth/token` supports the client credentials grant only.
- Tokens are RS256 JWTs, valid for 10 minutes.
- Gateways verify them with the console's public key and check that the application has approved access to a product containing the API. They never call the console per request.
- Redirect URIs must be https (http only for `localhost`) and can't contain a fragment.

## Console and gateways

- Console and gateways trust each other through certificates from the console's own CA: `CN=gateway:<id>` for gateways, `CN=oauth-server-management` for the console.
- Pushes and the pull link use mutual TLS. Revoked certificates are refused both ways.
- The gateway admin UI accepts only admins of the gateway's organization. The node checks the password with the console over the link and never stores it.

## Gateway policies

- Policy scripts run in worker threads, each in its own `vm` context, with no `require`, `process`, timers, network or `eval`, and a time and memory limit.
- Test runs execute on a gateway node, never inside the console.
- Request logs hold no headers or bodies. Security findings name the rule and where it matched, never the value.

## Your responsibilities

- Serve the console over HTTPS, and set `NODE_ENV=production`.
- Keep `JWT_SECRET`, `PKI_MASTER_KEY`, the database and gateway credentials files private.
- Use HTTPS connection handlers for public gateway ports.
- Renew and revoke gateway certificates when people with access to them leave.
