// The request path for API traffic on a connection handler:
// match route -> authenticate -> check subscription -> rate limit -> the port's policy flow
// (if any) -> the API's policy flow -> answer the client.
// A public API (access 'public') skips the token, subscription and product rate limit: its
// flows see no consumer. A handler with a home path redirects GET / to it.
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
const { invokeStep, loggableUrl } = require('./invoke');
const { recordAnswer } = require('./threats');

const REQUEST_ID = /^[\w.:-]{1,128}$/;
const MAX_LOGGED_STEPS = 50;
const MAX_STEP_LOGS = 20;
const MAX_LOG_LENGTH = 500;
const MAX_STEP_PROBLEMS = 10;
const MAX_STEP_DETAILS = 20;

// The steps of a request, for the request log: the gateway's own (receive, route, access, rate limit,
// respond, without a `flow`) around the steps the flows ran, with what each decided and how long it took.
// Problems name the place and the rule (as the 422 answer does); request values and bodies stay out,
// and a called URL shows with its credentials masked, as in `upstream`.
const flowLog = (trace) => (trace.length > MAX_LOGGED_STEPS ? [...trace.slice(0, MAX_LOGGED_STEPS - 1), trace[trace.length - 1]] : trace).map((step) => ({
  ...(step.flow && { flow: step.flow }),
  name: step.name,
  type: step.type,
  ...(step.stop && { stop: true }),
  ...(step.outcome && { outcome: step.call?.url ? step.outcome.split(step.call.url).join(loggableUrl(step.call.url)) : step.outcome }),
  ...(step.branch && { branch: step.branch }),
  ...(step.durationMs !== undefined && { durationMs: step.durationMs }),
  ...(step.error && { error: step.error }),
  ...(step.details?.length && { details: step.details.slice(0, MAX_STEP_DETAILS).map((line) => String(line).slice(0, MAX_LOG_LENGTH)) }),
  ...(step.logs?.length && {
    logs: step.logs.slice(0, MAX_STEP_LOGS).map(([level, message]) => ({ level, message: String(message).slice(0, MAX_LOG_LENGTH) })),
  }),
  ...(step.problems?.length && {
    problems: step.problems.slice(0, MAX_STEP_PROBLEMS).map((problem) => {
      if (typeof problem === 'string') return problem;
      if (problem.rule) return `${problem.rule} in ${problem.location}`; // a Security finding
      return [problem.in, problem.name, problem.path, problem.message].filter(Boolean).join(' ');
    }),
  }),
}));

// An error that also says, for the request log only, why the gateway answered as it did.
const explained = (error, reason, details = []) => Object.assign(error, { reason, details: [reason, ...details] });

// What the Authorization header holds, without its value.
const authorizationKind = (header) => {
  if (!header) return 'none';
  const scheme = header.trim().split(/\s+/)[0];
  return /^bearer$/i.test(scheme) ? 'Bearer token' : `${scheme.slice(0, 32)} (not accepted: the gateway takes Bearer tokens)`;
};

// Why a token failed verification, in words; the token itself is never logged.
const tokenProblem = (error) => {
  if (error.name === 'TokenExpiredError') return `The token expired at ${error.expiredAt.toISOString()}`;
  if (error.name === 'NotBeforeError') return `The token is not valid before ${error.date.toISOString()}`;
  if (/audience invalid/.test(error.message)) return `The token's audience (aud) is not ${error.message.split('expected: ')[1] || 'this gateway'}`;
  if (/issuer invalid/.test(error.message)) return `The token's issuer (iss) is not ${error.message.split('expected: ')[1] || 'this console'}`;
  if (/signature/.test(error.message)) return 'The token signature does not match the token key it names';
  if (/algorithm/.test(error.message)) return 'The token is not signed with RS256';
  return `The token could not be verified: ${error.message}`;
};

const authenticate = (req, runtime) => {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw explained(new HttpError(401, 'invalid_request', 'Send an access token: Authorization: Bearer <token>', {
      'www-authenticate': 'Bearer realm="gateway"',
    }), header ? `The Authorization header is ${authorizationKind(header)}` : 'The request has no Authorization header', [
      'Get a token from POST /oauth/token (client credentials) and send it as Authorization: Bearer <token>',
    ]);
  }

  const invalid = (reason) => explained(new HttpError(401, 'invalid_token', 'The access token is invalid or expired', {
    'www-authenticate': 'Bearer realm="gateway", error="invalid_token"',
  }), reason);
  const decoded = jwt.decode(match[1], { complete: true });
  if (!decoded) throw invalid('The Bearer token is not a JWT');
  const kid = String(decoded.header.kid ?? '').slice(0, 64);
  const key = runtime.tokenKeys.get(decoded.header.kid);
  if (!key) {
    throw invalid(kid
      ? `The token's key ID "${kid}" is not one of this gateway's token keys (${[...runtime.tokenKeys.keys()].join(', ') || 'none'}): it was issued by another console, or this node's configuration is older than the key`
      : 'The token has no key ID (kid)');
  }
  let payload;
  try {
    payload = jwt.verify(match[1], key, {
      algorithms: ['RS256'],
      audience: runtime.audience,
      issuer: runtime.issuer,
    });
  } catch (error) {
    throw invalid(tokenProblem(error));
  }
  return payload.sub;
};

const findProduct = (runtime, apiId, clientId) => {
  const subscription = runtime.subscriptions.get(clientId);
  const product = subscription && (runtime.productsByApi.get(apiId) || [])
    .find((candidate) => subscription.productIds.has(candidate.id));
  if (!product) {
    const offered = (runtime.productsByApi.get(apiId) || []).map((candidate) => candidate.name);
    throw explained(new HttpError(403, 'forbidden', 'Your application has no approved access to an API product that includes this API'),
      subscription
        ? `Application ${subscription.application || clientId} is approved for other products, none of which includes this API`
        : `Client ${clientId} has no approved subscription on this gateway`,
      [offered.length
        ? `Products with this API: ${offered.join(', ')}. Subscribe the application to one and have an organization admin approve it`
        : 'No published product on this gateway includes this API: add it to a product and publish it']);
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
  // The steps of this request, kept only while the request log is on.
  const trace = observability.requestLog.enabled ? [] : null;
  const since = (start) => Math.round((performance.now() - start) * 10) / 10;
  // A step the gateway itself takes; `stop` marks the one that ended the request early.
  const gatewayStep = (type, name, outcome, extra = {}) => trace?.push({ type, name, outcome, ...extra });
  // What arrived, by name and kind only: header values and the body stay out of the log.
  gatewayStep('receive', 'Receive', `${req.method} ${url.pathname} on ${handler.name} (port ${handler.port}) from ${req.socket.remoteAddress}`, {
    details: [
      `Host: ${String(req.headers.host || 'none').slice(0, 255)}`,
      `Authorization: ${authorizationKind(req.headers.authorization)}`,
      ...(req.headers['x-forwarded-for'] ? [`Forwarded for: ${String(req.headers['x-forwarded-for']).slice(0, 255)}`] : []),
      ...(url.search ? [`Query parameters: ${[...new Set(url.searchParams.keys())].join(', ')}`] : []),
      ...(event.bytesIn ? [`Body: ${event.bytesIn} bytes (${String(req.headers['content-type'] || 'no content type').slice(0, 100)})`] : []),
    ],
  });

  const finish = (status, extra = {}, message = null, details = []) => {
    Object.assign(event, extra, { status, durationMs: since(started) });
    if (policyMs) event.policyMs = Math.round(policyMs * 10) / 10;
    if (trace) {
      let outcome = `Answered ${status}`;
      if (extra.error) outcome = `Answered ${status} ${extra.error}${message ? `: ${message}` : ''}`;
      else if (extra.redirect) outcome = `Redirected to ${extra.redirect} (${status})`;
      else if (message) outcome = `${message} (${status})`;
      else if (extra.reply) outcome = `Answered ${status}, replied by "${extra.reply}"`;
      else if (extra.echoed) outcome = `Answered ${status} with the request it received`;
      gatewayStep('respond', 'Respond', outcome, { durationMs: event.durationMs, ...(status >= 400 && { stop: true }), ...(details.length && { details }) });
      event.flow = flowLog(trace);
    }
    observability.record(event);
  };

  try {
    const runtime = getRuntime();
    if (!runtime) {
      gatewayStep('route', 'Route', 'No configuration received yet', { stop: true });
      throw new HttpError(503, 'not_configured', 'This gateway has not received a configuration yet');
    }

    if (handler.homePath && url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      gatewayStep('route', 'Route', `Home path of ${handler.name}`);
      res.writeHead(302, { ...responseHeaders, location: `${handler.homePath}${url.search}`, 'content-length': 0 });
      res.end();
      finish(302, { redirect: handler.homePath });
      return;
    }

    const route = matchRoute(runtime.routes, req.method, url.pathname);
    if (route.status === 404) {
      gatewayStep('route', 'Route', `No API operation matches ${url.pathname}`, {
        stop: true,
        details: ['No API deployed to this gateway has an operation for this path: check the API is in a published product on this gateway, and its base path'],
      });
      throw new HttpError(404, 'not_found', 'No API operation matches this path');
    }
    if (route.status === 405) {
      gatewayStep('route', 'Route', `${url.pathname} takes ${route.allow.join(', ')}, not ${req.method}`, { stop: true });
      throw new HttpError(405, 'method_not_allowed', `Use ${route.allow.join(', ')} for this path`, { allow: route.allow.join(', ') });
    }
    Object.assign(event, { api: route.api.name, apiId: route.api.id });
    // The whole API, or only this operation, may be open to anyone.
    const isPublic = route.api.access === 'public' || route.operation.access === 'public';
    const accessRule = `API access: ${route.api.access || 'subscription'}; operation access: ${route.operation.access || 'as the API'}`;
    gatewayStep('route', 'Route', `${route.api.name}: ${req.method} ${route.path}`, {
      details: [
        `API base path: ${route.api.basePath || '/'}`,
        ...(route.params && Object.keys(route.params).length ? [`Path parameters: ${Object.keys(route.params).join(', ')}`] : []),
        `${accessRule} (${isPublic ? 'no token needed' : 'token and approved subscription needed'})`,
      ],
    });
    let clientId = null;
    let product = null;
    let application = null;
    if (isPublic) {
      event.access = 'public';
      gatewayStep('access', 'Access', route.api.access === 'public' ? 'Public API: no token needed' : `Public operation ${req.method} ${route.path}: no token needed`);
    } else {
      const checked = performance.now();
      try {
        clientId = authenticate(req, runtime);
        event.clientId = clientId;
        ({ product, application } = findProduct(runtime, route.api.id, clientId));
      } catch (error) {
        observability.metrics.authFailures.inc({ reason: error.code });
        gatewayStep('access', 'Access', error instanceof HttpError ? `Refused: ${error.message}` : 'Refused', {
          durationMs: since(checked),
          stop: true,
          details: [
            ...(error.details || []),
            ...(error.code === 'invalid_request' ? [`${req.method} ${route.path} of ${route.api.name} needs a token (${accessRule}). To serve it without one, make the operation or the API public in the console and deploy`] : []),
          ],
        });
        throw error;
      }
      Object.assign(event, { productId: product.id, product: product.name, application });
      gatewayStep('access', 'Access', `Token of ${application || clientId} accepted, subscribed to ${product.name}`, { durationMs: since(checked) });
    }

    if (product && product.rateLimit && product.rateLimit.enabled) {
      const checked = performance.now();
      const localShare = Math.max(1, Math.ceil(product.rateLimit.requests / runtime.nodeCount));
      const limit = rateLimiter.shared ? product.rateLimit.requests : localShare;
      const result = await rateLimiter.hit(`${clientId}:${product.id}`, limit, product.rateLimit.period, localShare);
      Object.assign(responseHeaders, rateLimitHeaders(result));
      if (!result.allowed) {
        observability.metrics.rateLimited.inc({ product: product.name });
        gatewayStep('rateLimit', 'Rate limit', `Limit of ${result.limit} per ${product.rateLimit.period} reached, retry in ${result.resetSeconds} s`, { durationMs: since(checked), stop: true });
        throw new HttpError(429, 'rate_limited', `Rate limit of ${product.rateLimit.requests} requests per ${product.rateLimit.period} reached`, {
          'retry-after': String(result.resetSeconds),
        });
      }
      gatewayStep('rateLimit', 'Rate limit', `${result.remaining} of ${result.limit} left this ${product.rateLimit.period}`, { durationMs: since(checked) });
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
      consumer: { clientId, application, product: product && { id: product.id, name: product.name } },
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
      trace,
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
      res.on('finish', () => finish(upstream.statusCode, { bytesOut: Number(upstream.headers['content-length']) || undefined }, "Passed the backend's answer through"));
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
      finish(error.status, { error: error.code, ...(error.reason && { reason: error.reason }) }, error.message, error.details || []);
      return;
    }
    if (error instanceof PolicyError) {
      logger.error('policy failed', { requestId, traceId: span.traceId, policy: error.policyName, error: error.message });
      for (const [, message] of error.logs) logger.info('policy log', { requestId, message });
      sendJson(res, 500, { error: 'policy_error', message: 'The gateway policy for this API failed', requestId }, responseHeaders);
      finish(500, { error: 'policy_error', reason: `${error.policyName}: ${error.message}` }, null, [
        `Policy step: ${error.policyName}`,
        `Exception: ${error.message}`,
        ...error.logs.slice(0, MAX_STEP_LOGS).map(([level, message]) => `[${level}] ${message}`),
      ]);
      return;
    }
    logger.error('request failed', { requestId, error: error.message });
    sendJson(res, 500, { error: 'internal_error', message: 'The gateway could not process this request', requestId }, responseHeaders);
    finish(500, { error: 'internal_error', reason: error.message }, null, [`Exception: ${error.name}: ${error.message}`, ...(error.code ? [`Code: ${error.code}`] : [])]);
  }
};

module.exports = { createRequestHandler, executeFlows, buildUpstreamUrl, initialUpstreamHeaders, queryString };
