# Tutorial 4: Run a gateway

In this tutorial you create a gateway, start a node with Docker on your machine and attach it to the **Shop** catalog, so its published products can be called.

**You need:**

- the published **Shop Starter** product from [Tutorial 1](01-publish-your-first-api.md);
- Docker on the machine that runs the console;
- the console's gateway link on (it is by default, on port 3443).

**Time:** about 15 minutes.

## How it works

The console holds the configuration. A gateway node is a separate process that serves API traffic with it. In this tutorial the node runs in **pull mode**: it connects to the console's link on port 3443 with its credentials, registers itself and fetches the configuration. Console and node trust each other through certificates issued by the console's own certificate authority.

## 1. Build the gateway image

From the repository root:

```bash
docker build -t oauth-server-gateway:1.0.0 gateway
```

## 2. Create the gateway

1. Click **Gateways** in the header.
2. Under **New gateway**, enter:
   - **Name:** `Local`
   - **Public URL:** `http://localhost:8080`. This is the address developers call. It appears in the ready-made commands on product pages.
3. Create it.

The gateway page opens with a setup checklist:

1. Open a port for API traffic
2. Download the credentials
3. Start a node
4. Attach it to a catalog

## 3. Open a port

In **Connection handlers**, add a handler:

- **Name:** `public`
- **Port:** `8080`
- **Protocol:** `HTTP`
- **Runs on:** Every node (the cluster)

For production, use **HTTPS** and either let the console issue a certificate from its CA, or upload your own.

## 4. Download the credentials

Download the credentials file from the gateway page and save it in the folder you'll run Docker from. It holds the node's certificate and private key, so keep it private. Files matching `*credentials*.json` are git-ignored in this repository.

## 5. Start a node

In **Add a node**, the console shows the exact `docker run` command for your shell (PowerShell, Command Prompt, or macOS and Linux). It looks like this:

```bash
docker run -d --name local-1 --restart unless-stopped \
  -p 9445:9445 -p 9080:9080 -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e GATEWAY_MANAGEMENT_URL=https://host.docker.internal:3443 \
  -e GATEWAY_NODE_NAME=local-1 \
  -v "$PWD/local-credentials.json:/etc/oauth-gateway/credentials.json:ro" \
  -v local-1-data:/data \
  oauth-server-gateway:1.0.0
```

Copy it from the page rather than from here: it has your file name and ports. Run it in the folder with the credentials file.

Within a few seconds the node appears under **Nodes** as connected. If it doesn't, check its log:

```bash
docker logs local-1
```

## 6. Attach the catalog

Attach the gateway to the **Shop** catalog, either in the gateway's **Settings** or in the **Gateway** card of the catalog page. A gateway can be attached only while a node is running.

## 7. Push the configuration

Click **Push configuration**. The gateway now serves the published products of **Shop**.

To push automatically, turn on **Auto-push** in the gateway's **Settings**. The console then pushes a couple of seconds after each change in your organization.

## 8. Check it

The gateway refuses requests without a token, which shows it is serving the API:

```bash
curl -i http://localhost:8080/shop/orders
```

```
HTTP/1.1 401 Unauthorized
{"error":"invalid_request", ...}
```

An unknown path answers `404`, because the gateway only serves the operations of the OpenAPI document.

On the node itself:

- `http://localhost:9080/healthz` and `/readyz` report its health, and `/metrics` serves Prometheus metrics.
- `https://localhost:9445` is the node's admin UI. Sign in with your console account; only admins of the gateway's organization are accepted.

## What you have

A running gateway node serving the **Shop** catalog on port 8080. Next, [call the API as a developer](05-call-an-api.md).

For clusters, Redis, systemd and every node setting, see the [gateway README](../../gateway/README.md).
