# Guide for organization admins

You publish APIs for your organization and decide who may call them. This guide covers every page and option an org admin has, in the order you usually need them. You can also do everything a member can; see the [guide for developers](developers.md).

## Setting up an organization

The dashboard shows a checklist until it's done:

1. **Create a catalog**: catalogs hold your products and APIs.
2. **Add APIs**: import an OpenAPI file or describe the endpoints.
3. **Publish a product**: bundle APIs, set a rate limit and price, publish.
4. **Create and run a gateway**: download its credentials, start a node.
5. **Attach the gateway to the catalog**: it then serves the catalog's published products.

Tutorials [1](../tutorials/01-publish-your-first-api.md), [4](../tutorials/04-run-a-gateway.md) and [6](../tutorials/06-protect-an-api-with-a-flow.md) walk through these steps.

The dashboard also tells you about access requests waiting for you, and gateway certificates that expire soon.

## Catalogs

**Catalogs** lists your catalogs; **New catalog** creates one. A catalog page has:

| Card | Options |
|---|---|
| Summary | Counts of products, APIs and published products |
| Products | Every product with its state; create one by name |
| APIs | Every API; **Import OpenAPI** or **Create API** |
| Gateway | The gateway serving the catalog; attach one that's running |
| Details | Name and description |
| Danger zone | Delete the catalog, once no gateway serves it and it has no products or APIs |

**Push** at the top sends the latest configuration to the attached gateway.

## APIs

### Add an API

- **Import OpenAPI**: drop or paste an OpenAPI 3.0 or 3.1 document, as JSON or YAML, up to 2 MB. The console checks it, creates the API and fills the [data dictionary](#data-dictionary) with its schemas and parameters.
- **Create API**: a name, version, optional base URL and description, and the endpoints (method and path). The console writes the OpenAPI document for you.

### The four tabs

| Tab | What you do there |
|---|---|
| **Overview** | Endpoints as a tree of paths (add, remove, serve one without a token), the policy, details (name, version, description), gateway settings, the products using the API, delete |
| **Design** | Edit one endpoint at a time: summary, operation ID, description, deprecated, parameters, request body, responses |
| **Schemas** | Edit `components.schemas` as trees: create, rename, change, delete, add to the dictionary |
| **Source** | Edit the whole document as JSON or YAML, check it, save it |

### Endpoints (Overview)

The **Endpoints** card shows the API's paths as a tree: each path under its parent (`/orders/{id}` under `/orders`), with its operations. Each operation has buttons to design it, remove it, and serve it without a token.

**Serve without a token** (the open lock) makes one operation public while the rest of the API still needs a token, for example a status or a catalog endpoint. The gateway then serves that operation to anyone: no token, no subscription and no product rate limit, and its flow sees no consumer. The operation shows **No token** and is highlighted. The closed lock requires a token again. The setting is stored in the OpenAPI document as `x-gateway-access: public` on the operation, and the **Design** tab has the same option under the endpoint's details. Push the gateway (auto-push does it for you) to deploy it, and protect a public operation with a Security step in the policy.

### Policy (Overview)

The **Policy** card, at the top of the right column, shows the flow every request to the API goes through: its name, its steps from Input to Output, and how many other APIs share it (changing a shared flow changes them too). **Edit flow** opens it in the flow editor, and **Change policy** picks another one. Every new API gets a policy of its own. Without steps, or without a policy, the gateway answers `200` with the request's own body and doesn't call the backend.

### Gateway settings (Overview)

| Setting | |
|---|---|
| Base path | Where clients call the API on the gateway, for example `/orders/v1`. Unique in the organization. |
| Access | **Applications with an approved subscription** (the default: a token is required), or **Public**: anyone may call any of its operations without a token, for example a website. To open only some operations, keep the subscription access and mark those operations in **Endpoints**. A public API still has to be in a published product of the gateway's catalog, but the gateway doesn't check tokens or subscriptions and doesn't apply the product's rate limit. Its flow sees no consumer, so protect the backend with a Security step. |
| Connection | How the backend is called: timeouts, retries, credentials, TLS |

The backend address is the first `servers` URL of the OpenAPI document. Change it on the **Source** tab.

### Design tab

- **Parameters**: add one from a dictionary field (choose path, query, header or cookie, an optional name and description, required), or create a new field on the spot. Edit a parameter's schema with the field form or as JSON, and optionally save the change to its field. Path-level parameters are edited in the source.
- **Request body**: described by a dictionary object, a schema of the document or a dictionary field, with a content type, optionally as a list, optionally required. **New object** builds a dictionary object in a dialog.
- **Responses**: one per status code, with a description and an optional body described the same way. Every endpoint keeps at least one response.
- **View and edit** opens a body or response written in the endpoint in the schema editor. **Move to schemas** turns it into a named schema.
- **Schemas in this document** lists `components.schemas`, marks those from the dictionary, and offers **Update from dictionary** when the dictionary has changed. **Add this document to the dictionary** imports everything into the dictionary.

### Schemas tab

The schema editor shows a schema as a tree, with an inspector for the selected row. A row holds a value, an object, a list of objects, a reference to another schema, or raw JSON. It has undo and redo, and JSON, YAML and Example views. Saving checks the shape and that every reference exists. Renaming updates every reference; a schema in use can't be deleted. See [Tutorial 3](../tutorials/03-edit-schemas.md).

### Source tab

Edit the document in full, including shared components. **Check** validates without saving and points at the first problem. **Save document** refuses to overwrite a change someone else saved in the meantime.

## Data dictionary

**Dictionary** holds reusable building blocks for your API schemas.

- **Fields**: a name, a description, a type (string, number, integer, boolean, array, object) and its rules: format, pattern, length, minimum and maximum, allowed values, list item type and size, nullable, read-only, write-only, deprecated, default and example. An object field can have a structure of its own properties, edited in the schema editor.
- **Objects**: a name, a description, whether unlisted properties are allowed, and properties. Each property is a field or another object, optionally a list, optionally required.
- **Fill from an API**: imports one of your APIs' schemas and parameters.
- Each entry's page shows where it is used, and the schema it becomes in a document. Entries in use can't be deleted.

Changing the dictionary never changes documents by itself. Each API's Design tab shows what is out of date. See [Tutorial 2](../tutorials/02-design-with-the-dictionary.md).

## Products

Create a product in a catalog, then open it:

| Card | Options |
|---|---|
| Header | **Publish** or **Unpublish**. A product needs at least one API to be published. |
| Info | Name and description, shown to developers |
| APIs | Add APIs of the same catalog, or remove them |
| Access requests | The applications that asked for this product: approve, reject, revoke |
| Rate limit | On or off; requests per second, minute, hour or day, for each application |
| Billing | Free, flat (a price per month or year) or per request, in USD, EUR, GBP, CAD, AUD, JPY, CHF or INR. Shown to developers and stored; nothing is charged. |
| Usage | Requests per day |
| Danger zone | Delete the product |

## Access requests

**Access requests** (from the dashboard, or each product page) lists requests waiting for a decision and recent decisions.

| From | You can |
|---|---|
| Pending | Approve or reject |
| Approved | Revoke |

Approved access takes effect at the next push of the gateway, which happens on its own with auto-push.

## Gateways

**Gateways** has three tabs: **Gateways**, **Policies** and **Connections**. Create a gateway with a name and the public URL clients call. The Gateways page also shows the fingerprint of the management certificate authority.

### A gateway's page

| Section | Options |
|---|---|
| Header | **Live requests**, **Check status** (asks every node), **Push configuration**; badges for its catalog and auto-push |
| Setup | The remaining steps until the gateway serves traffic |
| Nodes | Every node with its mode (push or pull), host, port offset, software and configuration version, when it was last seen or pushed, and its last error; change where it runs, or remove it |
| Addresses | The address of each port, per node, for clients and load balancers |
| Connection handlers | Ports for API traffic: name, port, HTTP or HTTPS, every node or one, a port policy and a home path. HTTPS uses a certificate issued by the management CA or your own (PEM certificate and key). The home path (for example `/site/`) is where a browser asking for `/` on the port is redirected; without one, `/` answers 404. |
| Observability | Live request log (and how many requests each node keeps), Prometheus metrics, the node's admin UI, and off-load of request records to an HTTP endpoint or an OpenTelemetry collector, with auth header, batch size, flush interval and sample rate |
| Add a node | Name it, choose the same Docker host (ports shifted by an offset) or another server, and copy the command for PowerShell, Command Prompt, or macOS and Linux |
| Credentials | Download the credentials file; certificates with their expiry; **Renew**; **Revoke** |
| Settings | Name, public URL, catalog, **Push changes automatically** |
| Trust | The names each side's certificate must carry |
| Danger zone | Delete the gateway |

**Push configuration** shows problems that block a push, such as a flow with an error, before anything is sent.

### Live requests

Each request served by the nodes, newest first, with method, path, status, timings, API, application, node and trace ID. Filter by status class (2xx to 5xx) and API, or search; **Follow live** keeps the list updating. **Latest** sets how many requests are fetched from the nodes (100 to 1,000), and **Rows per page** how many show at once, with page buttons under the table. Click a request to open its log right under it, and click again to close it; open logs stay open while the list refreshes.

The log shows the request's **steps** the way a policy test does, beside the whole entry as JSON. Every request has them, including one no API matches:

- **Gateway**: Receive (port and client address), Route (the API and operation, or why none matched), Access (public, or whose token was accepted or why it was refused), Rate limit (what is left), and at the end Respond (the status and error sent back).
- **Policy**: every step the port's policy and the API's policy ran, in order, with how long it took and what it decided (for example "No: the conditions are not met", or the backend call and its status), a Validate step's problems, a Security step's findings, a Gateway script's `console` lines and the error of a step that failed.

The step that ended a request early is highlighted, and one that failed shows in red. Headers, bodies and query strings are never recorded, and credentials in a called URL are masked. Script lines are recorded as the script writes them, so don't log secrets from a script. The node's admin UI shows the same log, also in a row under the request. Nodes running an older gateway version record no steps until they're updated.

### Policies

A policy is a flow of steps, built in the flow editor. Drag steps from **Add a step**, join them with lines from **Input** to **Output**, and set each one up in the panel on the right.

| Step | Settings |
|---|---|
| Gateway script | Your JavaScript, a time limit, and examples to start from: add headers, reshape the JSON body, check a JWT from the caller, rate limit by IP address, enrich with a REST call, change the response, sign the request, answer without a backend |
| If | Conditions on the method, path, a request header, query parameter or body, a variable, the response's status, header or body, the client ID, application or product; compared with equals, contains, starts or ends with, in, greater or less than, exists, and their opposites; all or any must match |
| Invoke service | The API's backend or any URL (with values inserted from the request), whether to add the request's path, the method, a connection, a timeout, redirects to follow, headers to add or remove, query parameters, the body (the request's, none, or a template) and its content type; keep the answer as the response or in a variable; on failure, stop with `502` or `504`, or continue |
| Validate request | Checks headers and query parameters against the OpenAPI operation; answers `422`; optionally refuses undeclared query parameters |
| Validate body | Checks the body against the operation's request body; answers `415` or `422`; optionally refuses undeclared properties |
| Security | Block or only log; injection attacks (SQL, script, path traversal, command, NoSQL); limits on body size, JSON depth and entries; client addresses to allow or deny; brute-force lockout counted per client address, application, request header or body field, with the answers that count as failures, how many are allowed, within how long, and how long to lock out |

**Test** runs the unsaved flow on one of your gateway nodes against a sample request: choose an API, method, path, query, headers and body. Nothing is deployed and no backend is called.

Attach a policy to an API on its Overview tab, or to a port as its port policy.

### Connections

| Section | Settings |
|---|---|
| Timeouts and retries | Connect and response timeouts, retries, and the status codes to retry on (idempotent methods only) |
| Circuit breaker | Open the circuit after a number of failures in a row; cooldown before one trial request |
| Upstream credentials | None, basic, bearer token or an API key header |
| TLS | Verify the backend certificate, server name, trusted CA certificates, and a client certificate and key for mutual TLS |
| Used by | The APIs and Invoke steps using it |

Secrets are sealed in the database and never shown again after saving.

## Members

**Members** in the menu manages the organization's people.

| Card | Options |
|---|---|
| Members | Everyone with their role; change a role or remove someone (not yourself) |
| Pending invitations | Resend (a new link) or revoke |
| Invite by email | Email and role. Without email set up, the console shows the link to share. |
| Add member manually | An existing account joins at once; for a new one you set a full name and temporary password |
| Settings | The organization's name |
| Your organizations | Create another organization, switch, or leave |

Keep at least two admins, so the organization isn't stuck when one is away.

## Automating

Every page uses the REST API under `/api/org`. See the [REST API reference](../guides/api-reference.md), [API examples](../guides/api-examples.md) and [Managing people](../guides/managing-people.md).
