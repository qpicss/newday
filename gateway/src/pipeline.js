// The request path for API traffic on a connection handler:
// match route -> authenticate -> check subscription -> rate limit -> the port's policy flow
// (if any) -> the API's policy flow -> answer the client.
// A flow calls backends only through its "Invoke service" steps (or http.* in scripts); a flow
// without any (the default for a new API) answers with the request it received.
// Every request ends in one observability event (metrics, request log, usage, off-load, log line).
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const { matchRoute } = require('./routes');
const { HttpError, readBody, sendJson, withoutHopByHop } = require('./http');
const { PolicyError } = require('./policy');
const { startSpan } = require('./observability/tracing');
const { createState, runFlow, finalResponse, flowData, scriptKey } = require('./flowEngine');
const { invokeStep } = require('./invoke');
const { recordAnswer } = require('./threats');

const REQUEST_ID = /^[\w.:-]{1,128}$/;

const authenticate = (req, runtime) => {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new HttpError(401, 'invalid_request', 'Send an access token: Authorization: Bearer <token>', {
      'www-authenticate': 'Bearer realm="gateway"',
    });
  }

  let payload;
  try {
    const decoded = jwt.decode(match[1], { complete: true });
    const key = decoded && runtime.tokenKeys.get(decoded.header.kid);
    if (!key) throw new Error('unknown key');
    payload = jwt.verify(match[1], key, {
      algorithms: ['RS256'],
      audience: runtime.audience,
      issuer: runtime.issuer,
    });
  } catch {
    throw new HttpError(401, 'invalid_token', 'The access token is invalid or expired', {
      'www-authenticate': 'Bearer realm="gateway", error="invalid_token"',
    });
  }
  return payload.sub;
};

const findProduct = (runtime, apiId, clientId) => {
  const subscription = runtime.subscriptions.get(clientId);
  const product = subscription && (runtime.productsByApi.get(apiId) || [])
    .find((candidate) => subscription.productIds.has(candidate.id));
  if (!product) {
    throw new HttpError(403, 'forbidden', 'Your application has no approved access to an API product that includes this API');
  }
  return { product, application: subscription.application };
};

const rateLimitHeaders = (result) => ({
  'ratelimit-limit': String(result.limit),
  'ratelimit-remaining': String(result.remaining),
  'ratelimit-reset': String(result.resetSeconds),
});

// The consumer's token and connection-level headers never reach the upstream.
const initialUpstreamHeaders = (headers) => {
  const result = withoutHopByHop(headers);
  delete result.authorization;
  delete result.host;
  delete result['content-length'];
  delete result.traceparent;
  delete result.tracestate;
  return result;
};

const queryObject = (searchParams) => {
  const result = {};
  for (const [name, value] of searchParams) {
    if (name in result) result[name] = [].concat(result[name], value);
    else result[name] = value;
  }
  return result;
};

const queryString = (query) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query || {})) {
    for (const item of [].concat(value)) params.append(name, item);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
};

const buildUpstreamUrl = (upstreamUrl, path, search) => {
  const target = new URL(upstreamUrl);
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = `${basePath}${path}`;
  target.search = search;
  return target;
};

// Runs a request's flows. Shared by live traffic and flow tests in the console.
//   runtime-independent inputs: flows (compiled, in order), state, shared, runScript(flow, node, input)
//   invoke context: connections, api, clientId, span, forwarded, maxBodyBytes, onSend, onCall
//   checks: what Validate and Security steps need (contract, remoteAddress, clientId, tracker, onFindings)
const executeFlows = async ({ flows, state, shared, runScript, invokeContext, checks = {}, canStream = true, trace = null }) => {
  const deps = {
    shared,
    runScript,
    canStream,
    trace,
    checks,
    invoke: (flow, node, current, { streamable }) => invokeStep(node, current, {
      ...invokeContext,
      requestId: shared.requestId,
      data: flowData(current, shared),
      streamable,
    }),
  };
  for (let index = 0; index < flows.length; index += 1) {
    await runFlow(flows[index], state, deps, { final: index === flows.length - 1 });
    if (state.replied || state.stream) break;
  }
};

const createRequestHandler = ({ handler, getRuntime, settings, rateLimiter, policyRunner, connections, observability, logger, failureTracker }) => async (req, res) => {
  const started = performance.now();
  const span = startSpan(req.headers);
  const requestId = REQUEST_ID.test(req.headers['x-request-id'] || '') ? req.headers['x-request-id'] : randomUUID();
  const responseHeaders = { 'x-request-id': requestId, 'x-trace-id': span.traceId };
  const url = new URL(req.url, 'http://gateway.invalid');
  const event = {
    time: new Date().toISOString(),
    requestId,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    handler: handler.name,
    port: handler.port,
    method: req.method,
    path: url.pathname,
    remoteAddress: req.socket.remoteAddress,
    bytesIn: Number(req.headers['content-length']) || 0,
  };
  let policyMs = 0;

  const finish = (status, extra = {}) => {
    Object.assign(event, extra, { status, durationMs: Math.round((performance.now() - started) * 10) / 10 });
    if (policyMs) event.policyMs = Math.round(policyMs * 10) / 10;
    observability.record(event);
  };

  try {
    const runtime = getRuntime();
    if (!runtime) {
      throw new HttpError(503, 'not_configured', 'This gateway has not received a configuration yet');
    }

    const route = matchRoute(runtime.routes, req.method, url.pathname);
    if (route.status === 404) throw new HttpError(404, 'not_found', 'No API operation matches this path');
    if (route.status === 405) {
      throw new HttpError(405, 'method_not_allowed', `Use ${route.allow.join(', ')} for this path`, { allow: route.allow.join(', ') });
    }
    Object.assign(event, { api: route.api.name, apiId: route.api.id });

    let clientId;
    let access;
    try {
      clientId = authenticate(req, runtime);
      event.clientId = clientId;
      access = findProduct(runtime, route.api.id, clientId);
    } catch (error) {
      observability.metrics.authFailures.inc({ reason: error.code });
      throw error;
    }
    const { product, application } = access;
    Object.assign(event, { productId: product.id, product: product.name, application });

    if (product.rateLimit && product.rateLimit.enabled) {
      const localShare = Math.max(1, Math.ceil(product.rateLimit.requests / runtime.nodeCount));
      const limit = rateLimiter.shared ? product.rateLimit.requests : localShare;
      const result = await rateLimiter.hit(`${clientId}:${product.id}`, limit, product.rateLimit.period, localShare);
      Object.assign(responseHeaders, rateLimitHeaders(result));
      if (!result.allowed) {
        observability.metrics.rateLimited.inc({ product: product.name });
        throw new HttpError(429, 'rate_limited', `Rate limit of ${product.rateLimit.requests} requests per ${product.rateLimit.period} reached`, {
          'retry-after': String(result.resetSeconds),
        });
      }
    }

    const rawBody = await readBody(req, settings.maxBodyBytes);
    const original = {
      method: req.method,
      path: url.pathname,
      operationPath: route.path,
      params: route.params,
      query: queryObject(url.searchParams),
      queryString: url.search,
      headers: { ...req.headers },
      body: rawBody.toString('utf8'),
      remoteAddress: req.socket.remoteAddress,
      protocol: handler.protocol,
    };
    const shared = {
      original,
      api: { id: route.api.id, name: route.api.name, version: route.api.version, basePath: route.api.basePath },
      consumer: { clientId, application, product: { id: product.id, name: product.name } },
      requestId,
      traceId: span.traceId,
    };
    const state = createState({
      method: req.method,
      path: route.path,
      query: original.query,
      headers: initialUpstreamHeaders(req.headers),
      body: rawBody,
    });

    // The port's flow first, then the API's, each seeing the previous one's changes.
    const flows = [runtime.flows.get(`handler:${handler.id}`), runtime.flows.get(`api:${route.api.id}`)].filter(Boolean);
    const runScript = async (flow, node, input) => {
      try {
        const result = await policyRunner.run(runtime.policyGeneration, scriptKey(flow.key, node.id), input, node.config.timeoutMs, {
          flowId: flow.id,
          connections,
          connectionList: runtime.connections,
          rateLimiter,
          nodeCount: runtime.nodeCount,
          maxBodyBytes: settings.maxBodyBytes,
        });
        policyMs += result.durationMs || 0;
        for (const [level, message] of result.logs) {
          logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']('policy log', { requestId, traceId: span.traceId, policy: flow.name, step: node.name, message });
        }
        return result;
      } catch (error) {
        observability.metrics.policyErrors.inc({ policy: flow.name, reason: error.timedOut ? 'timeout' : 'error' });
        error.policyName = `${flow.name} / ${node.name}`;
        throw error;
      }
    };
    await executeFlows({
      flows,
      state,
      shared,
      runScript,
      checks: {
        contract: route.operation.contract || null,
        remoteAddress: req.socket.remoteAddress,
        clientId,
        tracker: failureTracker,
        // Rules and places only: the suspicious values themselves are never logged.
        onFindings: (findings, blocked) => {
          event.threats = [...(event.threats || []), ...findings.map((finding) => `${finding.rule} in ${finding.location}`)];
          findings.forEach((finding) => observability.metrics.threats.inc({ rule: finding.rule, action: blocked ? 'blocked' : 'detected' }));
          logger.warn(blocked ? 'request blocked' : 'threat detected', { requestId, traceId: span.traceId, api: route.api.name, threats: event.threats });
        },
      },
      invokeContext: {
        connections,
        api: route.api,
        clientId,
        span,
        forwarded: {
          for: [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', '),
          host: req.headers.host,
          proto: handler.protocol,
        },
        maxBodyBytes: settings.maxBodyBytes,
        onSend: ({ step, method, url }) => {
          logger.info('upstream request', { requestId, traceId: span.traceId, api: route.api.name, step, method, url });
        },
        onCall: ({ step, method, url, durationMs, status, error }) => {
          // Every provider call of the request, in order, for the request log.
          event.upstream = [...(event.upstream || []), { step, method, url, durationMs, ...(status && { status }), ...(error && { error: error.message }) }];
          event.upstreamMs = (event.upstreamMs || 0) + durationMs;
          if (status) event.upstreamStatus = status;
          if (error) observability.metrics.upstreamErrors.inc({ api: route.api.name, reason: error.code || 'error' });
        },
      },
    });

    if (state.watches.length && failureTracker) recordAnswer(state.watches, state.stream ? state.stream.statusCode : finalResponse(state).status, failureTracker);

    if (state.stream) {
      const upstream = state.stream;
      res.writeHead(upstream.statusCode, { ...withoutHopByHop(upstream.headers), ...responseHeaders });
      upstream.pipe(res);
      upstream.on('error', () => res.destroy());
      res.on('finish', () => finish(upstream.statusCode, { bytesOut: Number(upstream.headers['content-length']) || undefined }));
      return;
    }

    const answer = finalResponse(state);
    const body = req.method === 'HEAD' ? Buffer.alloc(0) : answer.body;
    delete answer.headers['content-length'];
    res.writeHead(answer.status, { ...answer.headers, ...responseHeaders, 'content-length': answer.body.length });
    res.end(body);
    finish(answer.status, {
      bytesOut: body.length,
      ...(state.replied && { reply: state.repliedBy }),
      ...(answer.echoed && { echoed: true }),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.code, message: error.message, requestId }, { ...responseHeaders, ...error.headers });
      finish(error.status, { error: error.code });
      return;
    }
    if (error instanceof PolicyError) {
      logger.error('policy failed', { requestId, traceId: span.traceId, policy: error.policyName, error: error.message });
      for (const [, message] of error.logs) logger.info('policy log', { requestId, message });
      sendJson(res, 500, { error: 'policy_error', message: 'The gateway policy for this API failed', requestId }, responseHeaders);
      finish(500, { error: 'policy_error' });
      return;
    }
    logger.error('request failed', { requestId, error: error.message });
    sendJson(res, 500, { error: 'internal_error', message: 'The gateway could not process this request', requestId }, responseHeaders);
    finish(500, { error: 'internal_error' });
  }
};

module.exports = { createRequestHandler, executeFlows, buildUpstreamUrl, initialUpstreamHeaders, queryString };
