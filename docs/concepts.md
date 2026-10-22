# Concepts

OAuth Server has two sides. **Providers** describe APIs and decide who may call them. **Developers** build applications that call those APIs. Both work in the same console, and what each person sees depends on their role.

```
organization
├── members (admin or member)
├── catalogs
│   ├── APIs (OpenAPI documents)
│   └── products (APIs + rate limit + billing plan, draft or published)
├── data dictionary (fields and objects reused by the APIs)
├── gateways (nodes, ports, observability), each serving one catalog
├── policies (request flows) and connections (how upstreams are called)
└── applications (clients, with their access requests)
```

## Organizations and roles

Everything belongs to an **organization**. A user can belong to several, and works in one at a time: the one selected in the switcher at the top left.

- **Admins** of an organization manage its catalogs, APIs, products, dictionary, gateways, policies, connections and members, and approve access requests.
- **Members** browse the organization's published products, create applications and request access.
- An organization always keeps at least one admin.

Separately, a user's **platform role** can be *admin*. Platform admins manage all users, organizations and applications under **Admin**, and can open any organization to act as its admin.

Data never crosses organizations. Asking for another organization's catalog, API or gateway answers *not found*.

## Catalogs

A **catalog** groups the APIs and products you publish together. It is also what a gateway serves: a gateway is attached to one catalog and serves its published products. Use several catalogs to separate, for example, public and partner APIs, or regions served by different gateways.

## APIs

An **API** is an OpenAPI 3.0 or 3.1 document, plus the settings a gateway needs:

- the **upstream server**, where the gateway sends traffic: the first `servers` URL of the document (change it on the Source tab);
- the **base path** clients use on the gateway, for example `/orders/v1`;
- an optional **policy**: the flow every request goes through;
- an optional **connection**: timeouts, retries, credentials and TLS for the upstream.

The gateway only lets through requests that match an operation of the document. You can edit an API in four views: **Overview**, **Design** (one endpoint at a time), **Schemas** (`components.schemas` as trees) and **Source** (the whole document).

## Data dictionary

The **data dictionary** holds the building blocks of your API schemas, per organization:

- A **field** is one value and its rules: type, format, length, range, pattern, allowed values, example. An object field can also have a structure of its own properties.
- An **object** is a set of properties. Each property is a field or another object, optionally a list, optionally required.

When you use a dictionary object in an API, it is written into the document's `components.schemas` and marked with `x-dictionary-id`. A field used as a parameter or body is copied in place and marked with `x-dictionary-field`. Documents never change by themselves when the dictionary changes. The Design tab shows what is out of date, and you choose when to update.

Importing an API fills the dictionary with its schemas and parameters.

## Products

A **product** bundles APIs from one catalog for developers to use. It has:

- a **rate limit**: requests per second, minute, hour or day, for each application;
- a **billing plan**: free, flat price or per request, for your records (nothing is charged);
- a state: **draft** or **published**. Only published products are shown to developers and served by gateways.

Developers request access to a product, never to a single API.

## Applications and access

An **application** is a client that calls APIs. It has a client ID, a client secret and redirect URIs. It belongs to the organization it was created in and can only use that organization's products.

To use a product, the application **requests access**. The request starts *pending*. An admin of the organization approves, rejects or later revokes it. Only approved applications get through the gateway.

The application gets a token from the console with the **client credentials** grant:

```bash
curl -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://console.example.com/oauth/token
```

The token is a signed JWT, valid for 10 minutes. Gateways verify it with the console's public key, so they don't call the console for each request. An application can have up to 10 extra credential sets, so secrets can be rotated without downtime. Tokens from any of them act as the application.

## Gateways

A **gateway** is the runtime for one catalog. It is made of **nodes**, processes that all serve the same configuration.

- **Connection handlers** are the ports nodes listen on for API traffic, HTTP or HTTPS. A handler can run on every node or on one only, and can have a **port policy** that runs before the API's own.
- **Push or pull.** The console pushes the configuration to a node's management port, or a node started with the console's link address pulls it. Both directions use mutual TLS with certificates from the console's own certificate authority.
- **Auto-push**, when on, pushes shortly after each change in the organization. Otherwise the gateway page shows that changes are not deployed yet, and you push yourself.
- **Observability** settings turn metrics, tracing, the request log, off-loading and usage metering on or off.

Clients call `<handler address><API base path><operation path>`, for example `https://api.example.com:8443/orders/v1/orders/42`.

## Policies and connections

A **policy** is a flow of steps that a request goes through on the gateway, built in the flow editor:

- **Gateway script** runs your JavaScript in a sandbox, on the request and the response.
- **If** branches on the request.
- **Invoke service** calls another URL.
- **Validate request** and **Validate body** check the request against the API's OpenAPI document.
- **Security** blocks injection attacks, limits sizes, filters client addresses and locks out brute force.

Attach a policy to an API, or to a handler as its port policy.

A **connection** sets how a gateway calls an upstream: timeouts, retries with backoff, a circuit breaker, upstream credentials, and TLS with your own CA or a client certificate.

## How a request flows

```
client ─► handler (port) ─► route (OpenAPI operation) ─► token ─► approved access ─► rate limit
       ─► port policy ─► API policy ─► upstream (connection) ─► response policies ─► client
```

Each stage can answer the client itself: 401 for a bad token, 403 without approved access, 404 for an unknown path, 429 over the rate limit, 422 for a request that doesn't match the document. The full list is in the [gateway README](../gateway/README.md#responses-from-the-gateway).
