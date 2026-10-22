// Validates a configuration pushed by management and compiles it into the structures the
// request pipeline uses. A configuration either compiles completely or is rejected, so a bad
// push never replaces a working one.
const { createPublicKey } = require('crypto');
const { compileRoutes, normalizeBasePath } = require('./routes');
const { checkScriptSyntax, PolicyError } = require('./policy');
const { normalizeFlow, flowErrors, defaultFlow } = require('./flow');
const { compileFlow } = require('./flowEngine');

// 2: APIs and handlers carry policy flows (flow.js) instead of single policy scripts.
const SCHEMA = 2;
const PROTOCOLS = ['http', 'https'];
const PERIODS = ['second', 'minute', 'hour', 'day'];
const AUTH_TYPES = ['none', 'basic', 'bearer', 'header'];

class ConfigError extends Error {}

const assert = (condition, message) => {
  if (!condition) throw new ConfigError(message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const validateHandlers = (handlers) => {
  assert(Array.isArray(handlers), '"handlers" must be a list');
  const ports = new Set();
  for (const handler of handlers) {
    assert(isPlainObject(handler), 'Each handler must be an object');
    assert(Number.isInteger(handler.port) && handler.port >= 1 && handler.port <= 65535, `Handler "${handler.name}" has an invalid port`);
    assert(!ports.has(handler.port), `Port ${handler.port} is used by more than one handler`);
    ports.add(handler.port);
    assert(PROTOCOLS.includes(handler.protocol), `Handler "${handler.name}" must use http or https`);
    assert(handler.nodes === undefined || (Array.isArray(handler.nodes) && handler.nodes.every((name) => typeof name === 'string')), `Handler "${handler.name}" must list its nodes by name`);
    if (handler.protocol === 'https') {
      assert(isPlainObject(handler.tls) && handler.tls.certificate && handler.tls.privateKey, `HTTPS handler "${handler.name}" needs a certificate and private key`);
    }
  }
};

const validateConnections = (connections) => {
  assert(Array.isArray(connections), '"connections" must be a list');
  for (const connection of connections) {
    assert(isPlainObject(connection) && connection.id, 'Each connection must have an id');
    assert(Number.isInteger(connection.timeoutMs) && connection.timeoutMs > 0, `Connection "${connection.name}" needs a timeout`);
    assert(Number.isInteger(connection.connectTimeoutMs) && connection.connectTimeoutMs > 0, `Connection "${connection.name}" needs a connect timeout`);
    assert(Number.isInteger(connection.retries) && connection.retries >= 0 && connection.retries <= 5, `Connection "${connection.name}" allows 0 to 5 retries`);
    assert(!connection.auth || AUTH_TYPES.includes(connection.auth.type), `Connection "${connection.name}" has an unknown auth type`);
  }
};

const validateApis = (apis, connectionIds) => {
  assert(Array.isArray(apis), '"apis" must be a list');
  const basePaths = new Map();
  for (const api of apis) {
    assert(isPlainObject(api) && api.id, 'Each API must have an id');
    assert(typeof api.basePath === 'string' && normalizeBasePath(api.basePath) !== '/', `API "${api.name}" needs a base path`);
    const basePath = normalizeBasePath(api.basePath);
    assert(!basePaths.has(basePath), `APIs "${basePaths.get(basePath)}" and "${api.name}" share the base path ${basePath}`);
    basePaths.set(basePath, api.name);

    // Only Invoke steps that call "the API's backend" need it.
    if (api.upstreamUrl) {
      let upstream;
      try {
        upstream = new URL(api.upstreamUrl);
      } catch {
        throw new ConfigError(`API "${api.name}" has an invalid upstream URL`);
      }
      assert(['http:', 'https:'].includes(upstream.protocol), `API "${api.name}" upstream must use http or https`);
    }
    assert(Array.isArray(api.operations), `API "${api.name}" must list its operations`);
    for (const operation of api.operations) {
      assert(isPlainObject(operation) && typeof operation.method === 'string' && typeof operation.path === 'string', `API "${api.name}" has an operation without a method and path`);
      const { contract } = operation;
      assert(contract === undefined || contract === null || (isPlainObject(contract)
        && (contract.parameters === undefined || Array.isArray(contract.parameters))
        && (contract.body === undefined || contract.body === null || isPlainObject(contract.body))),
      `API "${api.name}": the definition of ${operation.method.toUpperCase()} ${operation.path} is not valid`);
    }
    assert(!api.connectionId || connectionIds.has(api.connectionId), `API "${api.name}" uses a connection that is not in the configuration`);
  }
};

// Validates a policy flow and compiles it; its scripts are compiled on the policy workers by the caller.
const flowEntry = (key, policy, label, connectionIds) => {
  const name = policy.name || 'Policy';
  const { flow, error } = normalizeFlow(policy.flow);
  if (error) throw new ConfigError(`Policy "${name}" for ${label}: ${error}`);
  const errors = flowErrors(flow, { connectionIds });
  if (errors.length) throw new ConfigError(`Policy "${name}" for ${label}: ${errors[0].message}`);
  const compiled = compileFlow(key, { id: policy.id || key, name, flow });
  for (const script of compiled.scripts) {
    try {
      checkScriptSyntax(script);
    } catch (problem) {
      throw new ConfigError(problem instanceof PolicyError ? problem.message : `A script of policy "${name}" could not be loaded`);
    }
  }
  return compiled;
};

const compileConfig = (config, credentials) => {
  assert(isPlainObject(config), 'The configuration must be a JSON object');
  assert(config.schema === SCHEMA, `Unsupported configuration schema ${config.schema}; this gateway understands schema ${SCHEMA}`);
  assert(isPlainObject(config.gateway) && config.gateway.id === credentials.gatewayId,
    'This configuration was built for a different gateway');
  assert(typeof config.version === 'string' && config.version, 'The configuration has no version');

  const connections = config.connections || [];
  validateHandlers(config.handlers);
  validateConnections(connections);
  validateApis(config.apis, new Set(connections.map((connection) => connection.id)));
  assert(Array.isArray(config.products), '"products" must be a list');
  assert(Array.isArray(config.subscriptions), '"subscriptions" must be a list');
  assert(Array.isArray(config.tokenKeys) && config.tokenKeys.length, 'The configuration has no token verification keys');

  const tokenKeys = new Map();
  for (const key of config.tokenKeys) {
    try {
      tokenKeys.set(key.kid, createPublicKey(key.publicKey));
    } catch {
      throw new ConfigError(`Token key ${key.kid} is not a valid public key`);
    }
  }

  // Every API has a flow (the default one returns the request); a handler's flow is optional.
  const connectionIds = new Set(connections.map((connection) => connection.id));
  const flows = new Map();
  for (const api of config.apis) {
    const policy = api.flow || { id: `default:${api.id}`, name: 'Default policy', flow: defaultFlow() };
    flows.set(`api:${api.id}`, flowEntry(`api:${api.id}`, policy, `API "${api.name}"`, connectionIds));
  }
  for (const handler of config.handlers) {
    if (handler.flow) flows.set(`handler:${handler.id}`, flowEntry(`handler:${handler.id}`, handler.flow, `port ${handler.port}`, connectionIds));
  }
  const scripts = [...flows.values()].flatMap((flow) => flow.scripts);

  const products = new Map();
  const productsByApi = new Map();
  for (const product of config.products) {
    const rateLimit = product.rateLimit || {};
    assert(!rateLimit.enabled || (Number.isInteger(rateLimit.requests) && rateLimit.requests > 0 && PERIODS.includes(rateLimit.period)),
      `Product "${product.name}" has an invalid rate limit`);
    products.set(product.id, product);
    for (const apiId of product.apiIds || []) {
      if (!productsByApi.has(apiId)) productsByApi.set(apiId, []);
      productsByApi.get(apiId).push(product);
    }
  }
  // Deterministic choice when an API is in several products: by name.
  for (const list of productsByApi.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const subscriptions = new Map(
    config.subscriptions.map((subscription) => [subscription.clientId, {
      application: subscription.application,
      productIds: new Set(subscription.productIds || []),
    }])
  );

  return {
    version: config.version,
    config,
    gateway: config.gateway,
    // Without shared (Redis) rate limits each node enforces its share of a product's limit.
    nodeCount: Math.max(1, Number(config.gateway.nodeCount) || 1),
    issuer: config.issuer,
    audience: config.audience,
    tokenKeys,
    routes: compileRoutes(config.apis),
    handlers: new Map(config.handlers.map((handler) => [handler.id, handler])),
    connections,
    flows,
    scripts,
    policyGeneration: null,
    products,
    productsByApi,
    subscriptions,
    observability: config.observability || {},
    admin: { enabled: true, ...(config.admin || {}) },
    management: config.management || {},
  };
};

module.exports = { compileConfig, ConfigError, SCHEMA };
