# Tutorial 7: Work as a team

In this tutorial you invite a colleague, give them a role, and work across more than one organization.

**You need:** an account that is an admin of an organization.

**Time:** about 5 minutes.

## Roles

| | Admin | Member |
|---|---|---|
| Browse published products | Yes | Yes |
| Create applications and request access | Yes | Yes |
| Manage catalogs, APIs, products and the dictionary | Yes | No |
| Run gateways, policies and connections | Yes | No |
| Approve access requests | Yes | No |
| Invite and manage members | Yes | No |

Platform admins, a separate role across the whole installation, manage all users and organizations under **Admin**.

## 1. Invite someone

1. Click **Members** in the header.
2. Under **Invite by email**, enter their address, choose **Member** or **Admin**, and send the invitation.

If the console has email configured (`SMTP_HOST`, see [Configuration](../guides/configuration.md#email)), the invitation is emailed. Otherwise the console shows the invitation link for you to share. Invitation tokens are stored only as hashes, so the link is shown once.

**Pending invitations** lists what hasn't been accepted, with **Resend** and **Revoke**.

## 2. Accept it

The invited person opens the link:

- With no account yet, they choose a name and password, and join your organization.
- With an existing account, they confirm with their password and the organization is added to their list.

## 3. Change roles

In **Members**, change someone's role or remove them. An organization always keeps at least one admin, so you can't remove or demote the last one.

## 4. Work in several organizations

The switcher at the top left shows the organization you're working in and your role there. Open it to switch to another one. Everything on the pages follows the selected organization: catalogs, applications, gateways and members.

To create another organization, open the switcher and choose **Create or leave organizations**. You become its admin. The same page lets you leave an organization, unless you are its last admin.

Applications belong to the organization they were created in and can only use that organization's products.

## Next

You've been through the platform as a provider. Site admins continue with [Tutorial 8: Run the platform](08-run-the-platform.md). The [reference](../README.md#reference) covers users, the REST API, configuration and operations.
