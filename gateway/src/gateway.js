// Wires the gateway together: management endpoint (mTLS), management link, admin UI, health and
// metrics endpoint, connection handlers, policies, connections and observability.
// createGateway() is also used by tests to run a gateway in-process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { loadSettings } = require('./settings');
const { createLogger } = require('./logger');
const { loadEffectiveCredentials, parseCredentials, saveRenewedCredentials } = require('./credentials');
const { compileConfig, ConfigError } = require('./runtime');
const { createRateLimiter, LocalRateLimiter } = require('./rateLimiter');
const { HandlerManager } = require('./handlers');
const { createRequestHandler, executeFlows, initialUpstreamHeaders } = require('./pipeline');
const { createManagementServer } = require('./managementServer');
const { createAdminServer } = require('./adminServer');
const { PolicyRunner } = require('./policyRunner');
const { PolicyError, checkScriptSyntax } = require('./policy');
const { UpstreamConnections } = require('./connections');
const { normalizeFlow, flowErrors } = require('./flow');
const { compileFlow, createState, finalResponse, scriptKey } = require('./flowEngine');
const { scriptHost, bodyForScript } = require('./invoke');
const { startSpan } = require('./observability/tracing');
const { createObservability } = require('./observability');
const { ManagementLink, SOFTWARE_VERSION } = require('./link');
const { sendJson } = require('./http');
const { createFailureTracker } = require('./threats');
const { findOperation } = require('./routes');

const CONFIG_FILE = 'config.json';

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    resolve(server.address().port);
  });
});

const close = (server) => new Promise((resolve) => {
  if (!server || !server.listening) {
    resolve();
    return;
  }
  server.close(() => resolve());
  server.closeAllConnections?.();
});

// The last applied configuration is saved so a restarted node serves traffic right away.
const saveConfig = async (dataDir, config) => {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, CONFIG_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
  await fs.promises.rename(temporary, file);
};

const readSavedConfig = (dataDir) => {
  const file = path.join(dataDir, CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const formatRateLimit = (rateLimit) => (rateLimit && rateLimit.enabled ? `${rateLimit.requests} per ${rateLimit.period}` : 'unlimited');

const createGateway = (overrides = {}) => {
  const settings = { ...loadSettings(), ...overrides };
  const logger = overrides.logger || createLogger(settings.logLevel);
  let credentials = overrides.credentials
    ? parseCredentials(overrides.credentials)
    : loadEffectiveCredentials(settings.credentialsFile, settings.dataDir);
  const nodeName = settings.nodeName || os.hostname();

  const startedAt = Date.now();
  const observability = createObservability({
    logger,
    resource: { nodeName, gatewayId: credentials.gatewayId, gatewayName: credentials.gatewayName },
  });
  const rateLimiter = createRateLimiter({ redisUrl: settings.redisUrl, gatewayId: credentials.gatewayId, logger });
  const policyRunner = new PolicyRunner({ size: settings.policyWorkers, logger, host: scriptHost });
  const connections = new UpstreamConnections({ settings, metrics: observability.metrics, logger });
  let runtime = null;
  let appliedAt = null;
  // Failed attempts counted by Security steps (brute-force lockout), on this node.
  const failureTracker = createFailureTracker();

  const handlers = new HandlerManager({
    bindHost: settings.bindHost,
    logger,
    createListener: (handler) => createRequestHandler({
      handler,
      getRuntime: () => runtime,
      settings,
      rateLimiter,
      policyRunner,
      connections,
      observability,
      logger,
      failureTracker,
    }),
  });

  const status = () => {
    const stats = observability.metrics.requests;
    const byStatus = {};
    let total = 0;
    for (const entry of stats.values.values()) {
      const statusClass = entry.values[2];
      byStatus[statusClass] = (byStatus[statusClass] || 0) + entry.value;
      total += entry.value;
    }
    return {
      gatewayId: credentials.gatewayId,
      gatewayName: credentials.gatewayName,
      nodeName,
      softwareVersion: SOFTWARE_VERSION,
      version: runtime ? runtime.version : null,
      appliedAt,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      nodeVersion: process.version,
      certificateValidTo: credentials.validTo,
      certificateFingerprint: credentials.fingerprint,
      apis: runtime ? runtime.config.apis.length : 0,
      handlers: handlers.status(),
      connections: connections.status(),
      rateLimits: rateLimiter.status(),
      offload: observability.offloader.status(),
      link: link.status(),
      stats: { requests: total, byStatus },
    };
  };

  // Handlers that list nodes run only on those nodes; the others on every node of the cluster.
  const forThisNode = (config) => (config && Array.isArray(config.handlers)
    ? { ...config, handlers: config.handlers.filter((handler) => !Array.isArray(handler.nodes) || handler.nodes.includes(nodeName)) }
    : config);

  const applyNow = async (received, { persist = true } = {}) => {
    const config = forThisNode(received);
    // Throws ConfigError and leaves the current configuration in place if anything is invalid.
    const next = compileConfig(config, credentials);
    const { scripts } = next;
    try {
      const loaded = await policyRunner.load(scripts);
      next.policyGeneration = loaded.generation;
    } catch (error) {
      throw new ConfigError(error instanceof PolicyError ? error.message : 'Policies could not be loaded');
    }
    connections.configure(next.connections);
    runtime = next;
    appliedAt = new Date();
    policyRunner.activate(next.policyGeneration, scripts);
    observability.configure(next.observability);
    observability.metrics.configInfo.reset();
    observability.metrics.configInfo.set({ version: next.version }, 1);
    link.setPushedUrl(next.management.linkUrl);
    const handlerStatus = await handlers.reconcile(config.handlers);
    if (persist) await saveConfig(settings.dataDir, received);
    link.state.currentVersion = next.version;
    logger.info('configuration applied', {
      version: config.version,
      apis: config.apis.length,
      products: config.products.length,
      handlers: handlerStatus.map((handler) => `${handler.protocol}:${handler.port}${handler.listening ? '' : ' (failed)'}`),
    });
    return { gatewayId: credentials.gatewayId, version: config.version, appliedAt, handlers: handlerStatus };
  };

  // Pushes and pulls are applied one at a time so port changes never interleave.
  let queue = Promise.resolve();
  const applyConfig = (config, options) => {
    if (runtime && config?.version === runtime.version && options?.fromLink) return Promise.resolve(null);
    const run = queue.then(() => applyNow(config, options));
    queue = run.catch(() => {});
    return run;
  };

  // Renewed credentials take effect on every TLS endpoint without a restart.
  const applyCredentials = async (bundle) => {
    let renewed;
    try {
      renewed = parseCredentials(bundle);
    } catch (error) {
      throw new ConfigError(`The renewed credentials are not valid: ${error.message}`);
    }
    if (renewed.gatewayId !== credentials.gatewayId) {
      throw new ConfigError('The renewed credentials are for a different gateway');
    }
    await saveRenewedCredentials(settings.dataDir, renewed);
    credentials = renewed;
    management.setSecureContext({ key: renewed.privateKey, cert: renewed.certificate, ca: [renewed.managementCa] });
    admin.setSecureContext({ key: renewed.privateKey, cert: renewed.certificate });
    logger.info('credentials renewed', { validTo: renewed.validTo, fingerprint: renewed.fingerprint });
    return { gatewayId: renewed.gatewayId, fingerprint: renewed.fingerprint, validTo: renewed.validTo };
  };

  const link = new ManagementLink({
    settings: { ...settings, nodeName },
    getCredentials: () => credentials,
    logger,
    onConfig: (config) => applyConfig(config, { fromLink: true }),
    onRenewal: applyCredentials,
    getStatus: status,
    usage: observability.usage,
    onTask: (task) => runTask(task),
  });

  const overview = () => {
    const base = status();
    const config = runtime ? runtime.config : null;
    const connectionStatus = new Map(connections.status().map((connection) => [connection.id, connection]));
    const connectionNames = new Map((config?.connections || []).map((connection) => [connection.id, connection.name]));
    return {
      ...base,
      certificate: { validTo: credentials.validTo, fingerprint: credentials.fingerprint },
      nodeCount: runtime ? runtime.nodeCount : 1,
      handlers: base.handlers.map((handler) => {
        const configured = config?.handlers.find((item) => item.port === handler.port);
        return { ...handler, policy: configured?.flow?.name || null };
      }),
      apis: (config?.apis || []).map((api) => ({
        name: api.name,
        basePath: api.basePath,
        operations: api.operations.length,
        policy: api.flow?.name || null,
        connection: api.connectionId ? connectionNames.get(api.connectionId) : null,
        circuit: api.connectionId ? connectionStatus.get(api.connectionId)?.circuit : null,
      })),
      products: (config?.products || []).map((product) => ({ name: product.name, rateLimit: formatRateLimit(product.rateLimit) })),
      requestLog: { enabled: observability.requestLog.enabled, size: observability.requestLog.size },
      metricsEnabled: observability.metricsEnabled(),
      adminEnabled: isAdminEnabled(),
    };
  };

  // Runs a flow from the console's editor against a sample request, without deploying it.
  // Invoke steps and http.* calls reach their services for real; rate limits are counted apart
  // from live traffic. Returns { ok, error?, steps, response, request, variables }.
  let testCounter = 0;
  const testFlow = async ({ policy, api, connections: connectionConfigs, sample } = {}) => {
    const { flow, error } = normalizeFlow(policy?.flow);
    if (error) throw new ConfigError(error);
    const errors = flowErrors(flow);
    if (errors.length) throw new ConfigError(errors[0].message);
    testCounter += 1;
    const compiled = compileFlow(`test-${testCounter}`, { id: policy.id || 'test', name: policy.name || 'Test', flow });
    compiled.scripts.forEach((script) => checkScriptSyntax(script));

    const request = sample && typeof sample === 'object' ? sample : {};
    const method = String(request.method || 'GET').toUpperCase();
    const path = typeof request.path === 'string' && request.path.startsWith('/') ? request.path : '/';
    const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    const query = request.query && typeof request.query === 'object' ? request.query : {};
    const body = Buffer.from(typeof request.body === 'string' ? request.body : '');
    const testApi = { id: 'test-api', name: 'Test API', version: '1.0.0', basePath: '/test', upstreamUrl: null, connectionId: null, ...(api || {}) };
    const shared = {
      original: {
        method, path: `${testApi.basePath}${path}`, operationPath: path, params: {}, query, queryString: '',
        headers, body: body.toString('utf8'), remoteAddress: '203.0.113.10', protocol: 'https',
      },
      api: { id: testApi.id, name: testApi.name, version: testApi.version, basePath: testApi.basePath },
      consumer: { clientId: 'test-client', application: 'Test application', product: { id: 'test-product', name: 'Test product' } },
      requestId: `test-${Date.now().toString(36)}`,
      traceId: startSpan({}).traceId,
    };
    const state = createState({ method, path, query, headers: initialUpstreamHeaders(headers), body });
    const testConnections = new UpstreamConnections({ settings, metrics: { circuitOpen: { set() {} } }, logger });
    testConnections.configure(Array.isArray(connectionConfigs) ? connectionConfigs : []);
    const trace = [];
    const scripts = compiled.scripts.length ? await policyRunner.loadTemporary(compiled.scripts) : null;
    // Validate steps check against the operation of the chosen API that the sample path matches.
    const operation = findOperation(Array.isArray(testApi.operations) ? testApi.operations : [], method, path);
    let outcome = { ok: true };
    try {
      await executeFlows({
        flows: [compiled],
        state,
        shared,
        canStream: false,
        trace,
        checks: {
          contract: operation?.contract || null,
          remoteAddress: shared.original.remoteAddress,
          clientId: 'test-client',
          // Its own counts, so a test never locks out live callers.
          tracker: createFailureTracker(),
        },
        runScript: (flowItem, node, input) => scripts.run(scriptKey(flowItem.key, node.id), input, node.config.timeoutMs, {
          flowId: 'test',
          connections: testConnections,
          connectionList: connectionConfigs || [],
          rateLimiter: new LocalRateLimiter(),
          nodeCount: 1,
          maxBodyBytes: settings.maxBodyBytes,
        }),
        invokeContext: {
          connections: testConnections,
          api: testApi,
          clientId: 'test-client',
          span: startSpan({}),
          forwarded: { for: '203.0.113.10', host: 'gateway.test', proto: 'https' },
          maxBodyBytes: settings.maxBodyBytes,
        },
      });
    } catch (problem) {
      if (!(problem instanceof PolicyError) && !problem.status) throw problem;
      outcome = { ok: false, error: problem.message, logs: problem.logs || [] };
    } finally {
      scripts?.drop();
      testConnections.closeAll();
    }
    const answer = finalResponse(state);
    const shown = bodyForScript(answer.body.subarray(0, 256 * 1024), answer.headers['content-type']);
    return {
      ...outcome,
      steps: trace,
      response: { status: answer.status, headers: answer.headers, ...shown, truncated: answer.body.length > 256 * 1024, echoed: answer.echoed },
      request: { method: state.method, path: state.path, query: state.query, headers: state.headers, sent: state.request },
      variables: state.variables,
    };
  };

  // Work sent over the management link; answers like the management endpoint would.
  const runTask = async (task) => {
    try {
      if (task.kind === 'requests') return { status: 200, body: observability.requestLog.list(task.payload || {}) };
      if (task.kind !== 'flow-test') return { status: 400, body: { error: 'unknown_task', message: `This gateway does not know the task "${task.kind}"` } };
      return { status: 200, body: await testFlow(task.payload) };
    } catch (error) {
      if (error instanceof ConfigError) return { status: 400, body: { error: 'invalid_configuration', message: error.message } };
      if (error instanceof PolicyError) return { status: 422, body: { error: 'policy_error', message: error.message, logs: error.logs } };
      logger.error('link task failed', { kind: task.kind, error: error.message });
      return { status: 500, body: { error: 'internal_error', message: 'The gateway could not complete the task' } };
    }
  };

  const actions = {
    status,
    applyConfig,
    applyCredentials,
    drainUsage: () => observability.usage.drain(),
    listRequests: (query) => observability.requestLog.list(query),
    subscribeRequests: (listener) => observability.requestLog.subscribe(listener),
    series: (minutes) => observability.metrics.series.series(minutes),
    overview,
    testFlow,
    verifyAdmin: (email, password) => link.verifyAdmin(email, password),
  };

  const isAdminEnabled = () => settings.adminEnabled && (!runtime || runtime.admin.enabled !== false);

  const management = createManagementServer({ credentials, logger, actions });
  const admin = createAdminServer({ credentials, logger, actions, isEnabled: isAdminEnabled });

  const health = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://health.invalid');
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (url.pathname === '/readyz') {
      const handlerStatus = handlers.status();
      const ready = Boolean(runtime) && handlerStatus.every((handler) => handler.listening);
      sendJson(res, ready ? 200 : 503, { ready, version: runtime ? runtime.version : null, handlers: handlerStatus });
      return;
    }
    if (url.pathname === '/metrics' && observability.metricsEnabled()) {
      const body = observability.metrics.render();
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });

  const start = async () => {
    const managementPort = await listen(management, settings.managementPort, settings.managementHost);
    const healthPort = await listen(health, settings.healthPort, settings.healthHost);
    const adminPort = settings.adminEnabled ? await listen(admin, settings.adminPort, settings.adminHost) : null;
    logger.info('gateway started', {
      gatewayId: credentials.gatewayId,
      gatewayName: credentials.gatewayName,
      nodeName,
      managementPort,
      healthPort,
      adminPort,
      managementUrl: settings.managementUrl,
      rateLimits: rateLimiter.status().mode,
      certificateValidTo: credentials.validTo,
    });

    try {
      const saved = readSavedConfig(settings.dataDir);
      if (saved) {
        await applyConfig(saved, { persist: false });
      } else if (!settings.managementUrl) {
        logger.info('waiting for configuration from management');
      }
    } catch (error) {
      logger.error('saved configuration could not be applied; waiting for a new one', { error: error.message });
    }
    await link.start();
    return { managementPort, healthPort, adminPort };
  };

  const stop = async () => {
    await link.stop();
    await observability.offloader.drain();
    await Promise.all([close(management), close(health), close(admin), handlers.closeAll(), policyRunner.close(), rateLimiter.close()]);
    connections.closeAll();
    logger.info('gateway stopped');
  };

  return {
    start,
    stop,
    applyConfig,
    applyCredentials,
    status,
    overview,
    settings,
    get credentials() {
      return credentials;
    },
    observability,
    link,
  };
};

module.exports = { createGateway };
