# OAuth Server documentation

OAuth Server is an API management platform: providers publish APIs as products, developers get access for their applications, and gateways serve the traffic. This documentation is also in the console, under **Docs** in the menu.

## Start with your role

| You are | You want to | Start here |
|---|---|---|
| **Developer or member** | Find APIs, create applications, get tokens and call APIs | [Guide for developers and members](users/developers.md), then [Tutorial 5](tutorials/05-call-an-api.md) |
| **Organization admin** | Publish APIs, run gateways, approve access, manage your team | [Guide for organization admins](users/org-admins.md), then [Tutorial 1](tutorials/01-publish-your-first-api.md) |
| **Site admin** | Run the platform: users, organizations, the server | [Guide for site admins](users/site-admins.md), then [Tutorial 8](tutorials/08-run-the-platform.md) |
| **Integrator** | Automate any of this | [API examples](guides/api-examples.md) and the [REST API reference](guides/api-reference.md) |

New to the platform? Read [Concepts](concepts.md) for how organizations, catalogs, products, applications and gateways fit together, and [Users and roles](users/README.md) for who can do what.

Running the console yourself? [Getting started](getting-started.md) installs it.

## Tutorials

The first seven build on each other: work through them in order the first time.

| | Tutorial | For |
|---|---|---|
| 1 | [Publish your first API](tutorials/01-publish-your-first-api.md): a catalog, an imported OpenAPI file, a published product | Org admins |
| 2 | [Design an API with the data dictionary](tutorials/02-design-with-the-dictionary.md): reusable fields and objects for parameters and bodies | Org admins |
| 3 | [Edit schemas in the schema designer](tutorials/03-edit-schemas.md): `components.schemas` as trees, bodies edited in place | Org admins |
| 4 | [Run a gateway](tutorials/04-run-a-gateway.md): a port, a Docker node, an attached catalog | Org admins |
| 5 | [Call an API as a developer](tutorials/05-call-an-api.md): an application, access, a token, a call | Developers |
| 6 | [Protect an API with a flow](tutorials/06-protect-an-api-with-a-flow.md): validation, threat protection, a script, the real backend | Org admins |
| 7 | [Work as a team](tutorials/07-work-as-a-team.md): invitations, roles, several organizations | Org admins, members |
| 8 | [Run the platform](tutorials/08-run-the-platform.md): onboard an organization, help from inside, handle account requests | Site admins |

## Reference

**Users**

- [Users and roles](users/README.md): the kinds of users, what each role can do, and account options.
- [Developers and members](users/developers.md), [Organization admins](users/org-admins.md), [Site admins](users/site-admins.md): every page and option, by role.

**API**

- [REST API reference](guides/api-reference.md): every endpoint of the console.
- [API examples](guides/api-examples.md): end-to-end scripts, from publishing an API to calling it.
- [Managing people](guides/managing-people.md): site admins, org admins and members through the API.

**Operating**

- [Configuration](guides/configuration.md): every environment variable of the console.
- [Operations](guides/operations.md): production setup, migrations, backups, certificates and upgrades.
- [Security](guides/security.md): authentication, tenancy, secrets and the browser.
- [Gateway reference](../gateway/README.md): node settings, Docker and systemd, policies, checking steps and error responses.
- [Development](guides/development.md): architecture, tests and conventions.

## Help inside the console

- **Docs** in the menu opens this documentation, with a link to the guide for your role.
- The **?** button in the header tours the page you're on. The dashboard offers the platform tour on your first visit. Press **Esc** to leave a tour, and the arrow keys to move through it.
