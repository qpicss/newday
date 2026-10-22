// HTTP calls made by policy flows: "Invoke service" steps, and the `http` and `rateLimit`
// libraries of gateway scripts (which run on a worker and ask the main thread through
// scriptHost()). Calls go through the gateway's connections (pooled agents, TLS, retries,
// circuit breaker, credentials).
const { HttpError, withoutHopByHop } = require('./http');
const { authHeaders } = require('./connections');
const { renderTemplate } = require('./flow');
const { traceparent, newSpanId } = require('./observability/tracing');

const TEXT_CONTENT = /json|text|xml|javascript|x-www-form-urlencoded|graphql|yaml|csv/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NO_BODY_METHODS = ['GET', 'HEAD', 'DELETE', 'OPTIONS'];
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const PERIODS = ['second', 'minute', 'hour', 'day'];
const EMPTY = Buffer.alloc(0);

const isText = (contentType) => !contentType || TEXT_CONTENT.test(contentType);

// A body as scripts see it: text, or base64 for binary content.
const bodyForScript = (buffer, contentType) => {
  if (!buffer || !buffer.length) return { body: '' };
  return isText(contentType) ? { body: buffer.toString('utf8') } : { body: buffer.toString('base64'), bodyEncoding: 'base64' };
};

const parseJson = (buffer, contentType) => {
  if (!buffer || !buffer.length || !/json/i.test(contentType || '')) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
};

const readResponse = (response, limit) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      response.destroy();
      reject(new HttpError(502, 'upstream_response_too_large', `The upstream response is larger than ${limit} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => resolve(Buffer.concat(chunks)));
  response.on('error', reject);
});

const responseHeaders = (response) => {
  const headers = withoutHopByHop(response.headers);
  delete headers['content-length'];
  return headers;
};

// Sends one request through a connection and follows up to `followRedirects` redirects.
// Credentials are not sent on to another origin.
const sendHttp = async (connections, entry, { target, method, headers, body, timeoutMs, followRedirects = 0, credentialHeaders = [] }) => {
  let current = { target, method, headers: { ...headers }, body };
  for (let hops = 0; ; hops += 1) {
    const response = await connections.send(entry, { ...current, timeoutMs });
    const location = response.headers.location;
    if (!REDIRECTS.has(response.statusCode) || !location || hops >= followRedirects) {
      return { response, target: current.target, method: current.method };
    }
    response.resume();
    let next;
    try {
      next = new URL(location, current.target);
    } catch {
      next = null;
    }
    if (!next || !['http:', 'https:'].includes(next.protocol)) {
      throw new HttpError(502, 'bad_redirect', 'The service redirected to an address the gateway cannot call');
    }
    const nextHeaders = { ...current.headers, host: next.host };
    let nextMethod = current.method;
    let nextBody = current.body;
    if (response.statusCode === 303 || ([301, 302].includes(response.statusCode) && !['GET', 'HEAD'].includes(current.method))) {
      nextMethod = current.method === 'HEAD' ? 'HEAD' : 'GET';
      nextBody = EMPTY;
      delete nextHeaders['content-type'];
    }
    if (next.origin !== current.target.origin) {
      for (const name of ['authorization', 'cookie', ...credentialHeaders]) delete nextHeaders[name];
    }
    if (nextBody.length) nextHeaders['content-length'] = String(nextBody.length);
    else delete nextHeaders['content-length'];
    current = { target: next, method: nextMethod, headers: nextHeaders, body: nextBody };
  }
};

// Adds the connection's credentials unless a header of that name is already set.
// Returns the names it added, so they can be hidden from scripts and test results.
const addCredentials = (headers, entry) => {
  const added = [];
  for (const [name, value] of Object.entries(authHeaders(entry.config.auth))) {
    if (name in headers) continue;
    headers[name] = value;
    added.push(name);
  }
  return added;
};

const withoutCredentials = (headers, names) => Object.fromEntries(Object.entries(headers)
  .map(([name, value]) => [name, names.includes(name) ? '[from the connection]' : value]));

const errorResponse = (error) => ({
  status: error.status || 502,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ error: error.code || 'bad_gateway', message: error.message })),
});

const storeResult = (config, state, result) => {
  if (config.responseTo === 'variable') {
    const contentType = result.headers['content-type'] || '';
    state.variables[config.variable] = {
      status: result.status,
      headers: result.headers,
      ...bodyForScript(result.body, contentType),
      json: parseJson(result.body, contentType),
    };
  } else {
    state.response = result;
  }
};

// A URL as it may appear in logs: no user name or password, and the values of query parameters
// that look like credentials (api_key, token, secret, signature...) masked.
const SECRET_PARAM = /key|token|secret|pass|auth|sig|code|session|credential/i;
const loggableUrl = (value) => {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const name of new Set(url.searchParams.keys())) {
      if (SECRET_PARAM.test(name)) url.searchParams.set(name, '***');
    }
    return url.href.replace(/=%2A%2A%2A/g, '=***');
  } catch {
    return '(invalid URL)';
  }
};

// Runs an "Invoke service" step. `ctx`: connections, api ({ name, upstreamUrl, connectionId }),
// data (template values), requestId, clientId, span, forwarded ({ for, host, proto }),
// maxBodyBytes and streamable (the upstream response may be piped to the client as it is).
// Returns { method, url, status, error?, durationMs }.
const invokeStep = async (node, state, ctx) => {
  const { config } = node;
  const render = (value) => renderTemplate(value, ctx.data);
  const invalid = () => new HttpError(502, 'invalid_url', `The step "${node.name}" built an invalid URL`);

  let base;
  if (config.url) {
    base = render(config.url);
  } else if (config.target === 'backend') {
    // No URL in the step: the server URL from the API's OpenAPI document.
    if (!ctx.api.upstreamUrl) {
      throw new HttpError(502, 'no_backend_url', `The step "${node.name}" has no backend URL. Set it in the step's settings.`);
    }
    base = ctx.api.upstreamUrl;
  } else {
    throw invalid();
  }
  let target;
  try {
    target = new URL(base);
  } catch {
    throw invalid();
  }
  if (!['http:', 'https:'].includes(target.protocol)) throw invalid();
  if (config.appendPath) {
    target.pathname = `${target.pathname.replace(/\/+$/, '')}${state.path}`;
    for (const [name, value] of Object.entries(state.query || {})) {
      for (const item of [].concat(value)) target.searchParams.append(name, item);
    }
  }
  for (const { name, value } of config.query) target.searchParams.set(name, render(value));

  const method = config.method === 'request' ? state.method : config.method;
  const headers = config.forwardHeaders ? withoutHopByHop(state.headers) : {};
  delete headers.host;
  delete headers['content-length'];
  for (const name of config.removeHeaders) delete headers[name];
  for (const { name, value } of config.headers) {
    const rendered = render(value);
    if (!/[\r\n]/.test(rendered)) headers[name] = rendered;
  }
  let body = EMPTY;
  if (config.body === 'request') body = state.body || EMPTY;
  else if (config.body === 'custom') body = Buffer.from(render(config.bodyTemplate));
  if (config.contentType) headers['content-type'] = config.contentType;
  else if (config.body === 'none') delete headers['content-type'];

  const entry = ctx.connections.get(config.connectionId || (config.target === 'backend' ? ctx.api.connectionId : null));
  const credentialHeaders = addCredentials(headers, entry);
  Object.assign(headers, {
    host: target.host,
    'x-request-id': ctx.requestId,
    traceparent: traceparent(ctx.span.traceId, newSpanId(), ctx.span.flags),
    ...(ctx.span.traceState && { tracestate: ctx.span.traceState }),
  });
  // The API's own backend learns who called; other services only get the request ID and trace.
  if (config.target === 'backend') {
    Object.assign(headers, {
      'x-forwarded-for': ctx.forwarded.for,
      'x-forwarded-proto': ctx.forwarded.proto,
      'x-gateway-client-id': ctx.clientId,
      ...(ctx.forwarded.host && { 'x-forwarded-host': ctx.forwarded.host }),
    });
  }
  if (body.length || !NO_BODY_METHODS.includes(method)) headers['content-length'] = String(body.length);

  // Reported before the call goes out, so the log shows the provider even when it never answers.
  ctx.onSend?.({ step: node.name, method, url: loggableUrl(target.href) });
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let sent;
  try {
    sent = await sendHttp(ctx.connections, entry, {
      target, method, headers, body, timeoutMs: config.timeoutMs, followRedirects: config.followRedirects, credentialHeaders,
    });
  } catch (error) {
    ctx.onCall?.({ step: node.name, method, url: loggableUrl(target.href), durationMs: elapsed(), error });
    state.request = { method, url: target.href, headers: withoutCredentials(headers, credentialHeaders) };
    if (error instanceof HttpError && config.onError === 'continue') {
      storeResult(config, state, errorResponse(error));
      return { method, url: target.href, status: error.status, error: error.message, durationMs: elapsed() };
    }
    throw error;
  }

  const { response } = sent;
  state.request = { method: sent.method, url: sent.target.href, headers: withoutCredentials(headers, credentialHeaders) };
  const headersOut = responseHeaders(response);
  if (config.responseTo === 'response' && ctx.streamable) {
    state.stream = response;
    state.response = { status: response.statusCode, headers: headersOut, body: null };
  } else {
    storeResult(config, state, { status: response.statusCode, headers: headersOut, body: await readResponse(response, ctx.maxBodyBytes) });
  }
  ctx.onCall?.({ step: node.name, method: sent.method, url: loggableUrl(sent.target.href), durationMs: elapsed(), status: response.statusCode });
  return { method: sent.method, url: sent.target.href, status: response.statusCode, durationMs: elapsed() };
};

// http.request() from a script. meta: connections, connectionList (configured connections),
// deadline, maxBodyBytes.
const scriptHttp = async (args, meta) => {
  let target;
  try {
    target = new URL(String(args.url || ''));
  } catch {
    target = null;
  }
  if (!target || !['http:', 'https:'].includes(target.protocol)) {
    throw new Error('http.request needs an absolute http(s) URL, for example https://api.example.com/items');
  }
  const method = String(args.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new Error(`http.request does not support the method ${method}`);
  if (args.query && typeof args.query === 'object') {
    for (const [name, value] of Object.entries(args.query)) {
      for (const item of [].concat(value)) if (item !== undefined && item !== null) target.searchParams.append(name, String(item));
    }
  }

  const headers = {};
  for (const [name, value] of Object.entries(args.headers && typeof args.headers === 'object' ? args.headers : {})) {
    const lower = name.toLowerCase();
    if (value === undefined || value === null || !HEADER_NAME.test(lower) || /[\r\n]/.test(String(value))) continue;
    headers[lower] = String(value);
  }
  let body = EMPTY;
  if (typeof args.body === 'string') {
    body = Buffer.from(args.body);
  } else if (args.body !== undefined && args.body !== null) {
    body = Buffer.from(JSON.stringify(args.body));
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }

  let connectionId = null;
  if (args.connection) {
    const wanted = String(args.connection);
    const found = (meta.connectionList || []).find((connection) => connection.id === wanted || connection.name === wanted);
    if (!found) {
      throw new Error(`No connection "${wanted}" on this gateway. Scripts can use the connections of the gateway's APIs and Invoke steps.`);
    }
    connectionId = found.id;
  }
  const entry = meta.connections.get(connectionId);
  const credentialHeaders = addCredentials(headers, entry);
  headers.host = target.host;
  if (body.length || !NO_BODY_METHODS.includes(method)) headers['content-length'] = String(body.length);

  const remaining = (meta.deadline || Date.now() + entry.config.timeoutMs) - Date.now();
  const timeoutMs = Math.min(Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : entry.config.timeoutMs, remaining);
  if (timeoutMs < 1) throw new Error('The script has no time left for this request');
  const followRedirects = Math.max(0, Math.min(5, Number.isInteger(args.followRedirects) ? args.followRedirects : 0));

  try {
    const { response } = await sendHttp(meta.connections, entry, { target, method, headers, body, timeoutMs, followRedirects, credentialHeaders });
    const buffer = await readResponse(response, meta.maxBodyBytes);
    const contentType = response.headers['content-type'] || '';
    return {
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      headers: responseHeaders(response),
      ...bodyForScript(buffer, contentType),
      json: parseJson(buffer, contentType),
    };
  } catch (error) {
    throw new Error(error instanceof HttpError ? error.message : 'The request failed');
  }
};

// rateLimit.check() from a script. Keys are counted per flow; meta: rateLimiter, nodeCount, flowId.
const scriptRateLimit = async (args, meta) => {
  const key = String(args.key || '').slice(0, 200);
  if (!key) throw new Error("rateLimit.check needs a key, for example the caller's IP address");
  const limit = Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1e9) throw new Error('rateLimit.check needs a whole-number limit of at least 1');
  const period = String(args.period || 'minute');
  if (!PERIODS.includes(period)) throw new Error(`rateLimit.check periods are ${PERIODS.join(', ')}`);
  const localShare = Math.max(1, Math.ceil(limit / Math.max(1, meta.nodeCount || 1)));
  const result = await meta.rateLimiter.hit(`script:${meta.flowId}:${key}`, meta.rateLimiter.shared ? limit : localShare, period, localShare);
  return { allowed: result.allowed, limit, remaining: result.remaining, resetSeconds: result.resetSeconds };
};

// What the policy runner calls for library requests that need the main thread.
const scriptHost = (kind, args, meta) => {
  if (kind === 'http.request') return scriptHttp(args, meta);
  if (kind === 'rateLimit.check') return scriptRateLimit(args, meta);
  return Promise.reject(new Error(`Unknown library call ${kind}`));
};

module.exports = {
  invokeStep,
  loggableUrl,
  scriptHost,
  sendHttp,
  readResponse,
  bodyForScript,
  parseJson,
  isText,
};
