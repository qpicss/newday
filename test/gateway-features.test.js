// The console side of the gateway improvements, end to end with real in-process gateway nodes:
// pull registration over the mTLS link, usage reporting, admin UI sign-in, connections,
// observability settings, port policies, flow tests on push and pull nodes, live requests,
// auto-push, certificate renewal and revocation.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  models,
  resetDatabase,
  createUser,
  api,
  browser,
  request,
  app,
} = require('./helpers');
const { createGateway } = require('../gateway/src/gateway');
const { createLogger } = require('../gateway/src/logger');
const { startLinkServer } = require('../services/linkServer');
const { setAutoPushEnabled } = require('../services/autoPush');
const { testFlowOnGateway } = require('../services/gatewayPush');
const { loadGateway } = require('../services/gatewayQueries');
const { checkGateway } = require('../services/gatewayMonitor');
const { pollingNodes } = require('../services/linkTasks');

const { GatewayNode, GatewayCredential, UsageRecord, Api } = models;

// Policy flows from a chain of steps: Input -> steps -> Output.
const chain = (steps) => {
  const nodes = [
    { id: 'input', type: 'input' },
    ...steps.map((step, index) => ({ id: `step${index + 1}`, ...step })),
    { id: 'output', type: 'output' },
  ];
  return { nodes, edges: nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id })) };
};
const script = (code) => ({ type: 'script', name: 'Script', config: { code } });
const backend = (config = {}) => ({ type: 'invoke', name: 'Call the backend', config: { target: 'backend', appendPath: true, ...config } });

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const waitFor = async (check, { timeoutMs = 8000, intervalMs = 50, message = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

const startUpstream = () => new Promise((resolve) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  }));
});

const openapi = (upstreamUrl) => JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Orders API', version: '1.0.0' },
  servers: [{ url: upstreamUrl }],
  paths: { '/orders': { get: { summary: 'List orders' }, post: { summary: 'Create order' } } },
});

// Minimal HTTPS JSON client for the gateway admin UI, trusting the management CA.
const adminCall = (port, ca, { method = 'GET', pathname, body, cookie, uiHeader = true }) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const req = https.request({
    host: '127.0.0.1',
    port,
    method,
    path: pathname,
    ca,
    headers: {
      ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      ...(uiHeader && { 'x-gateway-ui': '1' }),
      ...(cookie && { cookie }),
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      resolve({ status: res.statusCode, headers: res.headers, body: json });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

// Calls the console link directly with a gateway certificate.
const linkCall = (port, bundle, pathname, body) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body || {});
  const req = https.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: pathname,
    ca: bundle.managementCa,
    cert: bundle.certificate,
    key: bundle.privateKey,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
  });
  req.on('error', reject);
  req.end(payload);
});

describe('gateway features in the console', () => {
  let publisher;
  let member;
  let outsider;
  let developer;
  let upstream;
  let linkServer;
  let linkPort;
  let apiId;
  let productId;
  let application;
  let pullGatewayId;
  let pushGatewayId;
  let pullBundle;
  let pushBundle;
  let pullHandlerPort;
  let pushHandlerPort;
  let pullNode;
  let pushNode;
  const dataDirs = [];

  const gatewayPath = (id) => `/api/org/gateways/${id}`;
  const tokenFor = async () => {
    const res = await request(app).post('/oauth/token').auth(application.clientId, application.clientSecret)
      .type('form').send({ grant_type: 'client_credentials' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.access_token;
  };
  const callGateway = async (port, pathname = '/orders/orders') => fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { authorization: `Bearer ${await tokenFor()}` },
  });

  const startNode = async (bundle, overrides = {}) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-features-'));
    dataDirs.push(dataDir);
    const node = createGateway({
      credentials: bundle,
      managementHost: '127.0.0.1',
      managementPort: 0,
      healthHost: '127.0.0.1',
      healthPort: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      bindHost: '127.0.0.1',
      dataDir,
      policyWorkers: 1,
      pollIntervalMs: 100,
      heartbeatIntervalMs: 100,
      usageIntervalMs: 100,
      logger: createLogger('silent'),
      ...overrides,
    });
    const ports = await node.start();
    return { node, ports };
  };

  const createGatewayWithHandler = async (name, port) => {
    const created = await api('post', '/api/org/gateways', publisher).send({ name, publicUrl: `http://127.0.0.1:${port}` });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.gateway.id;
    await api('put', gatewayPath(id), publisher).send({ autoPush: false });
    const handler = await api('post', `${gatewayPath(id)}/handlers`, publisher).send({ name: 'Public HTTP', port, protocol: 'http' });
    assert.equal(handler.status, 201, JSON.stringify(handler.body));
    const credentials = await api('get', `${gatewayPath(id)}/credentials`, publisher);
    assert.equal(credentials.status, 200);
    return { id, bundle: JSON.parse(credentials.text) };
  };

  before(async () => {
    await resetDatabase();
    upstream = await startUpstream();
    linkServer = await startLinkServer({ port: 0, host: '127.0.0.1' }, { logger: {} });
    linkPort = linkServer.address().port;

    publisher = await createUser({ name: 'Publisher', password: 'publisher-pass-1' });
    const organization = await models.Organization.findByPk(publisher.organizationId);
    member = await createUser({ name: 'Member', organization, password: 'member-pass-1' });
    outsider = await createUser({ name: 'Outsider', password: 'outsider-pass-1' });
    developer = await createUser({ name: 'Developer', organization });

    const catalog = await api('post', '/api/org/catalogs', publisher).send({ name: 'Public' });
    const catalogId = catalog.body.catalog.id;
    const imported = await api('post', '/api/org/apis/import', publisher).send({ content: openapi(upstream.url), catalogId });
    apiId = imported.body.api.id;
    await api('put', `/api/org/apis/${apiId}`, publisher).send({ basePath: '/orders' });
    // The API's own policy starts by returning the request; these tests proxy to the backend.
    await api('put', `/api/org/policies/${imported.body.api.policyId}`, publisher).send({ flow: chain([backend()]) });
    const product = await api('post', '/api/org/products', publisher).send({ name: 'Orders', catalogId });
    productId = product.body.product.id;
    await api('post', `/api/org/products/${productId}/apis`, publisher).send({ apiId });
    await api('put', `/api/org/products/${productId}`, publisher).send({ status: 'published' });

    const created = await api('post', '/api/applications', developer).send({ name: 'Storefront', redirectUris: ['https://shop.test/cb'] });
    application = created.body.application;
    const requested = await api('post', `/api/applications/${application.id}/subscriptions`, developer).send({ productId });
    await api('put', `/api/org/subscriptions/${requested.body.subscription.id}`, publisher).send({ status: 'approved' });

    pullHandlerPort = await freePort();
    pushHandlerPort = await freePort();
    ({ id: pullGatewayId, bundle: pullBundle } = await createGatewayWithHandler('Edge pull', pullHandlerPort));
    ({ id: pushGatewayId, bundle: pushBundle } = await createGatewayWithHandler('Edge push', pushHandlerPort));

    // A pull node knows only the console's link address; a push node is added by its management address.
    pullNode = await startNode(pullBundle, { managementUrl: `https://127.0.0.1:${linkPort}`, nodeName: 'pull-1' });
    pushNode = await startNode(pushBundle);
    const added = await api('post', `${gatewayPath(pushGatewayId)}/nodes`, publisher).send({ name: 'push-1', url: `https://127.0.0.1:${pushNode.ports.managementPort}` });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    // Both gateways run now, so they can be attached to the catalog.
    await waitFor(() => GatewayNode.findOne({ where: { gatewayId: pullGatewayId, name: 'pull-1' } }), { message: 'the pull node to register' });
    for (const id of [pullGatewayId, pushGatewayId]) {
      const attached = await api('put', gatewayPath(id), publisher).send({ catalogId });
      assert.equal(attached.status, 200, JSON.stringify(attached.body));
    }
    const pushed = await api('post', `${gatewayPath(pushGatewayId)}/push`, publisher);
    assert.equal(pushed.body.ok, true, JSON.stringify(pushed.body));
  });

  after(async () => {
    setAutoPushEnabled(false);
    await Promise.all([pullNode?.node.stop(), pushNode?.node.stop()]);
    await new Promise((resolve) => { linkServer.closeAllConnections?.(); linkServer.close(resolve); });
    await upstream.close();
    for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('pull mode', () => {
    it('registers the node over the link and pulls the configuration', async () => {
      const preview = await api('get', `${gatewayPath(pullGatewayId)}/config`, publisher);
      const { version } = preview.body.config;
      const node = await waitFor(async () => {
        const found = await GatewayNode.findOne({ where: { gatewayId: pullGatewayId, name: 'pull-1' } });
        return found && found.configVersion === version ? found : null;
      }, { message: 'the pull node to report the current version' });
      assert.equal(node.mode, 'pull');
      assert.equal(node.url, null);
      assert.ok(node.lastSeenAt);
      assert.ok(node.softwareVersion);
      assert.equal(node.certificateFingerprint, (await GatewayCredential.findOne({ where: { gatewayId: pullGatewayId } })).fingerprint);

      const page = await browser('get', `/developer/gateways/${pullGatewayId}`, publisher);
      assert.equal(page.status, 200);
      assert.match(page.text, /pull-1/);
      assert.match(page.text, /In sync/);
      assert.match(page.text, /GATEWAY_MANAGEMENT_URL=/);
    });

    it('serves traffic from the pulled configuration and reports usage', async () => {
      const response = await callGateway(pullHandlerPort);
      assert.equal(response.status, 200);
      const records = await waitFor(async () => {
        const rows = await UsageRecord.findAll({ where: { gatewayId: pullGatewayId } });
        return rows.length ? rows : null;
      }, { message: 'usage from the pull node' });
      assert.equal(records[0].productId, productId);
      assert.equal(records[0].applicationId, application.id);
      assert.ok(records[0].requests >= 1);

      const usage = await api('get', `${gatewayPath(pullGatewayId)}/usage`, publisher);
      assert.equal(usage.status, 200);
      assert.equal(usage.body.days, 14);
      assert.equal(usage.body.points.length, 14);
      assert.ok(usage.body.totals.requests >= 1);
      assert.equal(usage.body.applications[0].name, 'Storefront');

      const productPage = await browser('get', `/developer/products/${productId}`, publisher);
      assert.match(productPage.text, /data-usage-chart="requests"/);
      const appPage = await browser('get', `/developer/applications/${application.id}`, developer);
      assert.equal(appPage.status, 200);
      assert.match(appPage.text, /Calls this application made through gateways/);
    });

    it('ignores usage for products of other organizations', async () => {
      const before = await UsageRecord.count();
      const res = await linkCall(linkPort, pullBundle, '/v1/usage', {
        records: [{ minute: new Date().toISOString().slice(0, 16), productId: '00000000-0000-4000-8000-000000000000', apiId, clientId: application.clientId, requests: 5 }],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.stored, 0);
      assert.equal(await UsageRecord.count(), before);
    });

    it('runs flow tests on a pull node through the link', async () => {
      await waitFor(() => pollingNodes(pullGatewayId).includes('pull-1'), { message: 'the pull node to poll for tasks' });
      const gateway = await loadGateway({ id: pullGatewayId });
      const result = await testFlowOnGateway([gateway], {
        policy: { name: 'Pull test', flow: chain([script("module.exports = (c) => c.reply(202, { via: 'link' });")]) },
        sample: { method: 'GET', path: '/x' },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.node, 'pull-1');
      assert.equal(result.result.response.status, 202);
      assert.deepEqual(JSON.parse(result.result.response.body), { via: 'link' });
    });

    it('lists recent requests from pull nodes through the link', async () => {
      await waitFor(() => pollingNodes(pullGatewayId).includes('pull-1'), { message: 'the pull node to poll for tasks' });
      assert.equal((await callGateway(pullHandlerPort, '/orders/orders?pulled=1')).status, 200);
      // Two at once: the second waits for the node to finish the first.
      const [res, again] = await Promise.all([
        api('get', `${gatewayPath(pullGatewayId)}/requests`, publisher),
        api('get', `${gatewayPath(pullGatewayId)}/requests?status=2xx`, publisher),
      ]);
      assert.equal(res.status, 200);
      const pull = res.body.nodes.find((node) => node.name === 'pull-1');
      assert.deepEqual({ mode: pull.mode, reachable: pull.reachable }, { mode: 'pull', reachable: true }, JSON.stringify(res.body.nodes));
      const entry = res.body.entries.find((item) => item.path === '/orders/orders');
      assert.ok(entry, JSON.stringify(res.body));
      assert.equal(entry.node, 'pull-1');
      assert.ok(again.body.entries.some((item) => item.node === 'pull-1'), JSON.stringify(again.body));

      // A pull node that never connected is reported, not waited for.
      await api('post', `${gatewayPath(pullGatewayId)}/nodes`, publisher).send({ name: 'pull-2' });
      const missing = (await api('get', `${gatewayPath(pullGatewayId)}/requests`, publisher)).body.nodes.find((node) => node.name === 'pull-2');
      assert.equal(missing.reachable, false);
      assert.match(missing.error, /Not connected/);
      await GatewayNode.destroy({ where: { name: 'pull-2' } });
    });
  });

  describe('admin UI sign-in', () => {
    it('accepts org admins of the owning organization only', async () => {
      const { adminPort } = pullNode.ports;
      const ca = pullBundle.managementCa;
      const login = (email, password) => adminCall(adminPort, ca, { method: 'POST', pathname: '/api/login', body: { email, password } });

      assert.equal((await login(member.email, 'member-pass-1')).status, 401);
      assert.equal((await login(outsider.email, 'outsider-pass-1')).status, 401);
      assert.equal((await login(publisher.email, 'wrong-password')).status, 401);
      const noHeader = await adminCall(adminPort, ca, { method: 'POST', pathname: '/api/login', body: { email: publisher.email, password: 'publisher-pass-1' }, uiHeader: false });
      assert.equal(noHeader.status, 403);

      const ok = await login(publisher.email, 'publisher-pass-1');
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const cookie = ok.headers['set-cookie'][0].split(';')[0];
      assert.match(ok.headers['set-cookie'][0], /HttpOnly/);
      assert.match(ok.headers['set-cookie'][0], /Secure/);

      const overview = await adminCall(adminPort, ca, { pathname: '/api/overview', cookie });
      assert.equal(overview.status, 200);
      assert.equal(overview.body.gatewayName, 'Edge pull');
      assert.equal(overview.body.nodeName, 'pull-1');
      const requests = await adminCall(adminPort, ca, { pathname: '/api/requests', cookie });
      assert.equal(requests.status, 200);
      assert.ok(requests.body.entries.some((entry) => entry.path === '/orders/orders'));
      assert.equal((await adminCall(adminPort, ca, { pathname: '/api/overview' })).status, 401);
    });
  });

  describe('the console keeps track of push nodes', () => {
    it('checks a push node when it is added and reports one that does not answer', async () => {
      const deadPort = await freePort();
      const added = await api('post', `${gatewayPath(pushGatewayId)}/nodes`, publisher).send({ name: 'push-dead', url: `https://127.0.0.1:${deadPort}`, portOffset: 500 });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      assert.equal(added.body.check.reachable, false);
      assert.ok(added.body.check.error);
      const node = await GatewayNode.findOne({ where: { name: 'push-dead' } });
      assert.ok(node.lastError);
      assert.equal(node.lastSeenAt, null);

      const page = await browser('get', `/developer/gateways/${pushGatewayId}`, publisher);
      assert.match(page.text, /Unreachable/);
      await node.destroy();
    });

    it('sends the deployed configuration again to a node that comes back without it', async () => {
      // The node is recreated with an empty data volume: it answers, but has no configuration.
      await pushNode.node.stop();
      pushNode = await startNode(pushBundle);
      const node = await GatewayNode.findOne({ where: { gatewayId: pushGatewayId, name: 'push-1' } });
      await node.update({ url: `https://127.0.0.1:${pushNode.ports.managementPort}` });
      assert.equal(pushNode.node.status().version, null);

      const [result] = await checkGateway(await loadGateway({ id: pushGatewayId }));
      assert.deepEqual({ reachable: result.reachable, resent: result.resent }, { reachable: true, resent: true }, JSON.stringify(result));
      const gateway = await loadGateway({ id: pushGatewayId });
      assert.equal(pushNode.node.status().version, gateway.lastPushedHash.slice(0, 12));
      assert.equal((await callGateway(pushHandlerPort)).status, 200);

      // In sync now: the next check only records that the node answered.
      const [again] = await checkGateway(gateway);
      assert.deepEqual({ reachable: again.reachable, resent: again.resent }, { reachable: true, resent: false });
      assert.ok((await GatewayNode.findByPk(node.id)).lastSeenAt);
    });
  });

  describe('admin UI tickets from the console', () => {
    const ticketOf = (url) => decodeURIComponent(new URL(url).hash.replace(/^#ticket=/, ''));
    const loginWith = (ticket) => adminCall(pushNode.ports.adminPort, pushBundle.managementCa, { method: 'POST', pathname: '/api/login', body: { ticket } });
    const nodeId = async (gatewayId, name) => (await GatewayNode.findOne({ where: { gatewayId, name } })).id;

    it('signs an org admin in to a node that cannot reach the console, once', async () => {
      // This push node has no console address, so a password sign-in can't be checked.
      const password = await adminCall(pushNode.ports.adminPort, pushBundle.managementCa, { method: 'POST', pathname: '/api/login', body: { email: publisher.email, password: 'publisher-pass-1' } });
      assert.equal(password.status, 503);
      assert.match(password.body.error, /Open the admin UI from the gateway page/);

      const issued = await api('post', `${gatewayPath(pushGatewayId)}/nodes/${await nodeId(pushGatewayId, 'push-1')}/admin-ticket`, publisher);
      assert.equal(issued.status, 200, JSON.stringify(issued.body));
      assert.match(issued.body.url, /^https:\/\/127\.0\.0\.1:9445\/#ticket=/);
      const ticket = ticketOf(issued.body.url);

      const ok = await loginWith(ticket);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.user.email, publisher.email);
      const cookie = ok.headers['set-cookie'][0].split(';')[0];
      const overview = await adminCall(pushNode.ports.adminPort, pushBundle.managementCa, { pathname: '/api/overview', cookie });
      assert.equal(overview.body.gatewayName, 'Edge push');

      const reused = await loginWith(ticket);
      assert.equal(reused.status, 401);
      assert.match(reused.body.error, /already used/);
    });

    it('refuses tickets for another gateway, access tokens and people who are not org admins', async () => {
      const other = await api('post', `${gatewayPath(pullGatewayId)}/nodes/${await nodeId(pullGatewayId, 'pull-1')}/admin-ticket`, publisher);
      assert.equal(other.status, 200);
      const wrongGateway = await loginWith(ticketOf(other.body.url));
      assert.equal(wrongGateway.status, 401);
      assert.match(wrongGateway.body.error, /another gateway/);

      assert.equal((await loginWith(await tokenFor())).status, 401);
      assert.equal((await loginWith('not-a-ticket')).status, 401);

      const pushNodeId = await nodeId(pushGatewayId, 'push-1');
      assert.equal((await api('post', `${gatewayPath(pushGatewayId)}/nodes/${pushNodeId}/admin-ticket`, member)).status, 403);
      assert.equal((await api('post', `${gatewayPath(pushGatewayId)}/nodes/${pushNodeId}/admin-ticket`, outsider)).status, 404);
      assert.equal((await api('post', `${gatewayPath(pushGatewayId)}/nodes/00000000-0000-0000-0000-000000000000/admin-ticket`, publisher)).status, 404);
    });
  });

  describe('connections', () => {
    let connectionId;

    it('creates a connection and keeps its secrets write-only', async () => {
      const created = await api('post', '/api/org/connections', publisher).send({ name: 'Orders backend' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      connectionId = created.body.connection.id;
      assert.equal(created.body.connection.timeoutMs, 30000);

      const updated = await api('put', `/api/org/connections/${connectionId}`, publisher).send({
        timeoutMs: 2500,
        retries: 2,
        retryOn: '502, 503',
        circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 5000 },
        auth: { type: 'header', headerName: 'X-Api-Key', secret: 'backend-secret-123' },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      const { connection } = updated.body;
      assert.equal(connection.retries, 2);
      assert.deepEqual(connection.retryOn, [502, 503]);
      assert.equal(connection.auth.headerName, 'x-api-key');
      assert.equal(connection.auth.hasSecret, true);
      assert.doesNotMatch(JSON.stringify(updated.body), /backend-secret-123/);
      assert.doesNotMatch(JSON.stringify((await api('get', `/api/org/connections/${connectionId}`, publisher)).body), /backend-secret-123/);
    });

    it('validates input and keeps connections private to the organization', async () => {
      const bad = await api('put', `/api/org/connections/${connectionId}`, publisher).send({ retries: 9 });
      assert.equal(bad.status, 400);
      const noSecret = await api('post', '/api/org/connections', publisher).send({ name: 'x', auth: { type: 'bearer' } });
      assert.equal(noSecret.status, 400);
      const badPem = await api('put', `/api/org/connections/${connectionId}`, publisher).send({ tls: { caPem: 'not a certificate' } });
      assert.equal(badPem.status, 400);
      assert.equal((await api('get', `/api/org/connections/${connectionId}`, outsider)).status, 404);
      assert.equal((await api('get', `/api/org/connections/${connectionId}`, member)).status, 403);
      const foreign = await api('put', `/api/org/apis/${apiId}`, outsider).send({ connectionId });
      assert.equal(foreign.status, 404);
    });

    it('applies the connection to an API and redacts its secret in the preview', async () => {
      const assigned = await api('put', `/api/org/apis/${apiId}`, publisher).send({ connectionId });
      assert.equal(assigned.status, 200);
      assert.equal(assigned.body.api.connectionId, connectionId);
      assert.equal((await api('put', `/api/org/apis/${apiId}`, publisher).send({ connectionId: 'missing' })).status, 400);

      const preview = await api('get', `${gatewayPath(pushGatewayId)}/config`, publisher);
      const [connection] = preview.body.config.connections;
      assert.equal(connection.id, connectionId);
      assert.equal(connection.timeoutMs, 2500);
      assert.equal(connection.auth.type, 'header');
      assert.notEqual(connection.auth.secret, 'backend-secret-123');
      assert.doesNotMatch(JSON.stringify(preview.body), /backend-secret-123/);
      assert.equal(preview.body.config.apis[0].connectionId, connectionId);

      // Pushed to the node, the upstream receives the credential header.
      const pushed = await api('post', `${gatewayPath(pushGatewayId)}/push`, publisher);
      assert.equal(pushed.body.ok, true, JSON.stringify(pushed.body));
      upstream.requests.length = 0;
      assert.equal((await callGateway(pushHandlerPort)).status, 200);
      assert.equal(upstream.requests[0].headers['x-api-key'], 'backend-secret-123');
    });

    it('renders the connection pages', async () => {
      const list = await browser('get', '/developer/connections', publisher);
      assert.equal(list.status, 200);
      assert.match(list.text, /Orders backend/);
      const detail = await browser('get', `/developer/connections/${connectionId}`, publisher);
      assert.equal(detail.status, 200);
      assert.match(detail.text, /Saved\. Leave empty to keep it\./);
      assert.doesNotMatch(detail.text, /backend-secret-123/);
      assert.equal((await browser('get', `/developer/connections/${connectionId}`, outsider)).status, 404);
      const apiPage = await browser('get', `/developer/apis/${apiId}`, publisher);
      assert.match(apiPage.text, /id="connectionId"/);
    });

    it('detaches APIs when the connection is deleted', async () => {
      const deleted = await api('delete', `/api/org/connections/${connectionId}`, publisher);
      assert.equal(deleted.status, 200);
      assert.equal((await Api.findByPk(apiId)).connectionId, null);
    });
  });

  describe('observability settings', () => {
    it('validates and stores off-load settings without exposing the header value', async () => {
      const url = `${gatewayPath(pushGatewayId)}/observability`;
      assert.equal((await api('put', url, publisher).send({ offload: { type: 'kafka' } })).status, 400);
      assert.equal((await api('put', url, publisher).send({ offload: { type: 'otlp', url: 'not a url' } })).status, 400);
      assert.equal((await api('put', url, publisher).send({ offload: { type: 'http', url: 'https://logs.example', headerName: 'authorization' } })).status, 400);
      assert.equal((await api('put', url, publisher).send({ requestLog: { size: 5 } })).status, 400);

      const saved = await api('put', url, publisher).send({
        requestLog: { enabled: true, size: 200 },
        metrics: { enabled: true },
        offload: { type: 'otlp', url: 'https://otel.example:4318/v1/logs', headerName: 'authorization', headerValue: 'Bearer offload-token-9', batchSize: 50, flushIntervalMs: 1000, sampleRate: 0.5 },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.observability.offload.type, 'otlp');
      assert.equal(saved.body.observability.offload.hasHeaderValue, true);
      assert.equal(saved.body.observability.requestLog.size, 200);
      assert.doesNotMatch(JSON.stringify(saved.body), /offload-token-9/);

      const preview = await api('get', `${gatewayPath(pushGatewayId)}/config`, publisher);
      assert.equal(preview.body.config.observability.offload.url, 'https://otel.example:4318/v1/logs');
      assert.doesNotMatch(JSON.stringify(preview.body), /offload-token-9/);

      // Keeping the saved value works without sending it again; turning off-load off is always allowed.
      assert.equal((await api('put', url, publisher).send({ offload: { type: 'http', url: 'https://logs.example', headerName: 'authorization' } })).status, 200);
      assert.equal((await api('put', url, publisher).send({ offload: { type: 'none' } })).status, 200);
      assert.equal((await api('put', url, member).send({ offload: { type: 'none' } })).status, 403);
    });
  });

  describe('port policies', () => {
    it('assigns a policy to a handler and runs it for every request on the port', async () => {
      const policy = await api('post', '/api/org/policies', publisher).send({
        name: 'Port tag',
        flow: chain([script("module.exports = async (callcontext) => { callcontext.headers['x-port-policy'] = 'yes'; };")]),
      });
      const gateway = await api('get', gatewayPath(pushGatewayId), publisher);
      const [handler] = gateway.body.gateway.handlers;
      const updated = await api('put', `${gatewayPath(pushGatewayId)}/handlers/${handler.id}`, publisher).send({ policyId: policy.body.policy.id });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.handler.policy.name, 'Port tag');
      const foreign = await api('post', '/api/org/policies', outsider).send({ name: 'Foreign' });
      assert.equal((await api('put', `${gatewayPath(pushGatewayId)}/handlers/${handler.id}`, publisher).send({ policyId: foreign.body.policy.id })).status, 400);

      const pushed = await api('post', `${gatewayPath(pushGatewayId)}/push`, publisher);
      assert.equal(pushed.body.ok, true, JSON.stringify(pushed.body));
      upstream.requests.length = 0;
      assert.equal((await callGateway(pushHandlerPort)).status, 200);
      assert.equal(upstream.requests[0].headers['x-port-policy'], 'yes');
    });
  });

  describe('policy tests and live requests', () => {
    const run = (body, user = publisher) => api('post', '/api/org/policies/test', user).send(body);

    it('runs an unsaved flow on a gateway node and reports every step', async () => {
      const res = await run({
        name: 'Draft',
        apiId,
        flow: chain([
          script(`module.exports = async (callcontext) => {
  callcontext.headers['x-signed'] = await hash.sha256('abc');
  callcontext.path = '/v2' + callcontext.path;
  callcontext.query.page = '2';
  console.log('hello from the test');
};`),
          backend(),
        ]),
        sample: { method: 'POST', path: '/orders', query: '{"debug":"true"}', headers: '{"X-Tenant":"acme"}', body: '{"a":1}' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true);
      assert.equal(res.body.gateway, 'Edge push');
      const { result } = res.body;
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.steps.map((step) => step.type), ['input', 'script', 'invoke', 'output']);
      assert.ok(result.steps[1].logs.some(([, message]) => message.includes('hello from the test')));
      // The Invoke step called the API's backend with the script's changes.
      const sent = upstream.requests.at(-1);
      assert.equal(sent.url, '/v1/v2/orders?debug=true&page=2');
      assert.equal(sent.headers['x-tenant'], 'acme');
      assert.equal(sent.headers['x-signed'], 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      assert.equal(result.response.status, 200);
      assert.match(result.request.sent.url, /\/v1\/v2\/orders\?debug=true&page=2$/);
    });

    it("checks samples against the chosen API's OpenAPI operation in Validate steps", async () => {
      const spec = {
        openapi: '3.0.3',
        info: { title: 'Inventory API', version: '1.0.0' },
        paths: {
          '/items': {
            post: {
              parameters: [{ in: 'query', name: 'dryRun', schema: { type: 'boolean' } }],
              requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
              responses: { 201: { description: 'Created' } },
            },
          },
        },
        components: { schemas: { Item: { type: 'object', required: ['sku'], properties: { sku: { type: 'string', minLength: 3 } } } } },
      };
      const catalogs = await api('get', '/api/org/catalogs', publisher);
      const imported = await api('post', '/api/org/apis/import', publisher).send({ content: JSON.stringify(spec), catalogId: catalogs.body.catalogs[0].id });
      assert.equal(imported.status, 201, JSON.stringify(imported.body));
      const flow = chain([{ type: 'validateRequest', name: 'Validate request' }, { type: 'validateBody', name: 'Validate body' }]);

      const invalid = await run({ apiId: imported.body.api.id, flow, sample: { method: 'POST', path: '/items', query: '{"dryRun":"maybe"}', headers: '{"content-type":"application/json"}', body: '{"sku":"x"}' } });
      assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
      assert.equal(invalid.body.result.response.status, 422);
      assert.deepEqual(invalid.body.result.steps[1].problems, [{ in: 'query', name: 'dryRun', message: 'must be a boolean, not a string' }]);

      const badBody = await run({ apiId: imported.body.api.id, flow, sample: { method: 'POST', path: '/items', headers: '{"content-type":"application/json"}', body: '{"sku":"x"}' } });
      assert.deepEqual(badBody.body.result.steps[2].problems, [{ path: '/sku', message: 'must be at least 3 characters long' }]);

      const valid = await run({ apiId: imported.body.api.id, flow, sample: { method: 'POST', path: '/items', headers: '{"content-type":"application/json"}', body: '{"sku":"abc"}' } });
      assert.equal(valid.body.result.response.status, 200);
      assert.equal(valid.body.result.response.echoed, true);
    });

    it('sends operation definitions to the gateway only when a flow validates against them', async () => {
      const apiRecord = await Api.findByPk(apiId);
      const before = await api('get', `${gatewayPath(pushGatewayId)}/config`, publisher);
      assert.ok(before.body.config.apis[0].operations.every((operation) => operation.contract === undefined));

      const validating = chain([{ type: 'validateRequest', name: 'Validate request' }, backend()]);
      assert.equal((await api('put', `/api/org/policies/${apiRecord.policyId}`, publisher).send({ flow: validating })).status, 200);
      try {
        const after = await api('get', `${gatewayPath(pushGatewayId)}/config`, publisher);
        const operations = after.body.config.apis[0].operations;
        assert.deepEqual(operations.map((operation) => operation.contract), [{ parameters: [], body: null }, { parameters: [], body: null }]);
        const pushed = await api('post', `${gatewayPath(pushGatewayId)}/push`, publisher);
        assert.equal(pushed.body.ok, true, JSON.stringify(pushed.body));
        assert.equal((await callGateway(pushHandlerPort)).status, 200);
      } finally {
        await api('put', `/api/org/policies/${apiRecord.policyId}`, publisher).send({ flow: chain([backend()]) });
        await api('post', `${gatewayPath(pushGatewayId)}/push`, publisher);
      }
    });

    it('reports failing steps and refuses broken flows', async () => {
      const thrown = await run({ flow: chain([script("module.exports = async () => { throw new Error('boom'); };")]) });
      assert.equal(thrown.status, 200, JSON.stringify(thrown.body));
      assert.equal(thrown.body.result.ok, false);
      assert.match(thrown.body.result.error, /boom/);
      assert.equal(thrown.body.result.steps.at(-1).error, thrown.body.result.error);

      const echoed = await run({ flow: chain([]), sample: { method: 'POST', body: 'same' } });
      assert.equal(echoed.body.result.response.body, 'same');
      assert.equal(echoed.body.result.response.echoed, true);

      assert.equal((await run({ flow: chain([script('module.exports = ;')]) })).status, 400);
      assert.equal((await run({ flow: { nodes: [] } })).status, 400);
      assert.equal((await run({ flow: chain([]), sample: { headers: '[1]' } })).status, 400);
      assert.equal((await run({ flow: chain([]), apiId: 'not-ours' })).status, 400);
      assert.equal((await run({ flow: chain([]) }, member)).status, 403);
    });

    it('tells organizations without a reachable node why the test cannot run', async () => {
      const res = await run({ flow: chain([]) }, outsider);
      assert.equal(res.status, 409);
      assert.match(res.body.error, /Start a node/);
    });

    it('lists recent requests from push nodes', async () => {
      await callGateway(pushHandlerPort, '/orders/orders?x=1');
      const res = await api('get', `${gatewayPath(pushGatewayId)}/requests?status=2xx`, publisher);
      assert.equal(res.status, 200);
      assert.equal(res.body.nodes[0].reachable, true);
      const entry = res.body.entries.find((item) => item.path === '/orders/orders');
      assert.ok(entry, JSON.stringify(res.body));
      assert.equal(entry.node, 'push-1');
      assert.equal(entry.application, 'Storefront');
      assert.match(entry.traceId, /^[0-9a-f]{32}$/);
      assert.equal(entry.headers, undefined);

      const page = await browser('get', `/developer/gateways/${pushGatewayId}/requests`, publisher);
      assert.equal(page.status, 200);
      assert.match(page.text, /Live requests/);
      assert.equal((await browser('get', `/developer/gateways/${pushGatewayId}/requests`, outsider)).status, 404);
    });
  });

  describe('auto-push', () => {
    it('pushes shortly after a change when the gateway has auto-push on', async () => {
      process.env.GATEWAY_AUTO_PUSH_DELAY_MS = '50';
      setAutoPushEnabled(true);
      try {
        const on = await api('put', gatewayPath(pushGatewayId), publisher).send({ autoPush: true });
        assert.equal(on.body.gateway.autoPush, true);
        await api('put', `/api/org/products/${productId}`, publisher).send({ description: 'Changed for auto-push' });
        const preview = await api('get', `${gatewayPath(pushGatewayId)}/config`, publisher);
        await waitFor(async () => {
          const node = await GatewayNode.findOne({ where: { gatewayId: pushGatewayId, name: 'push-1' } });
          return node.configVersion === preview.body.config.version;
        }, { message: 'the auto-push to reach the node' });
      } finally {
        setAutoPushEnabled(false);
        delete process.env.GATEWAY_AUTO_PUSH_DELAY_MS;
      }
    });
  });

  describe('certificate lifecycle', () => {
    it('warns about expiring certificates on the dashboard and gateway page', async () => {
      const credential = await GatewayCredential.findOne({ where: { gatewayId: pushGatewayId }, order: [['createdAt', 'DESC']] });
      const realValidTo = credential.validTo;
      await credential.update({ validTo: new Date(Date.now() + 5 * 86400000) });
      try {
        const dashboard = await browser('get', '/developer/dashboard', publisher);
        assert.match(dashboard.text, /Gateway certificates need attention/);
        assert.match(dashboard.text, /Edge push/);
        const page = await browser('get', `/developer/gateways/${pushGatewayId}`, publisher);
        assert.match(page.text, /expires in [45] days/);
        assert.doesNotMatch((await browser('get', '/developer/dashboard', member)).text, /Gateway certificates need attention/);
      } finally {
        await credential.update({ validTo: realValidTo });
      }
    });

    it('renews credentials on running nodes without a restart', async () => {
      const original = await GatewayCredential.findOne({ where: { gatewayId: pushGatewayId } });
      const renewed = await api('post', `${gatewayPath(pushGatewayId)}/renew`, publisher);
      assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
      assert.equal(renewed.body.credential.source, 'renewal');
      assert.notEqual(renewed.body.credential.fingerprint, original.fingerprint);
      assert.equal(renewed.body.nodes[0].status, 'ok', JSON.stringify(renewed.body.nodes));

      // The old certificate can be revoked; the node keeps working with the new one.
      const revoke = await api('post', `${gatewayPath(pushGatewayId)}/credentials/${original.id}/revoke`, publisher).send({ force: true });
      assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
      assert.ok(revoke.body.credential.revokedAt);
      assert.equal((await api('post', `${gatewayPath(pushGatewayId)}/credentials/${original.id}/revoke`, publisher).send({ force: true })).status, 409);
      const status = await api('get', `${gatewayPath(pushGatewayId)}/status`, publisher);
      assert.equal(status.body.nodes[0].reachable, true, JSON.stringify(status.body));
    });

    it('cuts off nodes whose certificate is revoked', async () => {
      const credential = await GatewayCredential.findOne({ where: { gatewayId: pullGatewayId } });
      const refused = await api('post', `${gatewayPath(pullGatewayId)}/credentials/${credential.id}/revoke`, publisher).send({});
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.body.usedBy, ['pull-1']);

      const revoked = await api('post', `${gatewayPath(pullGatewayId)}/credentials/${credential.id}/revoke`, publisher).send({ force: true });
      assert.equal(revoked.status, 200);
      const heartbeat = await linkCall(linkPort, pullBundle, '/v1/heartbeat', { nodeName: 'pull-1' });
      assert.equal(heartbeat.status, 403);
      assert.match(heartbeat.body.error, /revoked/);
      assert.equal((await api('post', `${gatewayPath(pullGatewayId)}/credentials/${credential.id}/revoke`, outsider).send({ force: true })).status, 404);
    });
  });
});
