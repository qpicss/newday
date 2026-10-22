const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGateway } = require('../src/gateway');
const {
  createPki,
  credentialsFor,
  freePort,
  managementRequest,
  startUpstream,
  tokenFor,
  buildConfig,
  silentLogger,
} = require('./support');

const POLICY = `module.exports = async function (callcontext) {
  callcontext.headers['x-tenant'] = 'acme';
  callcontext.headers['x-original-method'] = callcontext.original.method;
  if (callcontext.original.body) {
    const body = JSON.parse(callcontext.original.body);
    callcontext.body = { ...body, enrichedBy: callcontext.consumer.clientId };
  }
  if (callcontext.original.query.block === 'yes') {
    callcontext.reply(451, { error: 'blocked by policy' });
  }
};`;

describe('gateway end to end', () => {
  let pki;
  let gateway;
  let upstream;
  let ports;
  let handlerPort;
  let dataDir;

  const push = (config, client = pki.management) => managementRequest({
    port: ports.managementPort, method: 'PUT', path: '/v1/config', body: config, client, pki,
  });
  const call = (pathname, { token, method = 'GET', body, headers = {} } = {}) => fetch(`http://127.0.0.1:${handlerPort}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  before(async () => {
    pki = createPki();
    upstream = await startUpstream();
    handlerPort = await freePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
    gateway = createGateway({
      credentials: credentialsFor(pki),
      managementHost: '127.0.0.1',
      managementPort: 0,
      healthHost: '127.0.0.1',
      healthPort: 0,
      bindHost: '127.0.0.1',
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      logger: silentLogger(),
    });
    ports = await gateway.start();
  });

  after(async () => {
    await gateway.stop();
    await upstream.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('is not ready before the first configuration', async () => {
    const ready = await fetch(`http://127.0.0.1:${ports.healthPort}/readyz`);
    assert.equal(ready.status, 503);
  });

  it('rejects management calls without the management certificate', async () => {
    const res = await managementRequest({ port: ports.managementPort, path: '/v1/status', client: pki.impostor, pki });
    assert.equal(res.status, 403);
  });

  it('rejects clients whose certificate was not issued by the management CA', async () => {
    const stranger = createPki(pki.gatewayId);
    await assert.rejects(managementRequest({ port: ports.managementPort, path: '/v1/status', client: stranger.management, pki }));
  });

  it('rejects a configuration built for another gateway', async () => {
    const other = createPki();
    const res = await push(buildConfig(other, { handlerPort, upstreamUrl: upstream.url }));
    assert.equal(res.status, 400);
    assert.match(res.body.message, /different gateway/);
  });

  it('applies a pushed configuration and opens the handler port', async () => {
    const res = await push(buildConfig(pki, { handlerPort, upstreamUrl: upstream.url, policy: { id: 'p1', name: 'Enrich', code: POLICY } }));

    assert.equal(res.status, 200);
    assert.equal(res.body.version, 'v1');
    assert.deepEqual(res.body.handlers, [{ name: 'Public HTTP', port: handlerPort, protocol: 'http', listening: true, error: null }]);

    const ready = await fetch(`http://127.0.0.1:${ports.healthPort}/readyz`);
    assert.equal(ready.status, 200);
  });

  it('proxies through the policy using callcontext.headers and callcontext.body', async () => {
    const res = await call('/acme/orders/orders?expand=items', {
      token: tokenFor(pki), method: 'POST', body: { item: 'book' }, headers: { 'x-custom': 'kept' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-upstream'), 'yes');
    assert.ok(res.headers.get('x-request-id'));

    const received = upstream.requests.at(-1);
    assert.equal(received.url, '/backend/orders?expand=items');
    assert.equal(received.headers['x-tenant'], 'acme');
    assert.equal(received.headers['x-original-method'], 'POST');
    assert.equal(received.headers['x-custom'], 'kept');
    assert.equal(received.headers['x-gateway-client-id'], 'client-1');
    assert.equal(received.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(received.body), { item: 'book', enrichedBy: 'client-1' });
    assert.equal(Number(received.headers['content-length']), Buffer.byteLength(received.body));
  });

  it('lets the policy answer without calling the upstream', async () => {
    const before = upstream.requests.length;
    const res = await call('/acme/orders/orders?block=yes', { token: tokenFor(pki) });

    assert.equal(res.status, 451);
    assert.deepEqual(await res.json(), { error: 'blocked by policy' });
    assert.equal(upstream.requests.length, before);
  });

  it('requires a valid token from the management signing key', async () => {
    const missing = await call('/acme/orders/orders');
    const forged = await call('/acme/orders/orders', { token: tokenFor(pki, { key: { ...createPki().tokenKey, kid: pki.tokenKey.kid } }) });
    const expired = await call('/acme/orders/orders', { token: tokenFor(pki, { expiresIn: -10 }) });
    const wrongAudience = await call('/acme/orders/orders', { token: tokenFor(pki, { audience: 'something-else' }) });

    assert.equal(missing.status, 401);
    assert.equal(forged.status, 401);
    assert.equal(expired.status, 401);
    assert.equal(wrongAudience.status, 401);
  });

  it('requires an approved subscription', async () => {
    const res = await call('/acme/orders/orders', { token: tokenFor(pki, { clientId: 'not-subscribed' }) });
    assert.equal(res.status, 403);
  });

  it('only serves operations declared in the OpenAPI document', async () => {
    const unknown = await call('/acme/orders/customers', { token: tokenFor(pki) });
    const wrongMethod = await call('/acme/orders/orders/1', { token: tokenFor(pki), method: 'DELETE' });

    assert.equal(unknown.status, 404);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
  });

  it('enforces the product rate limit, split across cluster nodes', async () => {
    // 4 requests per minute shared by 2 nodes leaves 2 for this node.
    await push(buildConfig(pki, { handlerPort, upstreamUrl: upstream.url, version: 'v2', nodeCount: 2, rateLimit: { enabled: true, requests: 4, period: 'minute' } }));
    const token = tokenFor(pki);

    const first = await call('/acme/orders/orders/1', { token });
    const second = await call('/acme/orders/orders/1', { token });
    const third = await call('/acme/orders/orders/1', { token });

    assert.equal(first.status, 200);
    assert.equal(first.headers.get('ratelimit-limit'), '2');
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
  });

  it('reports status to management', async () => {
    const res = await managementRequest({ port: ports.managementPort, path: '/v1/status', client: pki.management, pki });

    assert.equal(res.status, 200);
    assert.equal(res.body.version, 'v2');
    assert.equal(res.body.gatewayId, pki.gatewayId);
    assert.ok(res.body.stats.requests > 0);
  });

  it('moves the handler to a new port without a restart', async () => {
    const newPort = await freePort();
    const res = await push(buildConfig(pki, { handlerPort: newPort, upstreamUrl: upstream.url, version: 'v3' }));
    assert.equal(res.status, 200);

    const moved = await fetch(`http://127.0.0.1:${newPort}/acme/orders/orders/1`, { headers: { authorization: `Bearer ${tokenFor(pki)}` } });
    assert.equal(moved.status, 200);
    await assert.rejects(fetch(`http://127.0.0.1:${handlerPort}/acme/orders/orders/1`));
    handlerPort = newPort;
  });

  it('keeps the last good configuration when a push is invalid', async () => {
    const broken = buildConfig(pki, { handlerPort, upstreamUrl: upstream.url, version: 'v4', policy: { name: 'Broken', code: 'module.exports = (' } });
    const res = await push(broken);

    assert.equal(res.status, 400);
    assert.match(res.body.message, /syntax error/);
    const stillWorking = await call('/acme/orders/orders/1', { token: tokenFor(pki) });
    assert.equal(stillWorking.status, 200);
  });

  it('restarts with the saved configuration', async () => {
    await gateway.stop();
    gateway = createGateway({
      credentials: credentialsFor(pki),
      managementHost: '127.0.0.1',
      managementPort: 0,
      healthHost: '127.0.0.1',
      healthPort: 0,
      bindHost: '127.0.0.1',
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      logger: silentLogger(),
    });
    ports = await gateway.start();

    assert.equal(gateway.status().version, 'v3');
    const res = await call('/acme/orders/orders/1', { token: tokenFor(pki) });
    assert.equal(res.status, 200);
  });
});
