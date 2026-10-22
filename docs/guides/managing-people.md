# Managing site admins, org admins and members

How to manage people through the console's REST API: who can do what, the endpoints for each role, and recipes for common tasks. The same actions are available in the console under **Admin** and **Members**.

## The three roles

| Role | Where it is set | Can |
|---|---|---|
| **Site admin** (platform admin) | `role: "admin"` on the user | Everything under `/api/admin`: every user, organization and application. Can open any organization and act as its admin. |
| **Org admin** | `orgRole: "admin"` on a membership | Manage one organization: catalogs, APIs, products, gateways, the dictionary, access requests and its people (`/api/org`). |
| **Member** | `orgRole: "member"` on a membership | Browse the organization's published products, create applications and request access. |

A user can be a member of several organizations, with a different role in each. The site admin role is separate: a site admin may also be an org admin or a member of some organizations, or of none.

Rules the API enforces:

- An organization always keeps at least one admin. Removing or demoting its last admin answers `409`, and so does leaving it as its last admin.
- Nobody can change or remove themselves through the management endpoints. Leave an organization with `DELETE /api/me/organizations/:id` instead. Site admins can't take away their own site admin role or delete their own account.
- Records of another organization answer `404`.

## Authenticating

Every call below needs a session token. Sign in, and send the token as a bearer token:

```bash
BASE=http://localhost:3000
TOKEN=$(curl -s -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin12345"}' \
  $BASE/auth/login | jq -r .token)

auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
curl -s "${auth[@]}" $BASE/api/me/organizations
```

Tokens last 24 hours. `/api/org` endpoints act on the organization the signed-in user has selected. Select another one with `PUT /api/me/organization`.

## Site admins: `/api/admin`

Only site admins can call these. Everyone else gets `403`.

### Users

| Method | Path | Body | |
|---|---|---|---|
| GET | `/api/admin/users` | | Every user |
| GET | `/api/admin/users/:id` | | One user |
| POST | `/api/admin/users` | `name`, `email`, `password`, and `organizationId` or `organizationName`; optional `role`, `orgRole`, `isVerified` | Creates a user in an existing organization (as `member` unless `orgRole` says otherwise) or in a new one (as its admin) |
| PUT | `/api/admin/users/:id` | any of `name`, `email`, `role`, `isVerified` | Updates a user. `role: "admin"` makes them a site admin; `role: "user"` takes it away. |
| PUT | `/api/admin/users/:id/password` | `password` | Sets a new password (at least 8 characters) |
| DELETE | `/api/admin/users/:id` | | Deletes the user, their applications, tokens and memberships. Refused (`400`) while they are the only admin of an organization that has other members. |
| GET | `/api/admin/users/:id/applications` | | Their applications |
| POST | `/api/admin/token` | `userId` | Issues a 1-hour session token for that user, for testing. It acts as that user, so treat it like their password. |

User responses never include the password.

### Organizations and their members

| Method | Path | Body | |
|---|---|---|---|
| GET | `/api/admin/organizations` | | Every organization, with counts of members, catalogs, APIs, products, gateways and applications |
| POST | `/api/admin/organizations` | `name`, optional `adminEmail` | Creates an organization; the account with `adminEmail` becomes its admin |
| GET | `/api/admin/organizations/:id` | | The organization with its members, catalogs and gateways |
| PUT | `/api/admin/organizations/:id` | `name` | Renames it |
| DELETE | `/api/admin/organizations/:id` | | Deletes it with its memberships, invitations, policies, connections and dictionary. Refused (`409`, with `counts`) while it still has catalogs, APIs, products, gateways or applications. |
| POST | `/api/admin/organizations/:id/members` | `email`, optional `orgRole` (`member`) | Adds an existing account. Use `POST /api/admin/users` first for someone new. |
| PUT | `/api/admin/organizations/:id/members/:userId` | `orgRole` | Changes their role |
| DELETE | `/api/admin/organizations/:id/members/:userId` | | Removes them from the organization; their account and applications stay |

A member here looks like `{ id, name, email, role, orgRole, joinedAt }`, where `id` is the user's id, `role` the site role and `orgRole` the role in this organization.

## Org admins: `/api/org`

These act on the selected organization. Members may read the organization and its member list; everything else needs an org admin of it. A site admin who selects an organization acts as its admin.

### The organization

| Method | Path | Body | |
|---|---|---|---|
| GET | `/api/org` | | `{ organization, role }`, with your role in it |
| PUT | `/api/org` | `name` | Renames it |

### Members

| Method | Path | Body | |
|---|---|---|---|
| GET | `/api/org/members` | | `{ members: [{ id, name, email, orgRole, isVerified, createdAt }] }`; `id` is the user's id |
| POST | `/api/org/members` | `email`, optional `orgRole` (`member`); `name` and `password` when no account uses the email | Adds someone directly. An existing account joins as it is (`existingAccount: true`). For a new one you choose a name and a temporary password to pass on. |
| PUT | `/api/org/members/:userId` | `orgRole`: `admin` or `member` | Makes a member an org admin, or an admin a member. Not your own role. |
| DELETE | `/api/org/members/:userId` | | Removes them from this organization. Their account, other organizations and applications stay. Not yourself. |

### Invitations

Inviting is the usual way to add people: they choose their own password, or confirm with the one they have.

| Method | Path | Body | |
|---|---|---|---|
| GET | `/api/org/invitations` | | Pending invitations: `{ invitations: [{ id, email, orgRole, expiresAt, expired, createdAt }], mailConfigured }` |
| POST | `/api/org/invitations` | `email`, optional `orgRole` (`member`) | Invites someone. `409` if they are already a member or already have a pending invitation. |
| POST | `/api/org/invitations/:id/resend` | | Issues a new link (the old one stops working) and sends it again |
| DELETE | `/api/org/invitations/:id` | | Revokes it |

Creating or resending answers with the invitation and how it was delivered:

```json
{
  "invitation": { "id": "…", "email": "sam@example.com", "orgRole": "member", "expiresAt": "…", "expired": false },
  "inviteUrl": "https://console.example.com/invite/…",
  "emailSent": true,
  "emailFailed": false,
  "mailConfigured": true
}
```

Without SMTP configured, `emailSent` is `false`: pass `inviteUrl` on yourself. The link is returned only here, since the console keeps just a hash of it.

## Members: `/api/me` and accepting invitations

Any signed-in user can manage their own memberships.

| Method | Path | Body | |
|---|---|---|---|
| GET | `/api/me/organizations` | | `{ current, actingAsPlatformAdmin, organizations: [{ id, name, role }], canCreate }` |
| PUT | `/api/me/organization` | `organizationId` | Selects the organization to work in. Site admins may select any. |
| POST | `/api/me/organizations` | `name` | Creates an organization with you as its admin. Allowed for org admins, site admins and people in no organization yet (`canCreate`). |
| DELETE | `/api/me/organizations/:id` | | Leaves an organization, unless you are its only admin |
| POST | `/auth/accept-invite` | `token`, plus `name` and `password` for a new account, or the account's `password` for an existing one | Accepts an invitation; `token` is the last part of the invitation link |

## Recipes

**Make someone a site admin, or take it away**

```bash
curl -s "${auth[@]}" -X PUT -d '{"role":"admin"}' $BASE/api/admin/users/$USER_ID
curl -s "${auth[@]}" -X PUT -d '{"role":"user"}'  $BASE/api/admin/users/$USER_ID
```

**List the site admins**

```bash
curl -s "${auth[@]}" $BASE/api/admin/users | jq '.users[] | select(.role == "admin") | {id, name, email}'
```

**Make a member an org admin** (as an admin of the organization)

```bash
curl -s "${auth[@]}" -X PUT -d '{"orgRole":"admin"}' $BASE/api/org/members/$USER_ID
```

**List an organization's admins**

```bash
curl -s "${auth[@]}" $BASE/api/org/members | jq '.members[] | select(.orgRole == "admin")'
```

**Hand an organization over to someone else**

1. Make the new person an admin: `PUT /api/org/members/:userId` with `{"orgRole":"admin"}`.
2. They, or another admin, demote you, or you leave: `DELETE /api/me/organizations/:id`.

**Invite a team from a list**

```bash
for email in ana@example.com ben@example.com; do
  curl -s "${auth[@]}" -d "{\"email\":\"$email\",\"orgRole\":\"member\"}" $BASE/api/org/invitations | jq -r '.inviteUrl'
done
```

**Off-board a person**

- From one organization: `DELETE /api/org/members/:userId`. Their applications stay with them, and their access to this organization's products stays until you revoke it with `PUT /api/org/subscriptions/:id`.
- From the whole installation (site admin): make sure each organization they run has another admin, then `DELETE /api/admin/users/:id`, which also deletes their applications.

**Set up a new customer organization** (site admin)

```bash
curl -s "${auth[@]}" -d '{"name":"Acme","email":"owner@acme.test","password":"a-temporary-password","organizationName":"Acme"}' \
  $BASE/api/admin/users
```

This creates the account and the organization, with the account as its admin. Ask them to change the password, or invite them instead: create the organization with `POST /api/admin/organizations`, add yourself, select it and send an invitation.

## Errors

| Status | When |
|---|---|
| `400` | Invalid input, changing or removing yourself, or deleting a user who is an organization's only admin |
| `401` | Missing or expired session token |
| `403` | Not a site admin (`/api/admin`), or not an admin of the selected organization (`/api/org`) |
| `404` | No such user, organization, member or invitation, or it belongs to another organization |
| `409` | It would leave an organization without an admin, the person is already a member, an invitation is pending, an email is taken, or an organization still owns resources |

Errors are JSON: `{ "error": "…" }`.
