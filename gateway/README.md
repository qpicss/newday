# OAuth Server gateway

The runtime that serves API traffic for OAuth Server. It is a separate Node.js 20 project with no database. Everything it serves comes from the management console. By default the console connects to the node: it checks that the node is alive, sends it the configuration and collects its usage. Alternatively the node connects to the console and pulls the configuration. Both directions use mutual TLS.

```
                  management console (this repo)
     push: status every 30 s,          ▲ pull: register, GET /v1/config, heartbeat, usage, admin sign-in
     PUT /v1/config, usage, tasks ▼    │
                  mTLS: both sides use certificates from the console's self-signed CA
                    │                  │
 client ──► connection handler ──► route ──► token ──► subscription ──► rate limit ──► port policy ──► API policy ──► upstream
            port, HTTP/HTTPS        OpenAPI   RS256     approved app      per product                                    connection
                                                                                                         ◄── response policies ◄──┘
```

## How it fits together

- **Catalog.** In the console, a catalog is a set of API products. A **gateway** serves one catalog. The configuration holds:
  - the catalog's *published* products;
  - their APIs: OpenAPI operations, upstream base URL, gateway base path, policy and connection;
  - the applications approved for them;
  - the connection handlers and their port policies;
  - the observability settings and the token verification key.
- **Nodes and clusters.** A gateway is one node or several. All nodes of a gateway use the same credentials file and receive the same configuration. Put a load balancer in front of a cluster. Rate limits work in two ways:
  - Without Redis, each node enforces `rate limit ÷ number of nodes`.
  - With `GATEWAY_REDIS_URL`, the nodes share exact counters. If Redis is unreachable, they fall back to their local share.
- **Push or pull.**
  - Push mode, the default: the console connects to each node's management port (9443). It needs no route from the node to the console, so it suits nodes in the cloud managed from an office or private network.
    - The console checks every push node every 30 seconds (`GATEWAY_MONITOR_MS`) and shows it as **Unreachable** when it doesn't answer.
    - A node that answers with an older configuration than the deployed one, for example after it was recreated with an empty data volume, gets the deployed configuration again. Changes that were never pushed are not sent this way.
    - The console also collects usage, the request log and flow tests from push nodes, renews their certificates and signs admins in to their admin UI.
  - Pull mode: the node is started with `GATEWAY_MANAGEMENT_URL`, the console's link address. It registers itself, polls for configuration with an ETag, sends heartbeats and reports usage. It needs no inbound port from the console.
  - With **auto-push** on, the console pushes shortly after any change.
- **Connection handlers.** These are the ports for API traffic, HTTP or HTTPS. A push opens, changes or closes ports without restarting the process. A handler can have a **port policy** that runs before the API's policy for every request on the port.
- **Connections.** A connection sets how an API's upstream is called:
  - connect and response timeouts;
  - retries for idempotent methods, with backoff;
  - a circuit breaker;
  - upstream credentials (basic, bearer or an API key header);
  - TLS: your own CA, a client certificate for mTLS, and the server name.
- **Requests.** Calls go to `<handler>/<API base path>/<OpenAPI path>`. The path must match an operation in the API's OpenAPI document.
- **Authentication.** Callers send `Authorization: Bearer <token>`, with a token from the console's `POST /oauth/token` (client credentials). The gateway verifies the token with the public key it was given, so it never calls the console per request.
- **Restarts.** The last configuration is saved to the data directory, so a restarted node serves traffic straight away. An invalid configuration is rejected and the previous one stays live.

## Run with Docker

```bash
docker build -t oauth-server-gateway:1.0.0 .

# Pull mode: the node registers itself with the console
docker run -d --name gateway-1 --restart unless-stopped \
  -p 9445:9445 -p 8443:8443 \
  -e GATEWAY_MANAGEMENT_URL=https://console.example.com:3443 -e GATEWAY_NODE_NAME=gateway-1 \
  -v "$PWD/credentials.json:/etc/oauth-gateway/credentials.json:ro" \
  -v gateway-1-data:/data \
  oauth-server-gateway:1.0.0
```

- Publish `9443` as well for push mode. `9445` is the admin UI and `9080` serves health checks and metrics.
- Publish every connection handler port you configure; `8443` above is an example.
- The container runs as a non-root user, so use handler ports ≥ 1024 and map them, e.g. `-p 443:8443`.
- `deploy/docker-compose.yml` runs a two-node cluster with Redis and an optional nginx load balancer.

## Run on Ubuntu 22.04 / 24.04

### Files to copy to the server

The gateway folder is self-contained. Copy these to the server, keeping the folder layout:

```
gateway/
├── package.json
├── package-lock.json
├── src/                          the runtime
├── ui/                           the admin UI
└── deploy/
    ├── install.sh                the installer
    ├── gateway.env.example       becomes /etc/oauth-gateway/gateway.env
    └── oauth-gateway.service     the systemd unit
<name>-credentials.json           next to the gateway folder, downloaded from the gateway's page
```

- Leave out `node_modules/`, which may have been built for another system, and `test/`. The installer runs `npm ci`, so the server needs internet access for npm, and for NodeSource if Node.js 20 isn't installed.
- The credentials file holds the gateway's private key. Copy it securely, for example with `scp`, and delete other copies.
- `README.md` is optional. The Docker files (`Dockerfile`, `deploy/docker-compose.yml`, `deploy/nginx.conf`) aren't needed for this install.
- If you copied the files from Windows without Git and bash reports `$'\r': command not found`, run `sed -i 's/\r$//' gateway/deploy/install.sh`. Copies from Windows also lose the execute bit; the first command below sets it again.

For example, from the repository root:

```bash
ssh user@server mkdir -p gateway/deploy
scp -r gateway/package.json gateway/package-lock.json gateway/src gateway/ui user@server:gateway/
scp gateway/deploy/install.sh gateway/deploy/gateway.env.example gateway/deploy/oauth-gateway.service user@server:gateway/deploy/
scp <name>-credentials.json user@server:
```

Then, on the server, run the commands shown on the gateway's page under **Linux service**, from the folder holding `gateway/` and the credentials file. They look like this:

### Install

```bash
chmod +x gateway/deploy/install.sh
sudo ./gateway/deploy/install.sh
sudo install -m 600 -o oauth-gateway <name>-credentials.json /etc/oauth-gateway/credentials.json
echo "GATEWAY_MANAGEMENT_URL=https://console.example.com:3443" | sudo tee -a /etc/oauth-gateway/gateway.env   # pull mode
echo "GATEWAY_NODE_NAME=node-1" | sudo tee -a /etc/oauth-gateway/gateway.env
sudo systemctl enable --now oauth-gateway
journalctl -u oauth-gateway -f
```

- The script installs Node.js 20 if needed, creates the `oauth-gateway` system user and installs a versioned release under `/opt/oauth-gateway/releases`, with `/opt/oauth-gateway/current` pointing to it.
- It also installs the hardened systemd unit `deploy/oauth-gateway.service`, which may bind ports below 1024.
- Re-run the script to upgrade. To roll back, point `current` at the previous release and restart.

## Connect it to the console

1. On the gateway's page, choose a catalog and add a connection handler.
2. Download the credentials file and start the node with it.
3. Connect the node. Step 3 of the gateway's setup checklist offers both ways:
   - **The console connects to the node (push, recommended):** start the node without `GATEWAY_MANAGEMENT_URL`, publishing port 9443, and open 9443 from the console to the node. Then enter the node's address, e.g. `https://203.0.113.10:9443`. The console checks it at once and reports whether it answered. Click **Push configuration** to send it the configuration.
   - **The node connects to the console (pull):** set `GATEWAY_MANAGEMENT_URL` to the console link shown on the gateway page. The node appears under Nodes by itself. The address must be reachable from the node: a console that runs on `localhost` must set `GATEWAY_LINK_PUBLIC_URL` (and open its link port) for nodes on other machines. The page warns when the link address is `localhost`.

The console accepts only certificates that name this gateway (`CN=gateway:<id>`) and are not revoked. The node accepts only the console's certificate (`CN=oauth-server-management`). The console's CA issues both.

### Certificates

- **Renew** issues a new certificate:
  - Push nodes receive it right away.
  - Pull nodes learn about it from their next heartbeat and download it.
  - Either way, the node switches its TLS servers to it without a restart. The renewed file is kept in the data directory.
- **Revoke** blocks a certificate from the link and from pushes.
- The console warns 30 days before a certificate in use expires.

## Observability

Everything is built in. Each part can be turned on or off per gateway in the console.

- **Prometheus metrics** at `http://<node>:9080/metrics`:
  - `gateway_requests_total` and `gateway_request_duration_seconds`;
  - `gateway_upstream_duration_seconds` and `gateway_upstream_errors_total`;
  - `gateway_policy_errors_total`, `gateway_rate_limited_total`, `gateway_auth_failures_total` and `gateway_threats_total` (by rule, blocked or only detected);
  - `gateway_circuit_open`;
  - the off-load counters, and `gateway_config_info` with the configuration version.
- **Tracing.** Every request gets a W3C `traceparent`, continued from the caller's when present. It is forwarded upstream as a child span. The trace ID is also in the request log.
- **Request log.** A ring buffer in memory holds method, path, status, timings, API, application, trace and error for each request. Headers and bodies are never stored. The console's **Live requests** page and the admin UI show it.
- **Off-load.** Each request record can also be sent to:
  - an HTTP endpoint, as a JSON array per batch;
  - an OpenTelemetry collector, as OTLP/HTTP JSON logs.

  The off-load has these properties:
  - It supports an optional auth header, a batch size, a flush interval and a sample rate.
  - Failed sends are retried with backoff.
  - When the buffer is full, records are dropped and counted in `gateway_offload_dropped_total`, so API traffic is never slowed.
- **Usage metering.** Requests per application, product and API are counted per minute and sent to the console. The console charts them on the gateway, product and application pages.

## Admin UI

Open `https://<node>:9445`. The server uses the gateway's certificate, so trust the management CA, or accept the certificate once.

- **Sign-in.** Only console accounts that are **org admins of the organization that owns the gateway** (or platform admins) get in. There are two ways:
  - **Open admin UI** on the gateway page in the console (on a node, or in its addresses). The console signs a one-time ticket that is valid for 60 seconds and opens the admin UI with it. The node checks the ticket with the token key from its configuration, so this works for push nodes that can't reach the console. The node needs a configuration first.
  - Email and password on the sign-in page. The node checks them with the console over the mTLS link and never stores them, so this needs a node that can reach the console (pull mode).
- **Sessions.** Sessions last 8 hours, in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
- **Pages:**
  - an overview: configuration, handlers, APIs, connections and their circuit state, certificate and off-load status;
  - a live request stream with filters;
  - metrics charts for requests, server errors and p95 latency over the last 30 minutes;
  - the effective settings.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_CREDENTIALS` | `./credentials.json` (`/etc/oauth-gateway/credentials.json` in Docker and systemd) | Credentials file from the console |
| `GATEWAY_DATA_DIR` | `./data` (`/data`, `/var/lib/oauth-gateway`) | Last applied configuration and renewed credentials (mode 600) |
| `GATEWAY_MANAGEMENT_URL` | none | Console link address; turns on pull mode |
| `GATEWAY_NODE_NAME` | host name | Name shown in the console |
| `GATEWAY_ADVERTISE_URL` | none | Management address the console may also push to |
| `GATEWAY_POLL_INTERVAL_MS` / `HEARTBEAT_` / `USAGE_` | `15000` / `30000` / `60000` | Pull mode intervals |
| `GATEWAY_MANAGEMENT_HOST` / `_PORT` | `0.0.0.0` / `9443` | mTLS endpoint for console pushes |
| `GATEWAY_ADMIN_ENABLED` / `_HOST` / `_PORT` | `true` / `0.0.0.0` / `9445` | Admin UI |
| `GATEWAY_HEALTH_HOST` / `_PORT` | `0.0.0.0` / `9080` | `/healthz`, `/readyz` (configured and all handlers listening), `/metrics` |
| `GATEWAY_BIND_HOST` | `0.0.0.0` | Address the connection handlers listen on |
| `GATEWAY_REDIS_URL` | none | Shared rate limits across the cluster |
| `GATEWAY_MAX_BODY_BYTES` | `10485760` | Larger requests get `413` |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | `30000` | Timeout for APIs without a connection |
| `GATEWAY_POLICY_WORKERS` | `2` | Worker threads that run policies |
| `GATEWAY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Logs are JSON lines on stdout, one line per request.

## Policies

```js
module.exports = {
  async onRequest(callcontext) {
    // Read-only: method, path, operationPath, params, query, queryString, headers, body (string), remoteAddress, protocol
    const incoming = callcontext.original;

    // Read/write: what is sent upstream
    callcontext.method = incoming.method;
    callcontext.path = '/v2' + callcontext.path;              // operation path, appended to the API's base URL
    callcontext.query = { ...callcontext.query, source: 'gateway' };
    callcontext.headers['x-signature'] = crypto.hmacSha256('shared-secret', incoming.path, 'base64');
    callcontext.body = { ...JSON.parse(incoming.body || '{}'), receivedBy: 'gateway' }; // objects are sent as JSON

    // Optional: answer the client without calling the upstream
    if (incoming.query.debug === 'true') callcontext.reply(400, { error: 'debug is not allowed' });
  },
  async onResponse(callcontext) {
    // callcontext.request: what was sent upstream (read-only)
    callcontext.response.headers['x-served-by'] = 'gateway';
    if (callcontext.response.status >= 500) callcontext.response.body = { error: 'Try again later' };
  },
};
```

- A module that exports a single function is an `onRequest` policy.
- `callcontext.headers` starts as the incoming headers without `authorization`, `host` and connection-level headers. The gateway then sets these:
  - `host` and `content-length`;
  - `x-forwarded-*`, `x-request-id` and `x-gateway-client-id`;
  - `traceparent`;
  - the connection's credential header, unless the policy set that header itself.
- The context also holds:
  - `callcontext.consumer`: `{ clientId, application, product }`;
  - `callcontext.api`: `{ id, name, version, basePath }`;
  - `callcontext.requestId` and `callcontext.traceId`.
- Built-in helpers:
  - `crypto.sha256(data, enc)` and `crypto.hmacSha256(key, data, enc)`, with `enc` set to `hex`, `base64` or `base64url`;
  - `base64.encode()`, `base64.decode()` and `base64.encodeUrl()`.
  - `console.log` writes to the gateway log.
- Order of execution:
  - On the request: the port policy, then the API policy.
  - On the response: the API policy, then the port policy.
  - A response phase buffers text responses up to the body limit. Binary responses are passed through unchanged.
- Sandbox:
  - Policies run in worker threads, each policy in its own `vm` context with no `require`, `process`, timers, network or `eval`.
  - A policy that exceeds its time limit, or exhausts the worker's memory (128 MB), fails that request with `500 policy_error`. Its worker is replaced without affecting other traffic.
  - `isolated-vm` is not used, because it needs native compilation on every target.
- Test runs. The console's policy editor has a **Test** panel. It runs unsaved code on one of your gateway nodes (`POST /v1/policy-test`) against a sample request or response. Nothing is deployed, and no upstream is called.

## Checking steps

Three flow steps check requests without any code. Each answers the client itself when it finds a problem, and the rest of the flow is skipped.

- **Validate request.** Checks headers and the query string against the parameters of the OpenAPI operation the request matched: required parameters are present, and values match their schema (type, enum, format, pattern, length, range, items). Query parameters are read by their `style` and `explode` (repeated, comma, space or pipe separated, `deepObject`), and parameters with `content` are parsed as JSON. Optionally, undeclared query parameters are refused.
- **Validate body.** Checks the body against the operation's `requestBody`: required, an accepted Content-Type, and the schema for JSON, form and text bodies (`allOf`, `anyOf`, `oneOf`, `not`, `nullable` and OpenAPI 3.1 type lists included; `readOnly` properties are not required). Optionally, undeclared properties are refused.
- **Security.** Blocks (or, in monitor mode, only logs) SQL, script (XSS), path traversal, command and NoSQL injection in the path, query, headers and body, after URL, double URL and HTML entity decoding. It also limits the body size and the depth and size of JSON, allows or denies client addresses (IPv4 and IPv6 ranges), and locks out a client address, application, header value or body field after repeated failed answers (brute force). Each node counts failures on its own. Findings name the rule and the place, never the value.

The console resolves the OpenAPI `$ref`s and sends each operation's parameters and request body (`operations[].contract`) only for APIs whose policy, or a port policy, has a Validate step.

## Responses from the gateway

| Status | `error` | When |
|---|---|---|
| 401 | `invalid_request` / `invalid_token` | Missing, expired or foreign token |
| 403 | `forbidden` | The application has no approved product with this API |
| 404 / 405 | `not_found` / `method_not_allowed` | Path or method not in the OpenAPI document |
| 400 | `request_too_complex` | A Security step's JSON depth or size limit |
| 403 | `request_blocked` / `access_denied` | A Security step found an attack, or the client address is not allowed |
| 413 | `payload_too_large` | Body over `GATEWAY_MAX_BODY_BYTES`, or over a Security step's limit |
| 415 | `unsupported_media_type` | Validate body: a Content-Type the operation does not accept |
| 422 | `invalid_request` / `invalid_body` | Validate request or Validate body: the request does not match the OpenAPI operation (`errors` lists each problem) |
| 429 | `rate_limited` / `too_many_failures` | Product rate limit reached (`Retry-After`, `RateLimit-*` headers), or a Security step locked the caller out (`Retry-After`) |
| 500 | `policy_error` | The policy threw, timed out or did not finish |
| 502 | `bad_gateway` / `upstream_tls_error` | Upstream unreachable, or its certificate was not trusted |
| 503 | `circuit_open` / `not_configured` | The connection's circuit breaker is open, or no configuration yet |
| 504 | `upstream_timeout` | Upstream too slow (after retries) |

## Development

```bash
npm install
npm test          # unit tests and end-to-end tests over real mTLS with throwaway CAs
```
