// Builds the configuration a gateway receives: the catalog's published products, their APIs
// (OpenAPI operations, with their parameters and request bodies when a Validate step needs them, backend URL, base path, policy flow, connection), approved subscriptions,
// connection handlers (with port policy flows), backend connections (those of the APIs and of
// Invoke steps), observability and admin UI settings, the console's link address and the token
// verification key.
const crypto = require('crypto');
const { ApiProduct, Subscription, Connection } = require('../models');
const { getPki } = require('../utils/pki');
const { open } = require('../utils/secretBox');
const { listOperations } = require('../utils/openapi');
const { AUDIENCE, issuer } = require('../utils/gatewayTokens');
const { linkSettings } = require('../utils/linkSettings');
const { operationContract } = require('../utils/openapiContract');
const { defaultFlow, flowProblems, usesBackend, usesContract, connectionIdsOf } = require('../gateway/src/flow');

// 2: policies are flows (gateway/src/flow.js). Matches gateway/src/runtime.js.
const SCHEMA = 2;
const REDACTED = '[stored encrypted, sent only to the gateway]';

const isAbsoluteHttpUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const byKey = (key) => (a, b) => String(a[key]).localeCompare(String(b[key]));

const flowConfig = (policy) => (policy
  ? { id: policy.id, name: policy.name, flow: policy.flow }
  : null);

// An API without a policy behaves like a new one: it returns the request it receives.
const apiFlowConfig = (api) => flowConfig(api.policy) || { id: `default:${api.id}`, name: 'Default policy', flow: defaultFlow() };

const loadCatalogProducts = (gateway) => ApiProduct.findAll({
  where: { status: 'published', organizationId: gateway.organizationId, catalogId: gateway.catalogId },
  include: [
    {
      association: 'apis',
      through: { attributes: [] },
      include: [{ association: 'policy' }, { association: 'connection' }],
    },
  ],
  order: [['name', 'ASC']],
});

const connectionConfig = (connection) => {
  const { settings } = connection;
  return {
    id: connection.id,
    name: connection.name,
    connectTimeoutMs: settings.connectTimeoutMs,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    retryOn: settings.retryOn,
    circuitBreaker: settings.circuitBreaker,
    auth: {
      type: settings.auth.type,
      ...(settings.auth.username && { username: settings.auth.username }),
      ...(settings.auth.headerName && { headerName: settings.auth.headerName }),
      ...(settings.auth.type !== 'none' && connection.authSecretSealed && { secret: open(connection.authSecretSealed) }),
    },
    tls: {
      rejectUnauthorized: settings.tls.rejectUnauthorized !== false,
      ...(settings.tls.caPem && { ca: settings.tls.caPem }),
      ...(settings.tls.clientCertificatePem && connection.clientKeySealed && {
        clientCertificate: settings.tls.clientCertificatePem,
        clientKey: open(connection.clientKeySealed),
      }),
      ...(settings.tls.serverName && { serverName: settings.tls.serverName }),
    },
  };
};

const observabilityConfig = (gateway) => {
  const settings = gateway.observability;
  const { offload } = settings;
  return {
    requestLog: settings.requestLog,
    metrics: settings.metrics,
    offload: offload.type === 'none' || !offload.url
      ? { type: 'none' }
      : {
        type: offload.type,
        url: offload.url,
        headers: offload.headerName && gateway.offloadSecretSealed ? { [offload.headerName]: open(gateway.offloadSecretSealed) } : {},
        batchSize: offload.batchSize,
        flushIntervalMs: offload.flushIntervalMs,
        sampleRate: offload.sampleRate,
      },
  };
};

// `gateway` must include `nodes` and `handlers` (with `policy`). Returns { config, hash, problems, problemDetails, summary }.
// problemDetails repeats each problem with a link to the page that fixes it (when there is one).
// Problems block a push; the configuration is still returned for previews.
const buildGatewayConfig = async (gateway) => {
  const pki = await getPki();
  const problems = [];
  const problemDetails = [];
  const addProblem = (message, fix) => {
    problems.push(message);
    problemDetails.push({ message, ...(fix && { href: fix.href, label: fix.label }) });
  };

  // A gateway runs before it serves a catalog: without one (or with nothing published) it gets
  // its ports, observability and admin settings, and answers API calls with 404.
  const products = gateway.catalogId ? await loadCatalogProducts(gateway) : [];

  const apis = new Map();
  for (const product of products) {
    for (const api of product.apis) apis.set(api.id, api);
  }

  // Connections of the APIs and of every Invoke step in the flows this gateway runs.
  const flowConnectionIds = new Set([
    ...[...apis.values()].flatMap((api) => (api.policy ? connectionIdsOf(api.policy.flow) : [])),
    ...(gateway.handlers || []).flatMap((handler) => (handler.policy ? connectionIdsOf(handler.policy.flow) : [])),
  ]);
  const flowConnections = flowConnectionIds.size
    ? await Connection.findAll({ where: { id: [...flowConnectionIds], organizationId: gateway.organizationId } })
    : [];
  const connections = new Map(flowConnections.map((connection) => [connection.id, connectionConfig(connection)]));
  const knownConnections = new Set([...connections.keys(), ...[...apis.values()].filter((api) => api.connection).map((api) => api.connection.id)]);

  // Problems inside a flow block the push; each links to the policy's editor.
  const checkFlow = (policy, usedBy) => {
    if (!policy) return;
    for (const problem of flowProblems(policy.flow, { connectionIds: knownConnections })) {
      if (problem.level !== 'error') continue;
      addProblem(`Policy "${policy.name}" (${usedBy}): ${problem.message}`, { href: `/developer/policies/${policy.id}`, label: `Open ${policy.name}` });
    }
  };
  const checked = new Set();

  // A port policy that validates requests runs for every API, so then they all need their definitions.
  const portsValidate = (gateway.handlers || []).some((handler) => handler.policy && usesContract(handler.policy.flow));

  const basePaths = new Map();
  const apiConfigs = [...apis.values()].map((api) => {
    if (!api.basePath) {
      addProblem(`API "${api.name}" has no gateway base path. Set one on the API's page.`, { href: `/developer/apis/${api.id}#gateway`, label: `Open ${api.name}` });
    } else if (basePaths.has(api.basePath)) {
      addProblem(`APIs "${basePaths.get(api.basePath)}" and "${api.name}" use the same base path ${api.basePath}.`, { href: `/developer/apis/${api.id}#gateway`, label: `Open ${api.name}` });
    } else {
      basePaths.set(api.basePath, api.name);
    }
    const flow = apiFlowConfig(api);
    if (api.policy && !checked.has(api.policy.id)) {
      checked.add(api.policy.id);
      checkFlow(api.policy, `used by ${api.name}`);
    }
    // An Invoke step for "the API's backend" with no URL of its own uses the API's OpenAPI server.
    if (usesBackend(flow.flow) && !isAbsoluteHttpUrl(api.baseUrl)) {
      addProblem(`API "${api.name}" has no backend URL, so the gateway doesn't know which server to call. Set the Backend URL in the Invoke service step of its policy, for example https://orders.internal.example.com.`,
        api.policy ? { href: `/developer/policies/${api.policy.id}`, label: `Edit the flow of ${api.name}` } : undefined);
    }
    if (api.connection) connections.set(api.connection.id, connectionConfig(api.connection));
    return {
      id: api.id,
      name: api.name,
      version: api.version,
      basePath: api.basePath,
      upstreamUrl: isAbsoluteHttpUrl(api.baseUrl) ? api.baseUrl : null,
      connectionId: api.connection ? api.connection.id : null,
      operations: listOperations(api.spec).map(({ method, path }) => ({
        method,
        path,
        ...((portsValidate || usesContract(flow.flow)) && { contract: operationContract(api.spec, path, method) || { parameters: [], body: null } }),
      })),
      flow,
    };
  }).sort(byKey('basePath'));

  // A handler for one node names it; the others run on every node of the cluster.
  const nodeNames = new Map((gateway.nodes || []).map((node) => [node.id, node.name]));
  const handlers = [...(gateway.handlers || [])].sort(byKey('port')).map((handler) => ({
    id: handler.id,
    name: handler.name,
    port: handler.port,
    protocol: handler.protocol,
    ...(handler.nodeId && { nodes: [nodeNames.get(handler.nodeId)].filter(Boolean) }),
    flow: flowConfig(handler.policy),
    ...(handler.protocol === 'https' && {
      tls: { certificate: handler.certificatePem, privateKey: open(handler.privateKeySealed) },
    }),
  }));
  for (const handler of gateway.handlers || []) {
    if (handler.policy && !checked.has(handler.policy.id)) {
      checked.add(handler.policy.id);
      checkFlow(handler.policy, `port ${handler.port}`);
    }
  }
  if (!handlers.length) addProblem('Add at least one connection handler (a port for API traffic).', { href: `/developer/gateways/${gateway.id}#handlers`, label: 'Add a port' });

  const productIds = products.map((product) => product.id);
  const approved = productIds.length
    ? await Subscription.findAll({
      where: { productId: productIds, status: 'approved' },
      include: [{ association: 'application', attributes: ['clientId', 'name'] }],
    })
    : [];
  const byClient = new Map();
  for (const subscription of approved) {
    if (!subscription.application) continue;
    const { clientId, name } = subscription.application;
    if (!byClient.has(clientId)) byClient.set(clientId, { clientId, application: name, productIds: [] });
    byClient.get(clientId).productIds.push(subscription.productId);
  }
  const subscriptions = [...byClient.values()]
    .map((entry) => ({ ...entry, productIds: entry.productIds.sort() }))
    .sort(byKey('clientId'));

  const link = linkSettings();
  const core = {
    schema: SCHEMA,
    gateway: {
      id: gateway.id,
      name: gateway.name,
      publicUrl: gateway.publicUrl,
      nodeCount: Math.max(1, (gateway.nodes || []).length),
    },
    issuer: issuer(),
    audience: AUDIENCE,
    tokenKeys: [{ kid: pki.tokenKey.kid, publicKey: pki.tokenKey.publicKeyPem }],
    handlers,
    connections: [...connections.values()].sort(byKey('id')),
    apis: apiConfigs,
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      apiIds: product.apis.map((api) => api.id).sort(),
      rateLimit: {
        enabled: product.rateLimitEnabled,
        requests: product.rateLimitRequests,
        period: product.rateLimitPeriod,
      },
    })),
    subscriptions,
    observability: observabilityConfig(gateway),
    admin: { enabled: gateway.observability.adminUi.enabled !== false },
    management: { linkUrl: link.enabled ? link.publicUrl : null },
  };

  const hash = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
  return {
    config: { ...core, version: hash.slice(0, 12), generatedAt: new Date().toISOString() },
    hash,
    problems,
    problemDetails,
    summary: {
      products: core.products.length,
      apis: core.apis.length,
      subscriptions: core.subscriptions.length,
      handlers: core.handlers.length,
    },
  };
};

// Safe to show in the console: private keys and secrets removed.
const redactConfig = (config) => ({
  ...config,
  handlers: config.handlers.map((handler) => (handler.tls
    ? { ...handler, tls: { certificate: handler.tls.certificate, privateKey: REDACTED } }
    : handler)),
  connections: config.connections.map((connection) => ({
    ...connection,
    auth: connection.auth.secret ? { ...connection.auth, secret: REDACTED } : connection.auth,
    tls: connection.tls.clientKey ? { ...connection.tls, clientKey: REDACTED } : connection.tls,
  })),
  observability: {
    ...config.observability,
    offload: config.observability.offload.headers
      ? { ...config.observability.offload, headers: Object.fromEntries(Object.keys(config.observability.offload.headers).map((name) => [name, REDACTED])) }
      : config.observability.offload,
  },
});

// 'no_nodes' | 'not_deployed' | 'error' | 'warning' | 'outdated' | 'deployed'
// Push nodes are judged by their last push; pull nodes by the version they last reported.
const deploymentState = (gateway, hash) => {
  const nodes = gateway.nodes || [];
  if (!nodes.length) return 'no_nodes';
  const version = hash.slice(0, 12);
  const pushNodes = nodes.filter((node) => node.mode !== 'pull');
  const pullNodes = nodes.filter((node) => node.mode === 'pull');
  if (pushNodes.length && !gateway.lastPushedAt && !pullNodes.some((node) => node.configVersion === version)) return 'not_deployed';
  if (pushNodes.some((node) => node.lastPushStatus === 'error')) return 'error';
  if (pushNodes.length && gateway.lastPushedHash !== hash) return 'outdated';
  if (pullNodes.some((node) => node.configVersion !== version)) return 'outdated';
  if (pushNodes.some((node) => node.lastPushStatus === 'warning')) return 'warning';
  if (pushNodes.some((node) => !node.lastPushStatus)) return 'outdated';
  return 'deployed';
};

module.exports = { buildGatewayConfig, redactConfig, deploymentState, connectionConfig, SCHEMA };
