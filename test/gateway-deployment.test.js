// End to end: management issues credentials, a real gateway runs in-process, management pushes
// a catalog over mTLS, and an approved application calls an API through the gateway's policy.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  app,
  request,
  models,
  resetDatabase,
  createUser,
  api,
  browser,
} = require('./helpers');
const { createGateway } = require('../gateway/src/gateway');
const { createLogger } = require('../gateway/src/logger');

const { GatewayNode, Subscription } = models;

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

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
  paths: {
    '/orders': { get: { summary: 'List orders' }, post: { summary: 'Create order' } },
    '/orders/{id}': { get: { summary: 'Get order' } },
  },
});

const POLICY_CODE = `module.exports = async function (callcontext) {
  callcontext.headers['x-tenant'] = callcontext.consumer.application;
  if (callcontext.original.body) {
    callcontext.body = { ...JSON.parse(callcontext.original.body), via: 'gateway' };
  }
};`;

// Input -> Gateway script -> Invoke the API's backend -> Output.
const scriptThenBackend = (code) => ({
  nodes: [
    { id: 'input', type: 'input', x: 40, y: 160 },
    { id: 'tenant', type: 'script', name: 'Tenant header', x: 300, y: 160, config: { code } },
    { id: 'backend', type: 'invoke', name: 'Call the backend', x: 560, y: 160, config: { target: 'backend', appendPath: true } },
    { id: 'output', type: 'output', x: 820, y: 160 },
  ],
  edges: [
    { from: 'input', to: 'tenant' },
    { from: 'tenant', to: 'backend' },
    { from: 'backend', to: 'output' },
  ],
});

const startGatewayNode = async (credentials, dataDir) => {
  const node = createGateway({
    credentials,
    managementHost: '127.0.0.1',
    managementPort: 0,
    healthHost: '127.0.0.1',
    healthPort: 0,
    adminHost: '127.0.0.1',
    adminPort: 0,
    bindHost: '127.0.0.1',
    dataDir,
    policyWorkers: 1,
    logger: createLogger('silent'),
  });
  const ports = await node.start();
  return { node, ports };
};

describe('gateway deployment', () => {
  let publisher;
  let developer;
  let upstream;
  let apiId;
  let productId;
  let policyId;
  let catalogId;
  let gatewayId;
  let subscriptionId;
  let application;
  let handlerPort;
  let gatewayNode;
  let dataDir;
  const extraNodes = [];

  const gatewayUrl = () => `/api/org/gateways/${gatewayId}`;
  const push = () => api('post', `${gatewayUrl()}/push`, publisher);
  const getToken = (clientId = application.clientId, secret = application.clientSecret) => request(app)
    .post('/oauth/token')
    .auth(clientId, secret)
    .type('form')
    .send({ grant_type: 'client_credentials' });
  const callGateway = (pathname, { token, method = 'GET', body } = {}) => fetch(`http://127.0.0.1:${handlerPort}${pathname}`, {
    method,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });

  before(async () => {
    await resetDatabase();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgmt-gateway-'));
    upstream = await startUpstream();
    handlerPort = await freePort();

    publisher = await createUser({ name: 'Publisher' });
    // A member invited into the publishing organization
    developer = await createUser({ name: 'Developer', organization: { id: publisher.organizationId } });

    // A catalog with an API in a published product; the API's own policy adds a header and calls the backend.
    const catalog = await api('post', '/api/org/catalogs', publisher).send({ name: 'Public APIs' });
    catalogId = catalog.body.catalog.id;
    const imported = await api('post', '/api/org/apis/import', publisher).send({ content: openapi(upstream.url), catalogId });
    apiId = imported.body.api.id;
    policyId = imported.body.api.policyId;
    await api('put', `/api/org/policies/${policyId}`, publisher).send({ flow: scriptThenBackend(POLICY_CODE) });
    const product = await api('post', '/api/org/products', publisher).send({ name: 'Orders Starter', catalogId });
    productId = product.body.product.id;
    await api('post', `/api/org/products/${productId}/apis`, publisher).send({ apiId });
    await api('put', `/api/org/products/${productId}`, publisher).send({ status: 'published' });

    // The member's application, approved for the product
    const created = await api('post', '/api/applications', developer).send({ name: 'Storefront', redirectUris: ['https://shop.test/cb'] });
    application = created.body.application;
    const requested = await api('post', `/api/applications/${application.id}/subscriptions`, developer).send({ productId });
    subscriptionId = requested.body.subscription.id;
    await api('put', `/api/org/subscriptions/${subscriptionId}`, publisher).send({ status: 'approved' });

    // A gateway is created on its own, started, and then attached to the catalog
    const gateway = await api('post', '/api/org/gateways', publisher).send({ name: 'Edge', publicUrl: `http://127.0.0.1:${handlerPort}` });
    gatewayId = gateway.body.gateway.id;
    await api('post', `${gatewayUrl()}/handlers`, publisher).send({ name: 'Public HTTP', port: handlerPort, protocol: 'http' });

    // Credentials downloaded from management start a real gateway node
    const credentials = await api('get', `${gatewayUrl()}/credentials`, publisher);
    assert.equal(credentials.status, 200);
    assert.match(credentials.headers['content-disposition'], /attachment; filename="edge-credentials.json"/);
    gatewayNode = await startGatewayNode(JSON.parse(credentials.text), dataDir);
    await api('post', `${gatewayUrl()}/nodes`, publisher).send({ name: 'node-1', url: `https://127.0.0.1:${gatewayNode.ports.managementPort}` });
    const attached = await api('put', gatewayUrl(), publisher).send({ catalogId });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
  });

  after(async () => {
    await gatewayNode?.node.stop();
    await Promise.all(extraNodes.map((node) => node.stop()));
    await upstream.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives each API a base path and shows the gateway as not deployed', async () => {
    const apiRes = await api('get', `/api/org/apis/${apiId}`, publisher);
    const gatewayRes = await api('get', gatewayUrl(), publisher);

    assert.equal(apiRes.body.api.basePath, '/orders-api');
    assert.equal(gatewayRes.body.gateway.state, 'not_deployed');
    assert.deepEqual(gatewayRes.body.gateway.problems, []);
    assert.deepEqual(gatewayRes.body.gateway.summary, { products: 1, apis: 1, subscriptions: 1, handlers: 1 });
  });

  it('pushes the catalog to the node over mTLS', async () => {
    const res = await push();

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.nodes[0].status, 'ok');
    assert.deepEqual(res.body.nodes[0].handlers.map((handler) => handler.listening), [true]);
    assert.equal(gatewayNode.node.status().version, res.body.version);

    const after = await api('get', gatewayUrl(), publisher);
    assert.equal(after.body.gateway.state, 'deployed');
  });

  it('issues client-credentials tokens and rejects bad secrets', async () => {
    const good = await getToken();
    const bad = await getToken(application.clientId, 'wrong-secret');
    const noGrant = await request(app).post('/oauth/token').auth(application.clientId, application.clientSecret).type('form').send({});

    assert.equal(good.status, 200);
    assert.equal(good.body.token_type, 'Bearer');
    assert.equal(good.body.expires_in, 600);
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'invalid_client');
    assert.equal(noGrant.status, 400);
  });

  it('publishes the token signing key as JWKS', async () => {
    const res = await request(app).get('/.well-known/jwks.json');

    assert.equal(res.status, 200);
    assert.equal(res.body.keys[0].kty, 'RSA');
    assert.equal(res.body.keys[0].alg, 'RS256');
  });

  it('routes an approved call through the policy to the upstream', async () => {
    const { body } = await getToken();
    const res = await callGateway('/orders-api/orders', { token: body.access_token, method: 'POST', body: { item: 'book' } });

    assert.equal(res.status, 200);
    const received = upstream.requests.at(-1);
    assert.equal(received.url, '/v1/orders');
    assert.equal(received.headers['x-tenant'], 'Storefront');
    assert.equal(received.headers['x-gateway-client-id'], application.clientId);
    assert.equal(received.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(received.body), { item: 'book', via: 'gateway' });
  });

  it("answers with the request itself while the API's policy has no Invoke step", async () => {
    const own = await api('get', `/api/org/policies/${policyId}`, publisher);
    await api('put', `/api/org/policies/${policyId}`, publisher).send({ flow: { nodes: [{ id: 'input', type: 'input' }, { id: 'output', type: 'output' }], edges: [{ from: 'input', to: 'output' }] } });
    await push();
    const before = upstream.requests.length;
    const { body } = await getToken();
    const res = await callGateway('/orders-api/orders', { token: body.access_token, method: 'POST', body: { item: 'echo' } });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { item: 'echo' });
    assert.equal(upstream.requests.length, before);

    await api('put', `/api/org/policies/${policyId}`, publisher).send({ flow: own.body.policy.flow });
    await push();
  });

  it('marks changes as not deployed until the next push, then applies them', async () => {
    await api('put', `/api/org/products/${productId}`, publisher).send({ rateLimitEnabled: true, rateLimitRequests: 2, rateLimitPeriod: 'minute' });
    const before = await api('get', gatewayUrl(), publisher);
    assert.equal(before.body.gateway.state, 'outdated');

    await push();
    const { body } = await getToken();
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await callGateway('/orders-api/orders/1', { token: body.access_token })).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  });

  it('stops serving an application after its access is revoked and pushed', async () => {
    await api('put', `/api/org/subscriptions/${subscriptionId}`, publisher).send({ status: 'revoked' });
    await push();
    const { body } = await getToken();

    const res = await callGateway('/orders-api/orders/1', { token: body.access_token });
    assert.equal(res.status, 403);
  });

  it('attaches only running gateways to a catalog', async () => {
    const withCatalog = await api('post', '/api/org/gateways', publisher).send({ name: 'Eager', publicUrl: 'https://eager.test', catalogId });
    assert.equal(withCatalog.status, 409);
    assert.match(withCatalog.body.error, /start a node first/i);

    const idle = await api('post', '/api/org/gateways', publisher).send({ name: 'Idle', publicUrl: 'https://idle.test' });
    assert.equal(idle.status, 201);
    assert.equal(idle.body.gateway.catalog, null);
    const attach = await api('put', `/api/org/gateways/${idle.body.gateway.id}`, publisher).send({ catalogId });
    assert.equal(attach.status, 409);
    assert.match(attach.body.error, /not running/);

    // Detaching is always possible.
    const detach = await api('put', `/api/org/gateways/${idle.body.gateway.id}`, publisher).send({ catalogId: null });
    assert.equal(detach.status, 200);
    await api('delete', `/api/org/gateways/${idle.body.gateway.id}`, publisher);
  });

  it('refuses a node that presents another gateway\'s certificate', async () => {
    const other = await api('post', '/api/org/gateways', publisher).send({ name: 'Other', publicUrl: 'https://other.test' });
    const otherCredentials = await api('get', `/api/org/gateways/${other.body.gateway.id}/credentials`, publisher);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgmt-gateway-other-'));
    const impostor = await startGatewayNode(JSON.parse(otherCredentials.text), otherDir);
    extraNodes.push(impostor.node);

    await api('post', `${gatewayUrl()}/nodes`, publisher).send({ name: 'impostor', url: `https://127.0.0.1:${impostor.ports.managementPort}` });
    const res = await push();

    assert.equal(res.body.ok, false);
    const failed = res.body.nodes.find((node) => node.name === 'impostor');
    assert.equal(failed.status, 'error');
    assert.match(failed.error, new RegExp(`gateway:${other.body.gateway.id}`));
    await GatewayNode.destroy({ where: { name: 'impostor' } });
  });

  it('reports nodes that cannot be reached', async () => {
    const closedPort = await freePort();
    await api('post', `${gatewayUrl()}/nodes`, publisher).send({ name: 'offline', url: `https://127.0.0.1:${closedPort}` });
    const res = await push();

    const offline = res.body.nodes.find((node) => node.name === 'offline');
    assert.equal(offline.status, 'error');
    assert.match(offline.error, /Connection refused/);
    await GatewayNode.destroy({ where: { name: 'offline' } });
  });

  it('reads node status over mTLS', async () => {
    const res = await api('get', `${gatewayUrl()}/status`, publisher);

    assert.equal(res.status, 200);
    assert.equal(res.body.nodes[0].reachable, true);
    assert.ok(res.body.nodes[0].status.stats.requests > 0);
  });

  it('pushes a whole catalog to its gateways', async () => {
    await Subscription.update({ status: 'approved' }, { where: { id: subscriptionId } });
    const res = await api('post', `/api/org/catalogs/${catalogId}/push`, publisher);

    assert.equal(res.status, 200);
    const edge = res.body.results.find((result) => result.gateway.id === gatewayId);
    assert.equal(edge.ok, true);
  });

  it('lists problems instead of pushing an incomplete gateway', async () => {
    const empty = await api('post', '/api/org/gateways', publisher).send({ name: 'Empty', publicUrl: 'https://empty.test' });
    const res = await api('post', `/api/org/gateways/${empty.body.gateway.id}/push`, publisher);

    assert.equal(res.body.ok, false);
    // Without a catalog a gateway still runs: only ports and nodes are required.
    assert.ok(!res.body.problems.some((problem) => /catalog/i.test(problem)));
    assert.ok(res.body.problems.some((problem) => /connection handler/.test(problem)));
    assert.ok(res.body.problems.some((problem) => /at least one node/.test(problem)));
  });

  it('rejects policies with syntax errors and duplicate base paths', async () => {
    const badPolicy = await api('put', `/api/org/policies/${policyId}`, publisher).send({ flow: scriptThenBackend('module.exports = (') });
    const second = await api('post', '/api/org/apis', publisher).send({ name: 'Orders API', version: '2', catalogId });
    const duplicate = await api('put', `/api/org/apis/${second.body.api.id}`, publisher).send({ basePath: '/orders-api' });

    assert.equal(badPolicy.status, 400);
    assert.match(badPolicy.body.error, /syntax error/);
    assert.equal(second.body.api.basePath, '/orders-api-2');
    assert.equal(duplicate.status, 409);
  });

  it('validates node addresses and handler ports', async () => {
    const plainNode = await api('post', `${gatewayUrl()}/nodes`, publisher).send({ name: 'x', url: 'http://10.0.0.1:9443' });
    const badPort = await api('post', `${gatewayUrl()}/handlers`, publisher).send({ name: 'x', port: 70000 });
    const takenPort = await api('post', `${gatewayUrl()}/handlers`, publisher).send({ name: 'x', port: handlerPort });
    const https = await api('post', `${gatewayUrl()}/handlers`, publisher).send({ name: 'TLS', port: await freePort(), protocol: 'https' });

    assert.equal(plainNode.status, 400);
    assert.equal(badPort.status, 400);
    assert.equal(takenPort.status, 409);
    assert.equal(https.status, 201);
    assert.equal(https.body.handler.tlsMode, 'generated');
    assert.match(https.body.handler.certificate.subjectAltName, /IP Address:127\.0\.0\.1/);
  });

  it('never shows handler private keys in the configuration preview', async () => {
    const res = await api('get', `${gatewayUrl()}/config`, publisher);

    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.body).includes('BEGIN PRIVATE KEY'));
  });

  it('keeps gateways private to their organization', async () => {
    const outsider = await createUser();
    const read = await api('get', gatewayUrl(), outsider);
    const credentials = await api('get', `${gatewayUrl()}/credentials`, outsider);
    const pushed = await api('post', `${gatewayUrl()}/push`, outsider);
    const member = await createUser({ organization: { id: publisher.organizationId } });
    const memberRead = await api('get', '/api/org/gateways', member);

    assert.equal(read.status, 404);
    assert.equal(credentials.status, 404);
    assert.equal(pushed.status, 404);
    assert.equal(memberRead.status, 403);
  });

  it('renders the gateway, catalog and policy pages', async () => {
    const pages = await Promise.all([
      browser('get', '/developer/gateways', publisher),
      browser('get', gatewayUrl().replace('/api/org', '/developer'), publisher),
      browser('get', `/developer/catalogs/${catalogId}`, publisher),
      browser('get', '/developer/policies', publisher),
      browser('get', `/developer/policies/${policyId}`, publisher),
      browser('get', `/developer/apis/${apiId}`, publisher),
      browser('get', `/developer/catalog/${productId}`, developer),
    ]);

    pages.forEach((page) => assert.equal(page.status, 200, page.req.path));
    assert.ok(pages[0].text.includes('Edge'));
    assert.ok(pages[1].text.includes('docker run'));
    assert.ok(pages[2].text.includes('Orders Starter'));
    assert.ok(pages[4].text.includes('callcontext.consumer.application'));
    assert.ok(pages[5].text.includes('/orders-api'));
    assert.ok(pages[6].text.includes(`http://127.0.0.1:${handlerPort}`));
    assert.ok(pages[6].text.includes('grant_type=client_credentials'));
  });
});
