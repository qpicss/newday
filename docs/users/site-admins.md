# Guide for site admins

You run this installation for everyone on it. This guide covers the **Admin** area, working inside organizations, and the settings only an operator can change.

A site admin is an account with the platform role **Admin**. The first one comes from the seeded `admin@example.com` on a development database, or from promoting an account in the database. After that, site admins promote others from the console.

## The Admin area

**Admin** in the menu opens the admin dashboard:

- **Totals**: users, site admins, organizations, applications, verified accounts and accounts awaiting verification.
- **Users**: everyone on the platform, with their role, organizations, applications, status and when they joined. Filter by organization or search; **Manage** opens a user.
- Links to **Organizations**, **All applications**, the user **Directory** and **Create user**.

### Users

**Create user** sets up an account:

| Field | |
|---|---|
| Full name, email | |
| Temporary password | At least 8 characters. Share it securely. |
| Organization | An existing one, or **Create a new organization** with its name |
| Organization role | Member or admin. In a new organization the user is its admin. |
| Platform role | **User** (manages their own applications) or **Admin** (also manages all users) |

A user's page has:

| Section | Options |
|---|---|
| Profile | Full name, email, platform role and verified; save |
| Account | Verification status and dates |
| Organizations | Each organization they belong to, with their role there |
| Applications | Their applications, each linking to its admin view |
| Set a new password | Replaces their password |
| Danger zone | Delete the account with its applications, tokens and memberships |

The console refuses to delete your own account, to take away your own site admin role, and to delete someone who is the only admin of an organization with other members. Make someone else an admin there first.

The **Directory** lists every profile as cards, with search.

### Organizations

**Organizations** lists every organization with its counts of members, catalogs, products, APIs and gateways. **New organization** takes a name and, optionally, the email of an existing account to be its first admin.

An organization's page shows its catalogs (with their products, APIs and gateways), its gateways, and:

| Section | Options |
|---|---|
| Members | Change a member's role, or remove them; add an existing account by email and role |
| Settings | Rename |
| Danger zone | Delete. Refused while it still has catalogs, APIs, products, gateways or applications; otherwise its memberships, invitations, policies, connections and dictionary are deleted with it. |

The last admin of an organization can't be demoted or removed.

### All applications

Every OAuth client on the server, with its owner. Open one to see and change it as its owner would: settings, credentials (add or remove credential sets), access, and delete.

## Working inside an organization

Pick any organization in the switcher, even one you're not a member of. You then act as its admin: everything in the [guide for organization admins](org-admins.md) applies. A banner says **Managing … as platform admin** and links back to the organization's overview.

Use this to help a team, check a configuration, or approve access while their admins are away. Changes are made as you, and land in that organization.

## Operating the installation

Settings that only the server's operator can change live in environment variables:

| Area | Read |
|---|---|
| Database, URL, email, keys, gateway link, auto-push, rate limits | [Configuration](../guides/configuration.md) |
| Production checklist, migrations, backups, certificates, upgrades | [Operations](../guides/operations.md) |
| How accounts, secrets, tenancy and traffic are protected | [Security](../guides/security.md) |
| Gateway nodes, Docker, systemd, clusters, error codes | [Gateway reference](../../gateway/README.md) |

Things to keep an eye on:

- **Certificates.** The dashboard warns 30 days before a gateway certificate in use expires.
- **Backups.** Back up the database together with `JWT_SECRET` and `PKI_MASTER_KEY`.
- **Unverified accounts.** The admin dashboard counts them; verify an account with the **Verified** switch on its page.
- **Organizations without a second admin.** Check member lists, and promote a second admin where there's only one.

## Automating

Everything in the Admin area is under `/api/admin`, for site admins only. See [Managing people](../guides/managing-people.md) for users, roles and organizations with recipes, and [Tutorial 8: Run the platform](../tutorials/08-run-the-platform.md) for a walkthrough.
