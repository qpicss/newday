// Gateway features: policy flows (port and API flows, scripts, If branches, Invoke steps, script
// libraries, the default flow that returns the request), connections (retries, circuit breaker,
// auth, upstream mTLS), tracing, metrics, request log, usage, off-load, flow tests, credential
// renewal, the management link (pull mode, tasks) and the admin UI.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { createGateway } = require('../src/gateway');
const { RedisRateLimiter } = require('../src/rateLimiter');
const { createLogger } = require('../src/logger');
const {
  createPki,
  credentialsFor,
  issuePair,
  freePort,
  managementRequest,
  tokenFor,
  buildConfig,
  chainFlow,
  scriptStep,
  invokeStep,
  policyOf,
  silentLogger,
} = require('./support');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An upstream whose behavior each test can script.
const startScriptedUpstream = async (options = {}) => {
  const requests = [];
  let script = (req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, body }));
  };
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, clientCert: req.socket.getPeerCertificate?.()?.subject?.CN });
      script(req, res, body);
    });
  };
  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  const port = await listen(server);
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}/backend`,
    requests,
    setScript: (next) => { script = next; },
    close: () => closeServer(server),
  };
};

const gatewayOptions = (pki, dataDir, extra = {}) => ({
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
  ...extra,
});

describe('gateway features', () => {
  let pki;
  let gateway;
  let ports;
  let handlerPort;
  let upstream;
  let dataDir;
  let config;

  const push = (next) => managementRequest({ port: ports.managementPort, method: 'PUT', path: '/v1/config', body: next, client: pki.management, pki });
  const manage = (method, pathname, body) => managementRequest({ port: ports.managementPort, method, path: pathname, body, client: pki.management, pki });
  const call = (pathname, { method = 'GET', body, headers = {} } = {}) => fetch(`http://127.0.0.1:${handlerPort}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(pki)}`, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // A configuration with the given extras applied to the base one.
  const withConfig = (version, mutate) => {
    const next = buildConfig(pki, { handlerPort, upstreamUrl: upstream.url, version });
    mutate(next);
    return next;
  };

  before(async () => {
    pki = createPki();
    upstream = await startScriptedUpstream();
    handlerPort = await freePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-features-'));
    gateway = createGateway(gatewayOptions(pki, dataDir, { nodeName: 'node-a' }));
    ports = await gateway.start();
  });

  after(async () => {
    await gateway.stop();
    await upstream.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('opens only the handlers for the whole cluster and for this node', async () => {
    const mine = await freePort();
    const theirs = await freePort();
    config = withConfig('n1', (next) => {
      next.handlers.push(
        { ...next.handlers[0], id: 'h-mine', name: 'Mine', port: mine, nodes: ['node-a'] },
        { ...next.handlers[0], id: 'h-theirs', name: 'Theirs', port: theirs, nodes: ['node-b'] },
        // Another node may use the same port as the cluster handler on this one.
        { ...next.handlers[0], id: 'h-clash', name: 'Clash', port: handlerPort, nodes: ['node-b'] },
      );
    });
    const res = await push(config);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.handlers.map((handler) => handler.port).sort(), [handlerPort, mine].sort());
    const reach = (port) => fetch(`http://127.0.0.1:${port}/acme/orders/orders`, { headers: { authorization: `Bearer ${tokenFor(pki)}` } });
    assert.equal((await reach(mine)).status, 200);
    await assert.rejects(reach(theirs));
  });

  it("calls the Backend URL set in the step, and the API's server URL when the step has none", async () => {
    config = withConfig('u1', (next) => {
      next.apis[0].flow = policyOf([invokeStep({ url: upstream.url })]);
      next.apis[0].upstreamUrl = null;
    });
    assert.equal((await push(config)).status, 200);
    const call = () => fetch(`http://127.0.0.1:${handlerPort}/acme/orders/orders?page=2`, { headers: { authorization: `Bearer ${tokenFor(pki)}` } });
    assert.equal((await call()).status, 200);
    const sent = upstream.requests.at(-1);
    assert.equal(sent.url, `${new URL(upstream.url).pathname}/orders?page=2`);
    // Still the API's backend: it learns who called.
    assert.equal(sent.headers['x-gateway-client-id'], 'client-1');

    // The request log names the provider that was called, with credentials in the query masked.
    config = withConfig('u1b', (next) => {
      next.apis[0].flow = policyOf([invokeStep({ url: `${upstream.url}?api_key=s3cret&region=eu`, appendPath: false })]);
      next.apis[0].upstreamUrl = null;
    });
    assert.equal((await push(config)).status, 200);
    const logged = await call();
    assert.equal(logged.status, 200);
    const { entries } = (await manage('GET', '/v1/requests?limit=1')).body;
    assert.deepEqual(entries[0].upstream.map(({ step, method, url, status }) => ({ step, method, url, status })), [
      { step: 'Call the backend', method: 'GET', url: `${upstream.url}?api_key=***&region=eu`, status: 200 },
    ]);
    assert.doesNotMatch(JSON.stringify(entries[0]), /s3cret/);

    // Without the request's path, the step calls its URL exactly as written.
    config = withConfig('u1c', (next) => {
      next.apis[0].flow = { id: 'exact', name: 'Exact', flow: chainFlow([{ type: 'invoke', name: 'Exact URL', config: { url: `${upstream.url}/breeds` } }]) };
      next.apis[0].upstreamUrl = null;
    });
    assert.equal((await push(config)).status, 200);
    assert.equal((await call()).status, 200);
    assert.equal(upstream.requests.at(-1).url, `${new URL(upstream.url).pathname}/breeds`);

    config = withConfig('u2', (next) => {
      next.apis[0].flow = policyOf([invokeStep()]);
      next.apis[0].upstreamUrl = null;
    });
    assert.equal((await push(config)).status, 200);
    const missing = await call();
    assert.equal(missing.status, 502);
    assert.equal((await missing.json()).error, 'no_backend_url');
  });

  it('returns the request as it is when the flow has no Invoke step', async () => {
    config = withConfig('d1', (next) => {
      next.apis[0].flow = policyOf([]);
      next.apis[0].upstreamUrl = null;
    });
    assert.equal((await push(config)).status, 200);

    const before = upstream.requests.length;
    const res = await fetch(`http://127.0.0.1:${handlerPort}/acme/orders/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(pki)}`, 'content-type': 'application/xml' },
      body: '<order id="7"/>',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/xml');
    assert.equal(await res.text(), '<order id="7"/>');
    assert.equal(upstream.requests.length, before);
  });

  it('runs the port flow, then the API flow: scripts, the backend call and a script on its answer', async () => {
    config = withConfig('p1', (next) => {
      next.handlers[0].flow = policyOf([scriptStep(`module.exports = (c) => {
        c.headers['x-order'] = 'handler';
        c.variables.tenant = 'acme';
      };`)], { id: 'hp', name: 'Port policy' });
      next.apis[0].flow = policyOf([
        scriptStep(`module.exports = async (c) => {
          c.headers['x-order'] += ',api';
          c.headers['x-signature'] = crypto.hmacSha256('secret', c.original.body || '');
          c.method = 'PUT';
          c.path = '/orders/' + c.original.params.id;
          c.query = { ...c.query, tenant: c.variables.tenant };
        };`),
        invokeStep(),
        scriptStep(`module.exports = { onResponse(c) {
          const upstreamBody = JSON.parse(c.response.body);
          c.response.status = 202;
          c.response.headers['x-sent-to'] = c.request.url;
          c.response.body = { wrapped: upstreamBody.path, by: c.consumer.application };
        } };`),
      ], { id: 'ap', name: 'API policy' });
      next.apis[0].operations.push({ method: 'post', path: '/orders/{id}' });
    });
    assert.equal((await push(config)).status, 200);

    const res = await call('/acme/orders/orders/42?x=1', { method: 'POST', body: { a: 1 } });
    assert.equal(res.status, 202);
    assert.match(res.headers.get('x-sent-to'), /\/backend\/orders\/42\?x=1&tenant=acme$/);
    assert.deepEqual(await res.json(), { wrapped: '/backend/orders/42?x=1&tenant=acme', by: 'App client-1' });

    const received = upstream.requests.at(-1);
    assert.equal(received.method, 'PUT');
    assert.equal(received.url, '/backend/orders/42?x=1&tenant=acme');
    assert.equal(received.headers['x-order'], 'handler,api');
    assert.equal(received.headers['x-signature'], crypto.createHmac('sha256', 'secret').update('{"a":1}').digest('hex'));
  });

  it('branches with If and calls another URL into a variable', async () => {
    const flow = {
      nodes: [
        { id: 'input', type: 'input', x: 0, y: 0 },
        {
          id: 'branch', type: 'if', name: 'Premium?', x: 0, y: 0,
          config: { match: 'all', conditions: [{ source: 'header', name: 'x-plan', operator: 'equals', value: 'premium' }] },
        },
        {
          id: 'lookup', type: 'invoke', name: 'Look up', x: 0, y: 0,
          config: {
            target: 'url', url: `${upstream.url}/plans/{{ request.headers.x-plan }}`, method: 'GET', body: 'none',
            headers: [{ name: 'x-client', value: '{{ consumer.clientId }}' }], responseTo: 'variable', variable: 'plan',
          },
        },
        {
          id: 'answer', type: 'script', name: 'Answer', x: 0, y: 0,
          config: { code: 'module.exports = (c) => { c.response = { status: 200, headers: {}, body: { plan: c.variables.plan.json.path, status: c.variables.plan.status } }; };' },
        },
        { id: 'output', type: 'output', x: 0, y: 0 },
      ],
      edges: [
        { from: 'input', port: 'next', to: 'branch' },
        { from: 'branch', port: 'true', to: 'lookup' },
        { from: 'branch', port: 'false', to: 'output' },
        { from: 'lookup', port: 'next', to: 'answer' },
        { from: 'answer', port: 'next', to: 'output' },
      ],
    };
    config = withConfig('b1', (next) => { next.apis[0].flow = { id: 'branchy', name: 'Branchy', flow }; });
    assert.equal((await push(config)).status, 200);

    const premium = await call('/acme/orders/orders', { headers: { 'x-plan': 'premium' } });
    assert.deepEqual(await premium.json(), { plan: '/backend/plans/premium', status: 200 });
    assert.equal(upstream.requests.at(-1).headers['x-client'], 'client-1');
    // The API's own backend learns who called; other services don't.
    assert.equal(upstream.requests.at(-1).headers['x-gateway-client-id'], undefined);

    const before = upstream.requests.length;
    const basic = await call('/acme/orders/orders', { method: 'POST', body: { plan: 'basic' } });
    assert.deepEqual(await basic.json(), { plan: 'basic' });
    assert.equal(upstream.requests.length, before);
  });

  it('gives scripts crypto, hash, jwt, querystring, http and rateLimit', async () => {
    const lookupUrl = JSON.stringify(`${upstream.url}/lookup?`);
    config = withConfig('l1', (next) => {
      next.apis[0].flow = policyOf([scriptStep(`module.exports = async (c) => {
        const limit = await rateLimit.check(c.original.remoteAddress, 2, 'minute');
        if (!limit.allowed) return c.reply(429, { error: 'slow down' });
        const token = await jwt.sign({ sub: 'user-1' }, 'shh', { expiresIn: '1m', issuer: 'tests' });
        const claims = await jwt.verify(token, 'shh', { issuer: 'tests' });
        let forged = 'accepted';
        try { await jwt.verify(token, 'wrong'); } catch (error) { forged = 'rejected'; }
        const sealed = await crypto.encrypt('secret text', 'key');
        const backend = await http.post(${lookupUrl} + querystring.stringify({ q: 'a b' }), { sku: 42 });
        c.reply(200, {
          sub: claims.sub,
          decoded: jwt.decode(token).payload.iss,
          forged,
          sha512: await hash.sha512('abc'),
          md5: await hash.md5('abc', 'base64'),
          uuid: /^[0-9a-f-]{36}$/.test(await crypto.randomUUID()),
          roundTrip: await crypto.decrypt(sealed, 'key'),
          backend: { status: backend.status, path: backend.json.path, body: backend.json.body },
          parsed: querystring.parse('a=1&a=2&b=x+y'),
          remaining: limit.remaining,
        });
      };`, { timeoutMs: 5000 })]);
    });
    assert.equal((await push(config)).status, 200);

    const first = await call('/acme/orders/orders');
    const body = await first.json();
    assert.equal(first.status, 200, JSON.stringify(body));
    assert.deepEqual(body, {
      sub: 'user-1',
      decoded: 'tests',
      forged: 'rejected',
      sha512: crypto.createHash('sha512').update('abc').digest('hex'),
      md5: crypto.createHash('md5').update('abc').digest('base64'),
      uuid: true,
      roundTrip: 'secret text',
      backend: { status: 200, path: '/backend/lookup?q=a%20b', body: '{"sku":42}' },
      parsed: { a: ['1', '2'], b: 'x y' },
      remaining: 1,
    });
    assert.equal((await call('/acme/orders/orders')).status, 200);
    const limited = await call('/acme/orders/orders');
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'slow down' });
  });

  it('continues after a failed call when the Invoke step says so', async () => {
    const closed = await freePort();
    config = withConfig('e1', (next) => {
      next.apis[0].flow = policyOf([
        invokeStep({ target: 'url', url: `http://127.0.0.1:${closed}/down`, onError: 'continue', responseTo: 'variable', variable: 'risk' }),
        scriptStep('module.exports = (c) => { c.reply(200, { riskStatus: c.variables.risk.status, error: c.variables.risk.json.error }); };'),
      ]);
    });
    assert.equal((await push(config)).status, 200);
    const res = await call('/acme/orders/orders');
    assert.deepEqual(await res.json(), { riskStatus: 502, error: 'bad_gateway' });
  });

  it('refuses flows that loop or leave a step unconnected', async () => {
    const looping = withConfig('x1', (next) => {
      const flow = chainFlow([scriptStep('module.exports = () => {};'), scriptStep('module.exports = () => {};')]);
      flow.edges.find((edge) => edge.from === 'step2').to = 'step1';
      next.apis[0].flow = { id: 'loop', name: 'Loop', flow };
    });
    const loop = await push(looping);
    assert.equal(loop.status, 400);
    assert.match(loop.body.message, /loop|not connected/);

    const dangling = withConfig('x2', (next) => {
      const flow = chainFlow([scriptStep('module.exports = () => {};')]);
      flow.edges = flow.edges.filter((edge) => edge.from !== 'step1');
      next.apis[0].flow = { id: 'dangling', name: 'Dangling', flow };
    });
    const unconnected = await push(dangling);
    assert.equal(unconnected.status, 400);
    assert.match(unconnected.body.message, /no next step|not connected/);
  });

  it('propagates W3C trace context to the upstream', async () => {
    config = withConfig('t1', () => {});
    assert.equal((await push(config)).status, 200);
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const res = await call('/acme/orders/orders/1', { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } });

    assert.equal(res.headers.get('x-trace-id'), traceId);
    const sent = upstream.requests.at(-1).headers.traceparent;
    assert.match(sent, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    assert.ok(!sent.includes('00f067aa0ba902b7'));
  });

  it('retries idempotent calls and opens the circuit after repeated failures', async () => {
    let failuresLeft = 2;
    upstream.setScript((req, res) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    config = withConfig('c1', (next) => {
      next.connections = [{
        id: 'conn-1', name: 'Orders backend', connectTimeoutMs: 1000, timeoutMs: 2000, retries: 2, retryOn: [503],
        circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 60000 },
        auth: { type: 'basic', username: 'svc', secret: 'p@ss' },
      }];
      next.apis[0].connectionId = 'conn-1';
    });
    assert.equal((await push(config)).status, 200);

    const before = upstream.requests.length;
    const retried = await call('/acme/orders/orders/1');
    assert.equal(retried.status, 200);
    assert.equal(upstream.requests.length - before, 3);
    assert.equal(upstream.requests.at(-1).headers.authorization, `Basic ${Buffer.from('svc:p@ss').toString('base64')}`);

    upstream.setScript((req, res) => res.writeHead(503).end());
    assert.equal((await call('/acme/orders/orders/1')).status, 503);
    assert.equal((await call('/acme/orders/orders/1')).status, 503);
    const open = await call('/acme/orders/orders/1');
    assert.equal(open.status, 503);
    assert.equal((await open.json()).error, 'circuit_open');

    const metrics = await (await fetch(`http://127.0.0.1:${ports.healthPort}/metrics`)).text();
    assert.match(metrics, /gateway_circuit_open\{connection="Orders backend"\} 1/);
    upstream.setScript((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  });

  it('calls an upstream that requires mTLS with a private CA', async () => {
    const upstreamCa = createPki();
    const serverPair = issuePair(upstreamCa.authority, 'orders.internal', { serverAuth: true, altNames: [{ type: 7, ip: '127.0.0.1' }] });
    const clientPair = issuePair(upstreamCa.authority, 'gateway-client', { clientAuth: true });
    const secure = await startScriptedUpstream({
      tls: { key: serverPair.privateKey, cert: serverPair.certificate, ca: [upstreamCa.authority.certificate], requestCert: true, rejectUnauthorized: true },
    });
    try {
      config = withConfig('m1', (next) => {
        next.apis[0].upstreamUrl = secure.url;
        next.connections = [{
          id: 'conn-tls', name: 'Private backend', connectTimeoutMs: 1000, timeoutMs: 2000, retries: 0,
          tls: { ca: upstreamCa.authority.certificate, clientCertificate: clientPair.certificate, clientKey: clientPair.privateKey },
        }];
        next.apis[0].connectionId = 'conn-tls';
      });
      assert.equal((await push(config)).status, 200);

      const res = await call('/acme/orders/orders/7');
      assert.equal(res.status, 200);
      assert.equal(secure.requests.at(-1).clientCert, 'gateway-client');

      // Without the private CA the upstream certificate is refused.
      config.connections[0].tls = { clientCertificate: clientPair.certificate, clientKey: clientPair.privateKey };
      config.version = 'm2';
      await push(config);
      const refused = await call('/acme/orders/orders/7');
      assert.equal(refused.status, 502);
      assert.equal((await refused.json()).error, 'upstream_tls_error');
    } finally {
      await secure.close();
    }
  });

  it('exposes Prometheus metrics, the request log and usage', async () => {
    config = withConfig('o1', () => {});
    await push(config);
    await call('/acme/orders/orders/9');

    const metrics = await (await fetch(`http://127.0.0.1:${ports.healthPort}/metrics`)).text();
    assert.match(metrics, /# TYPE gateway_requests_total counter/);
    assert.match(metrics, /gateway_requests_total\{api="Orders API",handler="Public HTTP",status_class="2xx"\} \d+/);
    assert.match(metrics, /gateway_request_duration_seconds_bucket\{api="Orders API",le="\+Inf"\} \d+/);
    assert.match(metrics, /gateway_config_info\{version="o1"\} 1/);

    const requests = await manage('GET', '/v1/requests?limit=5');
    assert.equal(requests.status, 200);
    assert.equal(requests.body.entries[0].path, '/acme/orders/orders/9');
    assert.equal(requests.body.entries[0].application, 'App client-1');

    const usage = await manage('GET', '/v1/usage');
    const record = usage.body.records.find((item) => item.clientId === 'client-1');
    assert.ok(record.requests > 0);
    assert.equal(record.productId, 'prod-1');
    assert.deepEqual((await manage('GET', '/v1/usage')).body.records, []);
  });

  it('off-loads request events as JSON or OpenTelemetry logs', async () => {
    const received = [];
    const sink = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(200).end();
      });
    });
    const sinkPort = await listen(sink);
    try {
      config = withConfig('f1', (next) => {
        next.observability = {
          requestLog: { enabled: false },
          offload: { type: 'http', url: `http://127.0.0.1:${sinkPort}/events`, headers: { authorization: 'Bearer sink-token' }, batchSize: 1, flushIntervalMs: 500 },
        };
      });
      await push(config);
      await call('/acme/orders/orders/11');
      for (let i = 0; i < 40 && !received.length; i += 1) await sleep(50);
      assert.equal(received[0].url, '/events');
      assert.equal(received[0].headers.authorization, 'Bearer sink-token');
      assert.equal(received[0].body[0].path, '/acme/orders/orders/11');
      assert.equal((await manage('GET', '/v1/requests')).body.enabled, false);

      config = withConfig('f2', (next) => {
        next.observability = { offload: { type: 'otlp', url: `http://127.0.0.1:${sinkPort}/v1/logs`, batchSize: 1, flushIntervalMs: 500 } };
      });
      await push(config);
      received.length = 0;
      await call('/acme/orders/orders/12');
      for (let i = 0; i < 40 && !received.length; i += 1) await sleep(50);
      const record = received[0].body.resourceLogs[0].scopeLogs[0].logRecords[0];
      assert.equal(received[0].url, '/v1/logs');
      assert.equal(record.body.stringValue, 'GET /acme/orders/orders/12 200');
      assert.match(record.traceId, /^[0-9a-f]{32}$/);
      assert.ok(record.attributes.some((attribute) => attribute.key === 'http.response.status_code' && attribute.value.intValue === '200'));
    } finally {
      await closeServer(sink);
    }
  });

  it('tests a flow against a sample request without deploying it', async () => {
    const res = await manage('POST', '/v1/policy-test', {
      policy: {
        name: 'Draft',
        flow: chainFlow([
          scriptStep('module.exports = (c) => { c.headers.sig = crypto.sha256(c.body); console.log("ran"); };'),
          invokeStep({ responseTo: 'variable', variable: 'backend' }),
        ]),
      },
      api: { id: 'a1', name: 'Orders API', basePath: '/acme/orders', upstreamUrl: upstream.url },
      connections: [],
      sample: { method: 'POST', path: '/orders', headers: { 'content-type': 'text/plain' }, body: 'abc' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, res.body.error);
    assert.deepEqual(res.body.steps.map((step) => step.type), ['input', 'script', 'invoke', 'output']);
    assert.deepEqual(res.body.steps[1].logs, [['info', 'ran']]);
    assert.match(res.body.steps[2].outcome, /POST http:\/\/127\.0\.0\.1:\d+\/backend\/orders answered 200/);
    assert.equal(res.body.request.headers.sig, crypto.createHash('sha256').update('abc').digest('hex'));
    assert.equal(res.body.variables.backend.status, 200);
    // No step set a response, so the client would get the request back.
    assert.deepEqual(
      { status: res.body.response.status, body: res.body.response.body, echoed: res.body.response.echoed },
      { status: 200, body: 'abc', echoed: true }
    );

    const broken = await manage('POST', '/v1/policy-test', { policy: { name: 'Broken', flow: chainFlow([scriptStep('module.exports = () => { throw new Error("nope"); };')]) }, sample: {} });
    assert.equal(broken.status, 200);
    assert.equal(broken.body.ok, false);
    assert.match(broken.body.error, /nope/);
    assert.equal(broken.body.steps.at(-1).error, broken.body.error);

    const invalid = await manage('POST', '/v1/policy-test', { policy: { name: 'Bad', flow: { nodes: [] } }, sample: {} });
    assert.equal(invalid.status, 400);
  });

  it('installs renewed credentials without a restart', async () => {
    const renewed = issuePair(pki.authority, `gateway:${pki.gatewayId}`, { serverAuth: true, clientAuth: true });
    const bundle = { ...credentialsFor(pki), certificate: renewed.certificate, privateKey: renewed.privateKey };
    const res = await manage('PUT', '/v1/credentials', bundle);
    assert.equal(res.status, 200);

    const fingerprint = new crypto.X509Certificate(renewed.certificate).fingerprint256;
    const presented = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port: ports.managementPort, ca: [pki.authority.certificate], key: pki.management.privateKey, cert: pki.management.certificate, checkServerIdentity: () => undefined }, () => {
        resolve(socket.getPeerX509Certificate().fingerprint256);
        socket.end();
      });
      socket.on('error', reject);
    });
    assert.equal(presented, fingerprint);
    assert.ok(fs.existsSync(path.join(dataDir, 'credentials.json')));

    const foreign = createPki();
    const rejected = await manage('PUT', '/v1/credentials', credentialsFor(foreign));
    assert.equal(rejected.status, 400);
  });
});

describe('management link and admin UI', () => {
  let pki;
  let consoleServer;
  let consolePort;
  let gateway;
  let ports;
  let dataDir;
  let handlerPort;
  const calls = [];
  let taskSent = false;
  let taskResult = null;

  // A stand-in for the console's link endpoint (mTLS, management server certificate).
  const startFakeConsole = async () => {
    const server = https.createServer({
      key: pki.consoleServer.privateKey,
      cert: pki.consoleServer.certificate,
      ca: [pki.authority.certificate],
      requestCert: true,
      rejectUnauthorized: true,
    }, (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const peer = req.socket.getPeerCertificate().subject.CN;
        calls.push({ method: req.method, url: req.url, peer, body, ifNoneMatch: req.headers['if-none-match'] });
        const send = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(payload === undefined ? '' : JSON.stringify(payload));
        };
        if (req.url === '/v1/register' || req.url === '/v1/usage') return send(200, { ok: true });
        if (req.url === '/v1/heartbeat') return send(200, { renewalAvailable: false });
        if (req.url === '/v1/config') {
          const config = buildConfig(pki, { handlerPort, upstreamUrl: 'http://127.0.0.1:1/backend', version: 'pulled-1' });
          if (req.headers['if-none-match'] === '"pulled-1"') return send(304);
          return send(200, { config: { ...config, management: { linkUrl: `https://127.0.0.1:${consolePort}` } } });
        }
        // One flow test for the node, then nothing (after a short wait, like a long poll).
        if (req.url.startsWith('/v1/tasks?')) {
          if (taskSent) return setTimeout(() => send(204), 100);
          taskSent = true;
          return send(200, { task: { id: 'task-1', kind: 'flow-test', payload: {
            policy: { name: 'Over the link', flow: chainFlow([scriptStep('module.exports = (c) => c.reply(201, { node: "edge-a", client: c.consumer.clientId });')]) },
            sample: { method: 'GET', path: '/x' },
          } } });
        }
        if (req.url === '/v1/tasks/task-1/result') {
          taskResult = body.result;
          return send(204);
        }
        if (req.url === '/v1/admin-login') {
          if (body.email === 'ada@acme.test' && body.password === 'right-password') {
            return send(200, { user: { id: 'u1', name: 'Ada Admin', email: 'ada@acme.test', organization: 'Acme' } });
          }
          return send(401, { error: 'invalid credentials' });
        }
        return send(404, { error: 'not found' });
      });
    });
    consolePort = await listen(server);
    return server;
  };

  const admin = (pathname, { method = 'GET', body, cookie, uiHeader = true } = {}) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const request = https.request({
      host: '127.0.0.1', port: ports.adminPort, path: pathname, method,
      ca: [pki.authority.certificate], checkServerIdentity: () => undefined,
      headers: {
        ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...(cookie && { cookie }),
        ...(uiHeader && method !== 'GET' && { 'x-gateway-ui': '1' }),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: response.statusCode, headers: response.headers, body: json, text });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });

  before(async () => {
    pki = createPki();
    handlerPort = await freePort();
    consoleServer = await startFakeConsole();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-link-'));
    gateway = createGateway(gatewayOptions(pki, dataDir, {
      managementUrl: `https://127.0.0.1:${consolePort}`,
      nodeName: 'edge-a',
      pollIntervalMs: 200,
      heartbeatIntervalMs: 200,
      usageIntervalMs: 200,
    }));
    ports = await gateway.start();
  });

  after(async () => {
    await gateway.stop();
    await closeServer(consoleServer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('registers with the console and pulls its configuration (no push needed)', async () => {
    assert.equal(gateway.status().version, 'pulled-1');
    const register = calls.find((call) => call.url === '/v1/register');
    assert.equal(register.peer, `gateway:${pki.gatewayId}`);
    assert.equal(register.body.nodeName, 'edge-a');

    for (let i = 0; i < 40 && !calls.some((call) => call.url === '/v1/heartbeat'); i += 1) await sleep(50);
    assert.ok(calls.some((call) => call.url === '/v1/config' && call.ifNoneMatch === '"pulled-1"'));
    assert.ok(calls.some((call) => call.url === '/v1/heartbeat'));
  });

  it('runs flow tests the console hands over the link', async () => {
    for (let i = 0; i < 60 && !taskResult; i += 1) await sleep(50);
    assert.equal(taskResult.status, 200);
    assert.equal(taskResult.body.ok, true);
    assert.equal(taskResult.body.response.status, 201);
    assert.deepEqual(JSON.parse(taskResult.body.response.body), { node: 'edge-a', client: 'test-client' });
    const poll = calls.find((call) => call.url.startsWith('/v1/tasks?'));
    assert.match(poll.url, /node=edge-a/);
  });

  it('serves the admin UI with a strict content security policy', async () => {
    const page = await admin('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /<script src="\/app.js"><\/script>/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal((await admin('/api/overview')).status, 401);
  });

  it('signs org admins in through the console and refuses others', async () => {
    const wrong = await admin('/api/login', { method: 'POST', body: { email: 'ada@acme.test', password: 'nope' } });
    const noHeader = await admin('/api/login', { method: 'POST', body: { email: 'ada@acme.test', password: 'right-password' }, uiHeader: false });
    const ok = await admin('/api/login', { method: 'POST', body: { email: 'ADA@acme.test', password: 'right-password' } });

    assert.equal(wrong.status, 401);
    assert.equal(noHeader.status, 403);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, 'Ada Admin');
    const cookie = ok.headers['set-cookie'][0].split(';')[0];
    assert.match(ok.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/);

    const overview = await admin('/api/overview', { cookie });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.version, 'pulled-1');
    assert.equal(overview.body.link.url, `https://127.0.0.1:${consolePort}`);
    assert.equal(overview.body.apis[0].basePath, '/acme/orders');

    const series = await admin('/api/series?minutes=15', { cookie });
    assert.equal(series.body.points.length, 90);

    await admin('/api/logout', { method: 'POST', cookie });
    assert.equal((await admin('/api/overview', { cookie })).status, 401);
  });

  it('reports usage to the console', async () => {
    gateway.observability.usage.record({ clientId: 'client-1', productId: 'prod-1', apiId: 'api-orders', status: 200, durationMs: 5 });
    for (let i = 0; i < 40 && !calls.some((call) => call.url === '/v1/usage'); i += 1) await sleep(50);
    const report = calls.find((call) => call.url === '/v1/usage');
    assert.equal(report.body.records[0].clientId, 'client-1');
  });
});

describe('shared rate limits (Redis)', () => {
  // In-memory stand-in for Redis that runs the same sliding-window rule as the Lua script.
  const fakeRedis = () => {
    const store = new Map();
    return {
      failing: false,
      connect: async () => {},
      quit: async () => {},
      on() {},
      async eval(script, { keys, arguments: args }) {
        if (this.failing) throw new Error('connection lost');
        const current = Number(store.get(keys[0]) || 0);
        const previous = Number(store.get(keys[1]) || 0);
        const used = Math.floor(previous * Number(args[1])) + current;
        if (used >= Number(args[0])) return [0, used];
        store.set(keys[0], current + 1);
        return [1, used + 1];
      },
    };
  };

  it('shares one limit between nodes and falls back to local limits when Redis fails', async () => {
    const client = fakeRedis();
    const logger = createLogger('silent');
    const nodeA = new RedisRateLimiter({ client, logger });
    const nodeB = new RedisRateLimiter({ client, logger });
    await nodeA.connecting;
    await nodeB.connecting;

    assert.equal((await nodeA.hit('app:prod', 3, 'minute')).allowed, true);
    assert.equal((await nodeB.hit('app:prod', 3, 'minute')).allowed, true);
    assert.equal((await nodeA.hit('app:prod', 3, 'minute')).allowed, true);
    assert.equal((await nodeB.hit('app:prod', 3, 'minute')).allowed, false);

    client.failing = true;
    const fallback = await nodeA.hit('app:prod', 3, 'minute', 1);
    assert.equal(fallback.allowed, true);
    assert.equal((await nodeA.hit('app:prod', 3, 'minute', 1)).allowed, false);
    assert.equal(nodeA.status().healthy, false);
  });
});
