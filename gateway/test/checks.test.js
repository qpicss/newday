// The checking steps of a flow, through a running gateway: Validate request (headers and query
// against the OpenAPI operation), Validate body (requestBody schema, content type) and Security
// (injection patterns, monitor mode, IP lists, brute-force lockout), plus flow tests that use them.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createGateway } = require('../src/gateway');
const { defaultConfig } = require('../src/flow');
const { createPki, credentialsFor, freePort, managementRequest, tokenFor, buildConfig, invokeStep, policyOf, silentLogger } = require('./support');

const CONTRACTS = {
  'get /orders': {
    parameters: [
      { in: 'header', name: 'X-Tenant', required: true, schema: { type: 'string', pattern: '^[a-z]+$' } },
      { in: 'query', name: 'limit', required: false, schema: { type: 'integer', maximum: 100 } },
      { in: 'query', name: 'status', required: false, schema: { type: 'array', items: { type: 'string', enum: ['open', 'closed'] } } },
    ],
    body: null,
  },
  'post /orders': {
    parameters: [],
    body: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['quantity'],
            properties: { quantity: { type: 'integer', minimum: 1 }, note: { type: 'string', maxLength: 10 } },
          },
        },
      },
    },
  },
};

const validateRequest = (config = {}) => ({ type: 'validateRequest', name: 'Validate request', config: { ...defaultConfig('validateRequest'), ...config } });
const validateBody = (config = {}) => ({ type: 'validateBody', name: 'Validate body', config: { ...defaultConfig('validateBody'), ...config } });
const security = (config = {}) => ({ type: 'security', name: 'Security', config: { ...defaultConfig('security'), ...config } });

describe('checking steps', () => {
  let pki;
  let gateway;
  let ports;
  let handlerPort;
  let dataDir;
  let upstream;
  let upstreamPort;
  const received = [];

  const push = (steps, version) => {
    const config = buildConfig(pki, { handlerPort, upstreamUrl: `http://127.0.0.1:${upstreamPort}/backend`, version, flow: policyOf(steps) });
    config.apis[0].operations = config.apis[0].operations.map((operation) => ({ ...operation, contract: CONTRACTS[`${operation.method} ${operation.path}`] || { parameters: [], body: null } }));
    return managementRequest({ port: ports.managementPort, method: 'PUT', path: '/v1/config', body: config, client: pki.management, pki });
  };
  const manage = (method, pathname, body) => managementRequest({ port: ports.managementPort, method, path: pathname, body, client: pki.management, pki });
  const call = (pathname, { method = 'GET', headers = {}, body } = {}) => fetch(`http://127.0.0.1:${handlerPort}/acme/orders${pathname}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(pki)}`, ...headers },
    body,
  });
  const json = (value) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

  before(async () => {
    pki = createPki();
    // A login-like backend: 401 unless x-password is "right".
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        const denied = req.headers['x-password'] !== undefined && req.headers['x-password'] !== 'right';
        res.writeHead(denied ? 401 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: !denied }));
      });
    });
    upstreamPort = await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port)));
    handlerPort = await freePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-checks-'));
    gateway = createGateway({
      credentials: credentialsFor(pki),
      managementHost: '127.0.0.1',
      managementPort: 0,
      healthHost: '127.0.0.1',
      healthPort: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      bindHost: '127.0.0.1',
      dataDir,
      policyWorkers: 1,
      logger: silentLogger(),
    });
    ports = await gateway.start();
  });

  after(async () => {
    await gateway.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers 422 when headers or query do not match the operation, and passes valid requests on', async () => {
    assert.equal((await push([validateRequest(), invokeStep()], 'c1')).status, 200);
    const before = received.length;

    const missing = await call('/orders');
    assert.equal(missing.status, 422);
    const body = await missing.json();
    assert.equal(body.error, 'invalid_request');
    assert.deepEqual(body.errors, [{ in: 'header', name: 'X-Tenant', message: 'is required' }]);
    assert.ok(body.requestId);

    const wrong = await (await call('/orders?limit=500&status=open&status=lost', { headers: { 'x-tenant': 'Acme1' } })).json();
    assert.deepEqual(wrong.errors.map((error) => `${error.in} ${error.name}${error.path || ''}: ${error.message}`), [
      'header X-Tenant: must match the pattern ^[a-z]+$',
      'query limit: must be at most 100',
      'query status/1: must be one of "open", "closed"',
    ]);
    const notNumber = await (await call('/orders?limit=ten', { headers: { 'x-tenant': 'acme' } })).json();
    assert.equal(notNumber.errors[0].message, 'must be an integer, not a string');
    assert.equal(received.length, before, 'invalid requests never reach the backend');

    const ok = await call('/orders?limit=5&status=open', { headers: { 'x-tenant': 'acme' } });
    assert.equal(ok.status, 200);
    assert.equal(received.length, before + 1);

    // Undeclared query parameters are let through unless the step rejects them; headers can be skipped.
    assert.equal((await call('/orders?debug=1', { headers: { 'x-tenant': 'acme' } })).status, 200);
    assert.equal((await push([validateRequest({ headers: false, rejectUnknownQuery: true }), invokeStep()], 'c2')).status, 200);
    const unknown = await (await call('/orders?debug=1')).json();
    assert.deepEqual(unknown.errors, [{ in: 'query', name: 'debug', message: 'is not a declared parameter' }]);
  });

  it('checks the body against the requestBody schema and the content type', async () => {
    assert.equal((await push([validateBody(), invokeStep()], 'c3')).status, 200);
    const before = received.length;

    const empty = await call('/orders', { method: 'POST' });
    assert.equal(empty.status, 422);
    assert.equal((await empty.json()).message, 'A request body is required');

    const text = await call('/orders', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'two please' });
    assert.equal(text.status, 415);
    assert.match((await text.json()).message, /Send one of: application\/json/);

    const broken = await call('/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"quantity":' });
    assert.equal((await broken.json()).message, 'The request body is not valid JSON');

    const invalid = await call('/orders', { method: 'POST', ...json({ quantity: 0, note: 'far too long for it' }) });
    assert.equal(invalid.status, 422);
    assert.deepEqual((await invalid.json()).errors, [
      { path: '/quantity', message: 'must be at least 1' },
      { path: '/note', message: 'must be at most 10 characters long' },
    ]);
    assert.equal(received.length, before);

    assert.equal((await call('/orders', { method: 'POST', ...json({ quantity: 2, extra: true }) })).status, 200);
    assert.equal((await push([validateBody({ rejectUnknown: true }), invokeStep()], 'c4')).status, 200);
    const strict = await (await call('/orders', { method: 'POST', ...json({ quantity: 2, extra: true }) })).json();
    assert.deepEqual(strict.errors, [{ path: '/extra', message: 'is not a declared property' }]);
    // An operation without a requestBody is not checked.
    assert.equal((await call('/orders/7', { headers: { 'content-type': 'application/json' }, body: undefined })).status, 200);
  });

  it('blocks injection attempts without echoing them, or only logs them in monitor mode', async () => {
    assert.equal((await push([security(), invokeStep()], 'c5')).status, 200);
    const before = received.length;

    const sql = await call(`/orders?q=${encodeURIComponent("' OR '1'='1")}`);
    assert.equal(sql.status, 403);
    const blocked = await sql.json();
    assert.equal(blocked.error, 'request_blocked');
    assert.match(blocked.message, /sql injection in query\.q/);
    assert.doesNotMatch(JSON.stringify(blocked), /1'='1/);

    const nosql = await call('/orders', { method: 'POST', ...json({ user: { $ne: null } }) });
    assert.equal(nosql.status, 403);
    const xss = await call('/orders', { method: 'POST', ...json({ note: '<script>alert(1)</script>' }) });
    assert.equal(xss.status, 403);
    const traversal = await call('/orders', { headers: { 'x-file': '..%2F..%2Fetc%2Fpasswd' } });
    assert.equal(traversal.status, 403);
    assert.equal(received.length, before);

    assert.equal((await call('/orders?q=rock%20%26%20roll&name=O%27Brien')).status, 200, 'ordinary text passes');

    assert.equal((await push([security({ mode: 'monitor' }), invokeStep()], 'c6')).status, 200);
    const watched = await call(`/orders?q=${encodeURIComponent('1 UNION SELECT password FROM users')}`);
    assert.equal(watched.status, 200);
    const log = await manage('GET', '/v1/requests?limit=1');
    assert.deepEqual(log.body.entries[0].threats, ['sql_injection in query.q']);
  });

  it('refuses addresses on the deny list or missing from the allow list', async () => {
    assert.equal((await push([security({ ipDeny: ['127.0.0.0/8'] }), invokeStep()], 'c7')).status, 200);
    const denied = await call('/orders');
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'access_denied');
    assert.equal((await push([security({ ipAllow: ['203.0.113.0/24'] }), invokeStep()], 'c8')).status, 200);
    assert.equal((await call('/orders')).status, 403);
    assert.equal((await push([security({ ipAllow: ['127.0.0.1', '::1'] }), invokeStep()], 'c9')).status, 200);
    assert.equal((await call('/orders')).status, 200);
  });

  it('locks a caller out after repeated failed answers', async () => {
    const step = security({ bruteForce: true, bruteKey: 'header', bruteKeyName: 'x-user', bruteStatuses: [401], bruteMax: 3, bruteWindow: 60, bruteLockout: 30 });
    assert.equal((await push([step, invokeStep()], 'c10')).status, 200);
    const login = (user, password) => call('/orders', { headers: { 'x-user': user, 'x-password': password } });

    assert.equal((await login('ann', 'wrong')).status, 401);
    assert.equal((await login('ann', 'right')).status, 200, 'a success clears the count');
    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await login('ann', 'wrong')).status, 401);
    const before = received.length;
    const locked = await login('ann', 'right');
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '30');
    assert.equal((await locked.json()).error, 'too_many_failures');
    assert.equal(received.length, before, 'a locked-out caller never reaches the backend');
    assert.equal((await login('bob', 'right')).status, 200, 'other users are not affected');
  });

  it('runs the checks in flow tests against the chosen API operation', async () => {
    const policy = policyOf([validateRequest(), validateBody(), security()]);
    const operations = Object.entries(CONTRACTS).map(([key, contract]) => {
      const [method, operationPath] = key.split(' ');
      return { method, path: operationPath, contract };
    });
    const test = (sample) => manage('POST', '/v1/policy-test', { policy, api: { id: 'api-orders', name: 'Orders API', basePath: '/acme/orders', operations }, connections: [], sample });

    const missing = await test({ method: 'GET', path: '/orders', headers: {}, query: { limit: '7' } });
    assert.equal(missing.status, 200, JSON.stringify(missing.body));
    assert.equal(missing.body.response.status, 422);
    assert.deepEqual(missing.body.steps[1].problems, [{ in: 'header', name: 'X-Tenant', message: 'is required' }]);

    const valid = await test({ method: 'POST', path: '/orders', headers: { 'content-type': 'application/json' }, body: '{"quantity":1}' });
    assert.equal(valid.body.response.status, 200);
    assert.deepEqual(valid.body.steps.slice(1, 4).map((step) => step.outcome), [
      '0 declared parameters checked (headers and query); all valid',
      'The application/json body matches the schema',
      'No threat found',
    ]);

    // Without an API there is no operation, so the Validate steps pass and say why.
    const alone = await manage('POST', '/v1/policy-test', { policy, connections: [], sample: { method: 'GET', path: '/orders' } });
    assert.match(alone.body.steps[1].outcome, /No OpenAPI operation matches this request/);
  });
});
