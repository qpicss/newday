// Public APIs (no token), {name+} paths and a handler's home redirect: a website served
// through the gateway next to a subscription API on the same port.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGateway } = require('../src/gateway');
const { compileRoutes, matchRoute } = require('../src/routes');
const {
  createPki,
  credentialsFor,
  freePort,
  managementRequest,
  startUpstream,
  tokenFor,
  buildConfig,
  proxyPolicy,
  silentLogger,
} = require('./support');

describe('route templates', () => {
  const routes = compileRoutes([{
    id: 'site',
    basePath: '/site',
    operations: [{ method: 'get', path: '/' }, { method: 'get', path: '/{path+}' }, { method: 'get', path: '/items/{id}' }],
  }]);

  it('{name+} matches the rest of the path, slashes included', () => {
    const match = matchRoute(routes, 'GET', '/site/assets/js/app.js');
    assert.equal(match.status, 200);
    assert.equal(match.operation.path, '/{path+}');
    assert.deepEqual(match.params, { path: 'assets/js/app.js' });
    assert.equal(match.path, '/assets/js/app.js');
  });

  it('{name} still matches one segment, and the base path alone matches /', () => {
    assert.deepEqual(matchRoute(routes, 'GET', '/site/items/7').params, { id: '7' });
    assert.equal(matchRoute(routes, 'GET', '/site').operation.path, '/');
    assert.equal(matchRoute(routes, 'GET', '/site/').operation.path, '/');
    assert.equal(matchRoute(routes, 'GET', '/other/x').status, 404);
  });
});

describe('public APIs and the home redirect', () => {
  let pki;
  let gateway;
  let upstream;
  let ports;
  let handlerPort;
  let dataDir;

  const push = (config) => managementRequest({ port: ports.managementPort, method: 'PUT', path: '/v1/config', body: config, client: pki.management, pki });
  const call = (pathname, { token, method = 'GET', headers = {} } = {}) => fetch(`http://127.0.0.1:${handlerPort}${pathname}`, {
    method,
    redirect: 'manual',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });

  const configWith = (changes = {}) => {
    const config = buildConfig(pki, { handlerPort, upstreamUrl: upstream.url });
    config.handlers[0].homePath = '/site/';
    config.apis.push({
      id: 'api-site',
      name: 'Website',
      version: '1.0.0',
      basePath: '/site',
      access: 'public',
      upstreamUrl: upstream.url,
      operations: [
        { method: 'get', path: '/' },
        { method: 'get', path: '/{path+}' },
        { method: 'post', path: '/{path+}' },
      ],
      flow: proxyPolicy(null),
    });
    // Only in a published product; nobody subscribes to it.
    config.products.push({ id: 'prod-site', name: 'Website', apiIds: ['api-site'], rateLimit: { enabled: true, requests: 1, period: 'hour' } });
    return { ...config, ...changes };
  };

  before(async () => {
    pki = createPki();
    upstream = await startUpstream();
    handlerPort = await freePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-public-'));
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
    const res = await push(configWith());
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  after(async () => {
    await gateway.stop();
    await upstream.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves a public API without a token, deep paths included', async () => {
    const res = await call('/site/auto/123?lang=en');
    assert.equal(res.status, 200);
    const received = upstream.requests.at(-1);
    assert.equal(received.url, '/backend/auto/123?lang=en');
    assert.equal(received.headers['x-gateway-client-id'], undefined);
    assert.ok(received.headers['x-forwarded-for']);

    const root = await call('/site');
    assert.equal(root.status, 200);
    assert.equal(upstream.requests.at(-1).url, '/backend/');
  });

  it("never passes the caller's Authorization to a public API's backend", async () => {
    const res = await call('/site/api/me', { method: 'POST', headers: { authorization: 'Bearer forged' } });
    assert.equal(res.status, 200);
    assert.equal(upstream.requests.at(-1).headers.authorization, undefined);
  });

  it("doesn't apply a product's per-application rate limit to public traffic", async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await call('/site/assets/app.js')).status, 200);
  });

  it('still requires a token and a subscription for the other APIs', async () => {
    assert.equal((await call('/acme/orders/orders')).status, 401);
    assert.equal((await call('/acme/orders/orders', { token: tokenFor(pki, { clientId: 'stranger' }) })).status, 403);
    assert.equal((await call('/acme/orders/orders', { token: tokenFor(pki) })).status, 200);
  });

  it('only serves the methods the public API declares', async () => {
    const res = await call('/site/x', { method: 'DELETE' });
    assert.equal(res.status, 405);
  });

  it("redirects / to the handler's home path, keeping the query", async () => {
    const res = await call('/?lang=en');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/site/?lang=en');
    assert.equal((await call('/', { method: 'POST' })).status, 404);
  });

  it('answers / with 404 when the handler has no home path', async () => {
    const config = configWith({ version: 'v2' });
    delete config.handlers[0].homePath;
    assert.equal((await push(config)).status, 200);
    assert.equal((await call('/')).status, 404);
  });

  it('rejects an unknown access mode and an invalid home path', async () => {
    const access = configWith({ version: 'v3' });
    access.apis[1].access = 'anyone';
    const badAccess = await push(access);
    assert.equal(badAccess.status, 400);
    assert.match(badAccess.body.message, /unknown access mode/);

    for (const homePath of ['site', '/', '//evil.example', '/a b']) {
      const config = configWith({ version: 'v4' });
      config.handlers[0].homePath = homePath;
      const res = await push(config);
      assert.equal(res.status, 400, homePath);
      assert.match(res.body.message, /home path/);
    }
  });
});
