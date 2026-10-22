# Users and roles

Everyone who signs in to the console has one account. What an account can do depends on two roles: its role in each organization it belongs to, and whether it is a site admin.

## Who uses the console

| Who | Typical person | Role | Read |
|---|---|---|---|
| **Developer** | Builds an app that calls your APIs | Member of an organization | [Guide for developers and members](developers.md) |
| **API provider** | Owns APIs, products and gateways for a team or company | Org admin of an organization | [Guide for organization admins](org-admins.md) |
| **Platform operator** | Runs this installation for everyone | Site admin | [Guide for site admins](site-admins.md) |

Two more kinds of users don't sign in to the console pages:

- **Applications** are OAuth clients. They authenticate with a client ID and secret at `POST /oauth/token` and call APIs through gateways.
- **Gateway nodes** authenticate to the console with certificates. People sign in to a node's admin UI with their console account, and only org admins of the gateway's organization are let in.

## Roles

### Member

Every person in an organization is at least a member. A member can:

- browse the organization's **published products** under **Catalogs**;
- create **applications** and manage their credentials;
- **request access** to products for their applications;
- see the organization's member list;
- switch between their organizations, create one if they belong to none, and leave one.

### Org admin

An org admin can do everything a member can, and manage the organization:

- **catalogs, APIs and products**: import and design APIs, publish products, set rate limits and billing;
- the **data dictionary**;
- **gateways, policies and connections**: run nodes, open ports, build request flows, deploy;
- **access requests**: approve, reject and revoke them;
- **people**: invite, add, promote, demote and remove members, rename the organization.

An organization always has at least one admin. The console refuses to remove or demote the last one, and the last admin can't leave.

### Site admin

A site admin manages the whole installation, under **Admin** in the menu:

- every **user**: create, edit, verify, set a password, make or unmake a site admin, delete;
- every **organization**: create, rename, manage members, delete;
- every **application**, across all users;
- **any organization's data**: a site admin can select any organization in the switcher and work in it as its admin. A banner shows when they do.

The site admin role is separate from organization roles. A site admin may belong to no organization at all.

## What each role sees in the menu

| Menu | Member | Org admin | Site admin |
|---|---|---|---|
| Dashboard | Yes | Yes | Yes |
| Catalogs | Published products | Everything in them | As org admin of the selected organization |
| Dictionary | | Yes | As org admin |
| Applications | Their own | Their own | Their own (all of them under Admin) |
| Gateways | | Yes | As org admin |
| Organization / Members | Member list | Members, invitations, settings | As org admin |
| Docs | Yes | Yes | Yes |
| Admin | | | Yes |

## Your account

**Register.** Registering asks for your name, an organization name, your work email and a password of at least 8 characters. It creates your account and a new organization with you as its admin.

**Join by invitation.** An invitation link adds you to an organization with the role the admin chose. Without an account you choose a name and password. With an account you confirm with your password, and the organization is added to your list.

**Profile.** **My profile** (the avatar at the top right) shows your name, email, selected organization and your role there, your platform role, whether your account is verified, when you joined and your user ID. A site admin changes names, emails and passwords for you.

**Sessions.** A sign-in lasts 24 hours. **Sign out** on the profile page, or the button at the top right, ends it on that device.

**Organizations.** The switcher at the top left lists your organizations and your role in each. Pick one to work in it. **Create or leave organizations** opens the page where you create one, if you're allowed to, or leave one.

**Tours and docs.** The **?** button tours the page you are on. **Docs** in the menu opens this documentation.

## Options at a glance

| Option | Who | Where |
|---|---|---|
| Create an organization | Org admins, site admins, people in no organization | Organization switcher → Create or leave organizations |
| Invite someone | Org admins | Members → Invite by email |
| Add someone with a temporary password | Org admins | Members → Add member manually |
| Make someone an org admin | Org admins, site admins | Members, or Admin → Organizations |
| Make someone a site admin | Site admins | Admin → user → Role |
| Reset someone's password | Site admins | Admin → user → Set a new password |
| Delete an account | Site admins | Admin → user → Danger zone |
| Approve access to a product | Org admins | Access requests, or the product page |
| Create an application | Everyone | Applications → New application |

To do these through the REST API, see [Managing people](../guides/managing-people.md).
