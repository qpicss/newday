# Tutorial 8: Run the platform

In this tutorial you act as a site admin: you onboard a new customer organization, help its team from inside it, and handle the usual account requests.

**You need:** a site admin account. On a development database, `admin@example.com` / `admin12345` is one.

**Time:** about 15 minutes.

## 1. Look around the Admin area

Click **Admin** in the menu. The dashboard counts users, site admins, organizations and applications, and lists every user. Filter the list by organization, or search by name or email.

From here:

- **Organizations** lists every tenant with what it holds.
- **All applications** lists every OAuth client, with its owner.
- **Directory** shows every profile as a card.
- **Create user** adds an account.

## 2. Onboard an organization

Acme wants to publish APIs on your platform. Their lead, Priya, has no account yet.

1. Click **Create user**.
2. Enter Priya's name and email, and a temporary password.
3. Under **Organization**, choose **Create a new organization…** and name it `Acme`.
4. Keep **Platform role** on **User**. Priya runs her organization, not the platform.
5. Create the user.

Priya is now the admin of Acme. Send her the temporary password over a channel you trust, and point her to the [guide for organization admins](../users/org-admins.md).

Another way, if Priya already has an account: **Organizations → New organization**, with her email as the first admin.

## 3. Add a second admin

An organization with one admin gets stuck when that person is away.

1. Open **Organizations → Acme**.
2. Under **Members**, add another existing account by email, with the role **Admin**.

For someone without an account, create the user first, as in step 2, choosing **Acme** as the organization and **Admin** as the role.

## 4. Help from inside the organization

Priya asks why her product isn't visible to developers.

1. Open the organization switcher at the top left and pick **Acme**. You aren't a member, but as a site admin you can select any organization.
2. A banner says you're **managing Acme as platform admin**. Every page now works as it does for Acme's admins.
3. Open **Catalogs**, the catalog and the product. The badge says **Draft**: only published products are shown to developers. Tell Priya, or publish it for her.
4. Switch back to your own organization in the switcher when you're done.

Everything you change there is done as you, inside Acme.

## 5. Handle account requests

**Someone forgot their password.** Open them from the admin dashboard, and under **Set a new password** enter a temporary one.

**Someone changed their email or name.** Edit **Profile** on their page and save.

**Verify an account.** Turn on **Verified** on their page.

**Make someone a site admin.** Set **Role** to **Admin** on their page. Do this only for people who operate the platform: a site admin can see and change every organization.

**Someone leaves the company.**

1. On their page, check **Organizations**. Where they're the only admin, make another member an admin first.
2. Look at **Applications**: deleting the account deletes their applications, so their API clients stop working. Hand over anything still in use first.
3. **Danger zone → Delete**.

## 6. Retire an organization

An organization can be deleted once it owns nothing:

1. Inside it (step 4), delete its gateways, products, APIs and catalogs, and have its members delete their applications there.
2. Open **Organizations → the organization → Danger zone → Delete**. Its memberships, invitations, policies, connections and dictionary go with it.

If something is left, the console says what to delete first.

## 7. Script it

Everything above is available under `/api/admin`:

```bash
# Onboard Acme with Priya as its admin
curl -s "${auth[@]}" -d '{"name":"Priya Shah","email":"priya@acme.test","password":"a-temporary-password","organizationName":"Acme"}' \
  $BASE/api/admin/users | jq '.user | {id, email, organizations}'

# Reset a password
curl -s "${auth[@]}" -X PUT -d '{"password":"another-temporary-one"}' $BASE/api/admin/users/<user id>/password
```

See [Managing people](../guides/managing-people.md) for every endpoint and more recipes.

## What you have

An organization with two admins, ready to publish, and a routine for account requests. For the server itself (configuration, backups, upgrades), see [Operations](../guides/operations.md).
