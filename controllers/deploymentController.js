// Catalogs (sets of products) and gateways: nodes, connection handlers, observability settings,
// credentials (download, renew, revoke), pushes, status, live requests and usage.
const crypto = require('crypto');
const sequelize = require('../config/database');
const {
  Api,
  ApiProduct,
  Catalog,
  Gateway,
  GatewayCredential,
  GatewayNode,
  GatewayHandler,
  Policy,
} = require('../models');
const { sendServerError } = require('../utils/http');
const { optionalText } = require('../utils/validation');
const { seal } = require('../utils/secretBox');
const { issueGatewayCredentials, issueHandlerCertificate } = require('../utils/pki');
const { slugify } = require('../utils/basePath');
const { buildGatewayConfig, redactConfig, deploymentState } = require('../services/gatewayConfig');
const {
  pushGateway,
  gatewayStatus,
  isGatewayRunning,
  renewGatewayCredentials,
  collectUsage,
  recentRequests,
} = require('../services/gatewayPush');
const { gatewayIncludes } = require('../services/gatewayQueries');
const { checkGateway } = require('../services/gatewayMonitor');
const { signAdminTicket } = require('../utils/gatewayTokens');
const { getPki } = require('../utils/pki');
const { usageSeries } = require('../services/usage');
const { gatewaySetup } = require('../utils/gatewaySetup');
const {
  NODE_NAME, MAX_PORT_OFFSET, nodeHost, containerPorts, isPull, nodeAddresses, clusterAddresses, nextPortOffset,
} = require('../services/gatewayNodes');

const OFFLOAD_TYPES = ['none', 'http', 'otlp'];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const EXPIRY_WARNING_DAYS = 30;

const requiredName = (value, label) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 255) return { error: `${label} is required (max 255 characters)` };
  return { value: name };
};

const parseUrl = (value, { https: httpsOnly = false } = {}) => {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || (httpsOnly && url.protocol !== 'https:')) return null;
    return url;
  } catch {
    return null;
  }
};

const findOrgGateway = (req, id = req.params.id) => Gateway.findOne({
  where: { id, organizationId: req.user.organizationId },
  include: gatewayIncludes,
});

const findOrgCatalog = (req, id = req.params.id) => Catalog.findOne({
  where: { id, organizationId: req.user.organizationId },
});

const findOrgPolicy = async (req, policyId) => {
  if (policyId === undefined) return { value: undefined };
  if (policyId === null || policyId === '') return { value: null };
  const policy = await Policy.findOne({ where: { id: policyId, organizationId: req.user.organizationId } });
  return policy ? { value: policy.id } : { error: "Choose one of your organization's policies" };
};

// A host name or an IP address (v4 or v6), without scheme or port.
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$|^[0-9A-Fa-f:]{2,39}$/;

const parseHost = (value) => {
  if (value === undefined) return { value: undefined };
  const host = typeof value === 'string' ? value.trim().replace(/^\[|\]$/g, '') : '';
  if (!host) return { value: null };
  return HOST.test(host) ? { value: host.toLowerCase() } : { error: 'Host must be a host name or an IP address, for example 10.0.0.5 or gw1.example.com, without https:// or a port' };
};

const parseOffset = (value) => {
  if (value === undefined || value === '' || value === null) return { value: undefined };
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PORT_OFFSET) return { error: `Port offset must be a whole number from 0 to ${MAX_PORT_OFFSET}` };
  return { value: offset };
};

const plain = (item) => (typeof item.get === 'function' ? item.get({ plain: true }) : item);

// Two nodes on one host can't publish the same host port. Takes the nodes and handlers as they
// would be after a change; returns a message or null. Only pull nodes are checked: the console
// writes their start commands, while a push node was started with ports the console doesn't know.
const hostPortClash = (gateway, nodes, handlers) => {
  const view = { name: gateway.name, publicUrl: gateway.publicUrl, observability: gateway.observability, nodes: nodes.map(plain), handlers: handlers.map(plain) };
  const seen = new Map(); // "host|port" -> node name
  for (const node of view.nodes.filter(isPull)) {
    const host = nodeHost(view, node);
    for (const port of containerPorts(view, node, { pull: isPull(node) })) {
      const hostPort = port + (node.portOffset || 0);
      const key = `${host}|${hostPort}`;
      if (seen.has(key) && seen.get(key) !== node.name) {
        return `Nodes ${seen.get(key)} and ${node.name} would both use port ${hostPort} on ${host}. Give one of them another port offset, or run it on another server.`;
      }
      seen.set(key, node.name);
    }
  }
  return null;
};

// A handler port is taken when another handler uses it on the same node, or on every node.
const handlerPortTaken = (gateway, { port, nodeId, exceptId = null }) => gateway.handlers.find((handler) => handler.id !== exceptId
  && handler.port === port && (!handler.nodeId || !nodeId || handler.nodeId === nodeId));

const findNodeOf = (gateway, nodeId) => {
  if (nodeId === undefined) return { value: undefined };
  if (nodeId === null || nodeId === '') return { value: null };
  const node = gateway.nodes.find((item) => item.id === nodeId);
  return node ? { value: node.id } : { error: 'Choose one of the nodes of this gateway, or every node' };
};

const daysUntil = (date) => Math.floor((new Date(date).getTime() - Date.now()) / 86400000);

const certificateInfo = (pem) => {
  const cert = new crypto.X509Certificate(pem);
  return { subject: cert.subject, subjectAltName: cert.subjectAltName, validTo: cert.validTo, fingerprint: cert.fingerprint256, daysLeft: daysUntil(cert.validTo) };
};

const serializeHandler = (handler) => ({
  id: handler.id,
  name: handler.name,
  port: handler.port,
  protocol: handler.protocol,
  tlsMode: handler.tlsMode,
  nodeId: handler.nodeId || null,
  policy: handler.policy ? { id: handler.policy.id, name: handler.policy.name } : null,
  certificate: handler.certificatePem ? certificateInfo(handler.certificatePem) : null,
});

const serializeNode = (node, fingerprints = new Map()) => ({
  id: node.id,
  name: node.name,
  url: node.url,
  mode: node.mode,
  host: node.host || null,
  portOffset: node.portOffset || 0,
  lastPushStatus: node.lastPushStatus,
  lastPushAt: node.lastPushAt,
  lastSeenAt: node.lastSeenAt,
  lastError: node.lastError,
  configVersion: node.configVersion,
  softwareVersion: node.softwareVersion,
  certificate: node.certificateFingerprint ? (fingerprints.get(node.certificateFingerprint) || { fingerprint: node.certificateFingerprint, unknown: true }) : null,
});

const serializeCredential = (credential, nodes = []) => ({
  id: credential.id,
  serialNumber: credential.serialNumber,
  fingerprint: credential.fingerprint,
  validTo: credential.validTo,
  daysLeft: daysUntil(credential.validTo),
  source: credential.source,
  issuedAt: credential.createdAt,
  revokedAt: credential.revokedAt,
  usedBy: nodes.filter((node) => node.certificateFingerprint === credential.fingerprint).map((node) => node.name),
});

const serializeObservability = (gateway) => {
  const settings = gateway.observability;
  return { ...settings, offload: { ...settings.offload, hasHeaderValue: Boolean(gateway.offloadSecretSealed) } };
};

// Expiry warnings for the gateway's certificates (credentials in use and HTTPS handlers).
const certificateWarnings = (gateway, credentials) => {
  const warnings = [];
  const inUse = new Set(gateway.nodes.map((node) => node.certificateFingerprint).filter(Boolean));
  for (const credential of credentials) {
    if (credential.revokedAt) continue;
    const days = daysUntil(credential.validTo);
    const used = inUse.has(credential.fingerprint) || !inUse.size;
    if (used && days <= EXPIRY_WARNING_DAYS) {
      warnings.push(days < 0
        ? `A gateway certificate expired on ${new Date(credential.validTo).toDateString()}. Renew the credentials.`
        : `A gateway certificate expires in ${days} day${days === 1 ? '' : 's'}. Renew the credentials.`);
    }
  }
  for (const handler of gateway.handlers || []) {
    if (!handler.certificatePem) continue;
    const days = certificateInfo(handler.certificatePem).daysLeft;
    if (days <= EXPIRY_WARNING_DAYS) {
      warnings.push(`The certificate of handler "${handler.name}" (port ${handler.port}) ${days < 0 ? 'has expired' : `expires in ${days} day${days === 1 ? '' : 's'}`}. Remove and add the handler again to issue a new one.`);
    }
  }
  return [...new Set(warnings)];
};

const serializeGateway = (gateway, extra = {}) => ({
  id: gateway.id,
  name: gateway.name,
  publicUrl: gateway.publicUrl,
  autoPush: gateway.autoPush,
  catalog: gateway.catalog ? { id: gateway.catalog.id, name: gateway.catalog.name } : null,
  nodes: (gateway.nodes || []).map((node) => serializeNode(node, extra.fingerprints)),
  handlers: (gateway.handlers || []).map(serializeHandler),
  observability: serializeObservability(gateway),
  lastPushedAt: gateway.lastPushedAt,
  credentialsIssuedAt: gateway.credentialsIssuedAt,
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'fingerprints')),
});

// Full view of a gateway with deployment state, problems, credentials and warnings.
const describeGateway = async (gateway) => {
  const { hash, problems, problemDetails, summary, config } = await buildGatewayConfig(gateway);
  const credentials = await GatewayCredential.findAll({ where: { gatewayId: gateway.id }, order: [['createdAt', 'DESC']] });
  const fingerprints = new Map(credentials.map((credential) => [credential.fingerprint, {
    fingerprint: credential.fingerprint, validTo: credential.validTo, revoked: Boolean(credential.revokedAt),
  }]));
  return serializeGateway(gateway, {
    state: deploymentState(gateway, hash),
    version: config.version,
    problems,
    problemDetails,
    summary,
    fingerprints,
    credentials: credentials.map((credential) => serializeCredential(credential, gateway.nodes)),
    warnings: certificateWarnings(gateway, credentials),
    addresses: {
      cluster: clusterAddresses(gateway, config.apis),
      nodes: Object.fromEntries(gateway.nodes.map((node) => [node.id, nodeAddresses(gateway, node, config.apis)])),
    },
  });
};

// ------------------------------------------------------------------ Catalogs

const listCatalogs = async (req, res) => {
  try {
    const catalogs = await Catalog.findAll({
      where: { organizationId: req.user.organizationId },
      include: [
        { association: 'products', attributes: ['id', 'name', 'status'] },
        { association: 'apis', attributes: ['id', 'name'] },
        { association: 'gateways', attributes: ['id', 'name'] },
      ],
      order: [['name', 'ASC']],
    });
    res.json({
      catalogs: catalogs.map((catalog) => ({
        id: catalog.id,
        name: catalog.name,
        description: catalog.description,
        products: catalog.products.map((product) => ({ id: product.id, name: product.name, status: product.status })),
        apis: catalog.apis.map((api) => ({ id: api.id, name: api.name })),
        gateways: catalog.gateways.map((gateway) => ({ id: gateway.id, name: gateway.name })),
      })),
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to load catalogs');
  }
};

const validateCatalog = (body = {}, { partial = false } = {}) => {
  const fields = {};
  if (!partial || body.name !== undefined) {
    const { value, error } = requiredName(body.name, 'Catalog name');
    if (error) return { error };
    fields.name = value;
  }
  if (body.description !== undefined) {
    const { value, error } = optionalText(body.description, 'Description', 2000);
    if (error) return { error };
    fields.description = value;
  }
  return { fields };
};

const createCatalog = async (req, res) => {
  try {
    const { fields, error } = validateCatalog(req.body);
    if (error) return res.status(400).json({ error });
    const catalog = await Catalog.create({ ...fields, organizationId: req.user.organizationId });
    res.status(201).json({ catalog: { id: catalog.id, name: catalog.name, description: catalog.description } });
  } catch (error) {
    sendServerError(res, error, 'Failed to create catalog');
  }
};

const updateCatalog = async (req, res) => {
  try {
    const catalog = await findOrgCatalog(req);
    if (!catalog) return res.status(404).json({ error: 'Catalog not found' });
    const { fields, error } = validateCatalog(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    await catalog.update(fields);
    res.json({ catalog: { id: catalog.id, name: catalog.name, description: catalog.description } });
  } catch (error) {
    sendServerError(res, error, 'Failed to update catalog');
  }
};

const deleteCatalog = async (req, res) => {
  try {
    const catalog = await findOrgCatalog(req);
    if (!catalog) return res.status(404).json({ error: 'Catalog not found' });
    const gateways = await Gateway.count({ where: { catalogId: catalog.id } });
    if (gateways) {
      return res.status(409).json({ error: 'A gateway still serves this catalog. Detach it first.' });
    }
    const [products, apis] = await Promise.all([
      ApiProduct.count({ where: { catalogId: catalog.id } }),
      Api.count({ where: { catalogId: catalog.id } }),
    ]);
    if (products || apis) {
      return res.status(409).json({ error: `The catalog still has ${products} product${products === 1 ? '' : 's'} and ${apis} API${apis === 1 ? '' : 's'}. Delete them first.` });
    }
    await catalog.destroy();
    res.json({ message: 'Catalog deleted' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete catalog');
  }
};

// Pushes the catalog to every gateway that serves it.
const pushCatalog = async (req, res) => {
  try {
    const catalog = await findOrgCatalog(req);
    if (!catalog) return res.status(404).json({ error: 'Catalog not found' });
    const gateways = await Gateway.findAll({
      where: { catalogId: catalog.id, organizationId: req.user.organizationId },
      include: gatewayIncludes,
    });
    if (!gateways.length) return res.status(400).json({ error: 'No gateway serves this catalog yet' });
    const results = [];
    for (const gateway of gateways) {
      results.push({ gateway: { id: gateway.id, name: gateway.name }, ...(await pushGateway(gateway)) });
    }
    res.json({ ok: results.every((result) => result.ok), results });
  } catch (error) {
    sendServerError(res, error, 'Failed to push the catalog');
  }
};

// ------------------------------------------------------------------ Gateways

// `gateway` is the existing gateway on updates. A gateway is attached to a catalog only once it runs.
const validateGateway = async (req, body = {}, { partial = false, gateway = null } = {}) => {
  const fields = {};
  if (!partial || body.name !== undefined) {
    const { value, error } = requiredName(body.name, 'Gateway name');
    if (error) return { error };
    fields.name = value;
  }
  if (!partial || body.publicUrl !== undefined) {
    const url = parseUrl(body.publicUrl);
    if (!url) return { error: 'Public URL must be an http(s) address consumers use, for example https://api.example.com' };
    fields.publicUrl = url.href.replace(/\/+$/, '');
  }
  if (body.catalogId !== undefined) {
    if (body.catalogId === null || body.catalogId === '') {
      fields.catalogId = null;
    } else {
      const catalog = await findOrgCatalog(req, body.catalogId);
      if (!catalog) return { error: 'Choose one of your catalogs' };
      if (!gateway) {
        return { error: 'Create the gateway and start a node first, then attach it to a catalog', status: 409 };
      }
      if (gateway.catalogId !== catalog.id && !(await isGatewayRunning(gateway))) {
        return { error: `${gateway.name} is not running. Start a node with its credentials (step 3 on the gateway's page) before attaching it to a catalog.`, status: 409 };
      }
      fields.catalogId = catalog.id;
    }
  }
  if (body.autoPush !== undefined) fields.autoPush = body.autoPush === true || body.autoPush === 'true' || body.autoPush === 'on';
  return { fields };
};

const listGateways = async (req, res) => {
  try {
    const gateways = await Gateway.findAll({
      where: { organizationId: req.user.organizationId },
      include: gatewayIncludes,
      order: [['name', 'ASC']],
    });
    const result = [];
    for (const gateway of gateways) {
      const { hash } = await buildGatewayConfig(gateway);
      result.push(serializeGateway(gateway, { state: deploymentState(gateway, hash) }));
    }
    res.json({ gateways: result });
  } catch (error) {
    sendServerError(res, error, 'Failed to load gateways');
  }
};

const createGateway = async (req, res) => {
  try {
    const { fields, error, status: errorStatus } = await validateGateway(req, req.body);
    if (error) return res.status(errorStatus || 400).json({ error });
    const gateway = await Gateway.create({ ...fields, organizationId: req.user.organizationId });
    res.status(201).json({ gateway: serializeGateway(gateway) });
  } catch (error) {
    sendServerError(res, error, 'Failed to create gateway');
  }
};

const getGateway = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    res.json({ gateway: { ...(await describeGateway(gateway)), setup: gatewaySetup(gateway) } });
  } catch (error) {
    sendServerError(res, error, 'Failed to load gateway');
  }
};

const updateGateway = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const { fields, error, status: errorStatus } = await validateGateway(req, req.body, { partial: true, gateway });
    if (error) return res.status(errorStatus || 400).json({ error });
    await gateway.update(fields);
    await gateway.reload({ include: gatewayIncludes });
    res.json({ gateway: serializeGateway(gateway) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update gateway');
  }
};

const deleteGateway = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    await sequelize.transaction(async (transaction) => {
      await GatewayNode.destroy({ where: { gatewayId: gateway.id }, transaction });
      await GatewayHandler.destroy({ where: { gatewayId: gateway.id }, transaction });
      // Revoke everything issued to it so its certificates can no longer reach the link.
      await GatewayCredential.update({ revokedAt: new Date(), bundleSealed: null }, { where: { gatewayId: gateway.id, revokedAt: null }, transaction });
      await gateway.destroy({ transaction });
    });
    res.json({ message: 'Gateway deleted' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete gateway');
  }
};

const updateObservability = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const body = req.body || {};
    const current = gateway.observability;
    const next = JSON.parse(JSON.stringify(current));
    const updates = {};

    if (body.requestLog) {
      const size = Number(body.requestLog.size ?? current.requestLog.size);
      if (!Number.isInteger(size) || size < 10 || size > 10000) return res.status(400).json({ error: 'Request log size must be between 10 and 10,000' });
      next.requestLog = { enabled: body.requestLog.enabled !== false && body.requestLog.enabled !== 'false', size };
    }
    if (body.metrics) next.metrics = { enabled: body.metrics.enabled !== false && body.metrics.enabled !== 'false' };
    if (body.adminUi) next.adminUi = { enabled: body.adminUi.enabled !== false && body.adminUi.enabled !== 'false' };
    if (body.offload) {
      const offload = body.offload;
      if (!OFFLOAD_TYPES.includes(offload.type)) return res.status(400).json({ error: 'Off-load target must be none, http or otlp' });
      if (offload.type === 'none') {
        next.offload = { ...current.offload, type: 'none' };
      } else {
        const url = parseUrl(offload.url);
        if (!url) return res.status(400).json({ error: 'Enter the off-load URL, for example https://collector.example.com:4318/v1/logs' });
        const headerName = offload.headerName ? String(offload.headerName).trim() : null;
        if (headerName && !HEADER_NAME.test(headerName)) return res.status(400).json({ error: 'Enter a valid header name, e.g. authorization' });
        const batchSize = Number(offload.batchSize ?? current.offload.batchSize);
        const flushIntervalMs = Number(offload.flushIntervalMs ?? current.offload.flushIntervalMs);
        const sampleRate = Number(offload.sampleRate ?? current.offload.sampleRate);
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) return res.status(400).json({ error: 'Batch size must be between 1 and 5,000' });
        if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 500 || flushIntervalMs > 300000) return res.status(400).json({ error: 'Flush interval must be between 500 and 300,000 ms' });
        if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) return res.status(400).json({ error: 'Sample rate must be above 0 and at most 1' });
        next.offload = { type: offload.type, url: url.href, headerName, batchSize, flushIntervalMs, sampleRate };
        if (!headerName) updates.offloadSecretSealed = null;
        else if (typeof offload.headerValue === 'string' && offload.headerValue) {
          if (/[\r\n]/.test(offload.headerValue) || offload.headerValue.length > 4096) return res.status(400).json({ error: 'The header value must be a single line' });
          updates.offloadSecretSealed = seal(offload.headerValue);
        } else if (!gateway.offloadSecretSealed) {
          return res.status(400).json({ error: `Enter the value for the ${headerName} header` });
        }
      }
    }
    await gateway.update({ ...updates, observability: next });
    res.json({ observability: serializeObservability(gateway) });
  } catch (error) {
    sendServerError(res, error, 'Failed to save observability settings');
  }
};

// Adds a node. A pull node (no address) is registered ahead of time, so the console can show the
// command that starts it; it takes over this entry when it connects with the same name. A push node
// is the management address of a node that is already running.
const addNode = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!NODE_NAME.test(name)) {
      return res.status(400).json({ error: 'Node name is required: up to 100 letters, digits, ".", "-", "_", ":" or "@", without spaces (it is also the container name)' });
    }
    if (gateway.nodes.some((node) => node.name === name)) {
      return res.status(409).json({ error: 'This gateway already has a node with that name' });
    }
    const host = parseHost(req.body?.host);
    if (host.error) return res.status(400).json({ error: host.error });
    const offset = parseOffset(req.body?.portOffset);
    if (offset.error) return res.status(400).json({ error: offset.error });

    const fields = { gatewayId: gateway.id, name, host: host.value ?? null };
    if (req.body?.url) {
      const url = parseUrl(req.body.url, { https: true });
      if (!url || url.pathname !== '/' || url.search) {
        return res.status(400).json({ error: 'Node address must be the https:// host and management port of a gateway, for example https://10.0.0.5:9443' });
      }
      if (gateway.nodes.some((node) => node.url === url.origin)) {
        return res.status(409).json({ error: 'This gateway already has a node at that address' });
      }
      Object.assign(fields, { url: url.origin, mode: 'push', portOffset: offset.value ?? 0 });
    } else {
      // Without a host it runs next to the first node (on the same Docker host).
      if (host.value === undefined && gateway.nodes.length) fields.host = nodeHost(gateway, gateway.nodes[0]);
      Object.assign(fields, { url: null, mode: 'pull' });
      const where = nodeHost(gateway, fields);
      const free = offset.value ?? nextPortOffset(gateway, where, { pull: true });
      if (free === null) return res.status(409).json({ error: `No free ports are left on ${where}. Run the node on another server.` });
      fields.portOffset = free;
    }
    const clash = hostPortClash(gateway, [...gateway.nodes, fields], gateway.handlers);
    if (clash) return res.status(409).json({ error: clash });
    const node = await GatewayNode.create(fields);
    // The console connects to a push node: check it now instead of waiting for the monitor.
    let check = null;
    if (!isPull(node)) {
      try {
        const [result] = await checkGateway(gateway, { only: [node] });
        check = result ? { reachable: result.reachable, error: result.error, resent: result.resent } : null;
      } catch {
        check = { reachable: false, error: 'The node could not be checked' };
      }
    }
    res.status(201).json({ node: serializeNode(node), addresses: nodeAddresses(gateway, node), check });
  } catch (error) {
    sendServerError(res, error, 'Failed to add node');
  }
};

// A one-time ticket that signs the current org admin in to a node's admin UI, and the address that
// uses it. The node checks the ticket itself, so this works for nodes that can't reach the console.
const adminTicket = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const node = gateway.nodes.find((item) => item.id === req.params.nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const address = nodeAddresses(gateway, node).admin;
    if (!address) return res.status(409).json({ error: 'The admin UI is turned off for this gateway. Turn it on under Observability, then push the configuration.' });
    const { tokenKey } = await getPki();
    const ticket = signAdminTicket({ user: req.user, organization: req.user.organization, gateway, node }, tokenKey);
    res.json({ url: `${address}/#ticket=${encodeURIComponent(ticket)}`, expiresIn: 60 });
  } catch (error) {
    sendServerError(res, error, 'Failed to open the admin UI');
  }
};

// Changes where a node runs: its host and its port offset.
const updateNode = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const node = gateway.nodes.find((item) => item.id === req.params.nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const host = parseHost(req.body?.host);
    if (host.error) return res.status(400).json({ error: host.error });
    const offset = parseOffset(req.body?.portOffset);
    if (offset.error) return res.status(400).json({ error: offset.error });
    const changes = {
      ...(host.value !== undefined && { host: host.value }),
      ...(offset.value !== undefined && { portOffset: offset.value }),
    };
    const after = gateway.nodes.map((item) => (item.id === node.id ? { ...plain(item), ...changes } : item));
    const clash = hostPortClash(gateway, after, gateway.handlers);
    if (clash) return res.status(409).json({ error: clash });
    await node.update(changes);
    res.json({ node: serializeNode(node), addresses: nodeAddresses(gateway, node) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update node');
  }
};

// Removes a node and the handlers that ran only on it.
const removeNode = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const removed = await sequelize.transaction(async (transaction) => {
      const count = await GatewayNode.destroy({ where: { id: req.params.nodeId, gatewayId: gateway.id }, transaction });
      if (count) await GatewayHandler.destroy({ where: { gatewayId: gateway.id, nodeId: req.params.nodeId }, transaction });
      return count;
    });
    if (!removed) return res.status(404).json({ error: 'Node not found' });
    res.json({ message: 'Node removed' });
  } catch (error) {
    sendServerError(res, error, 'Failed to remove node');
  }
};

const validateCustomCertificate = (certificatePem, privateKeyPem) => {
  try {
    const cert = new crypto.X509Certificate(certificatePem);
    if (!cert.checkPrivateKey(crypto.createPrivateKey(privateKeyPem))) {
      return 'The private key does not belong to the certificate';
    }
    if (new Date(cert.validTo) < new Date()) return 'The certificate has expired';
    return null;
  } catch {
    return 'Paste a PEM certificate (-----BEGIN CERTIFICATE-----) and its PEM private key';
  }
};

const addHandler = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const { value: name, error } = requiredName(req.body?.name, 'Handler name');
    if (error) return res.status(400).json({ error });

    const port = Number(req.body?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'Port must be a whole number between 1 and 65535' });
    }
    const scope = findNodeOf(gateway, req.body?.nodeId);
    if (scope.error) return res.status(400).json({ error: scope.error });
    const nodeId = scope.value ?? null;
    const taken = handlerPortTaken(gateway, { port, nodeId });
    if (taken) {
      return res.status(409).json({ error: `Port ${port} already has the handler "${taken.name}"${taken.nodeId ? ' on that node' : ' on every node'}` });
    }
    const policy = await findOrgPolicy(req, req.body?.policyId);
    if (policy.error) return res.status(400).json({ error: policy.error });
    const protocol = req.body?.protocol === 'https' ? 'https' : 'http';
    const fields = { gatewayId: gateway.id, name, port, protocol, policyId: policy.value ?? null, nodeId };
    const clash = hostPortClash(gateway, gateway.nodes, [...gateway.handlers, fields]);
    if (clash) return res.status(409).json({ error: clash });

    if (protocol === 'https') {
      if (req.body?.tlsMode === 'custom') {
        const certificateError = validateCustomCertificate(req.body.certificatePem, req.body.privateKeyPem);
        if (certificateError) return res.status(400).json({ error: certificateError });
        Object.assign(fields, { tlsMode: 'custom', certificatePem: req.body.certificatePem.trim(), privateKeySealed: seal(req.body.privateKeyPem.trim()) });
      } else {
        // Valid for the gateway's public host and the hosts of the nodes that run the handler.
        const nodes = gateway.nodes.filter((node) => !nodeId || node.id === nodeId);
        const hosts = [new URL(gateway.publicUrl).hostname.replace(/^\[|\]$/g, ''), ...nodes.map((node) => nodeHost(gateway, node)), 'localhost', '127.0.0.1'];
        const { certificatePem, privateKeyPem } = await issueHandlerCertificate([...new Set(hosts)]);
        Object.assign(fields, { tlsMode: 'generated', certificatePem, privateKeySealed: seal(privateKeyPem) });
      }
    }

    const handler = await GatewayHandler.create(fields);
    await handler.reload({ include: [{ association: 'policy' }] });
    res.status(201).json({ handler: serializeHandler(handler) });
  } catch (error) {
    sendServerError(res, error, 'Failed to add handler');
  }
};

// Changes a handler's port policy, or where it runs (every node, or one node).
const updateHandler = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const handler = gateway.handlers.find((item) => item.id === req.params.handlerId);
    if (!handler) return res.status(404).json({ error: 'Handler not found' });
    const policy = await findOrgPolicy(req, req.body?.policyId);
    if (policy.error) return res.status(400).json({ error: policy.error });
    const scope = findNodeOf(gateway, req.body?.nodeId);
    if (scope.error) return res.status(400).json({ error: scope.error });
    if (scope.value !== undefined) {
      const taken = handlerPortTaken(gateway, { port: handler.port, nodeId: scope.value, exceptId: handler.id });
      if (taken) return res.status(409).json({ error: `Port ${handler.port} already has the handler "${taken.name}"${taken.nodeId ? ' on that node' : ' on every node'}` });
      const after = gateway.handlers.map((item) => (item.id === handler.id ? { ...plain(item), nodeId: scope.value } : item));
      const clash = hostPortClash(gateway, gateway.nodes, after);
      if (clash) return res.status(409).json({ error: clash });
    }
    const changes = {
      ...(policy.value !== undefined && { policyId: policy.value }),
      ...(scope.value !== undefined && { nodeId: scope.value }),
    };
    if (Object.keys(changes).length) await handler.update(changes);
    await handler.reload({ include: [{ association: 'policy' }] });
    res.json({ handler: serializeHandler(handler) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update handler');
  }
};

const removeHandler = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const removed = await GatewayHandler.destroy({ where: { id: req.params.handlerId, gatewayId: gateway.id } });
    if (!removed) return res.status(404).json({ error: 'Handler not found' });
    res.json({ message: 'Handler removed' });
  } catch (error) {
    sendServerError(res, error, 'Failed to remove handler');
  }
};

// The credentials file every node of this gateway needs. A new certificate is issued each time.
const downloadCredentials = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const { bundle } = await issueGatewayCredentials(gateway);
    await gateway.update({ credentialsIssuedAt: new Date() });
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="${slugify(gateway.name)}-credentials.json"`);
    res.type('application/json').send(JSON.stringify(bundle, null, 2));
  } catch (error) {
    sendServerError(res, error, 'Failed to issue credentials');
  }
};

const renewCredentials = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const { credential, nodes } = await renewGatewayCredentials(gateway);
    res.json({ credential: serializeCredential(credential, gateway.nodes), nodes });
  } catch (error) {
    sendServerError(res, error, 'Failed to renew credentials');
  }
};

// Revoking a certificate a node still uses cuts that node off, so it needs { force: true }.
const revokeCredential = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const credential = await GatewayCredential.findOne({ where: { id: req.params.credentialId, gatewayId: gateway.id } });
    if (!credential) return res.status(404).json({ error: 'Certificate not found' });
    if (credential.revokedAt) return res.status(409).json({ error: 'This certificate is already revoked' });
    const users = gateway.nodes.filter((node) => node.certificateFingerprint === credential.fingerprint).map((node) => node.name);
    if (users.length && req.body?.force !== true) {
      return res.status(409).json({ error: `Still used by ${users.join(', ')}. Renew the credentials first, or revoke anyway to cut ${users.length === 1 ? 'it' : 'them'} off.`, usedBy: users });
    }
    await credential.update({ revokedAt: new Date(), bundleSealed: null });
    res.json({ credential: serializeCredential(credential, gateway.nodes) });
  } catch (error) {
    sendServerError(res, error, 'Failed to revoke the certificate');
  }
};

const previewConfig = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const { config, problems, summary } = await buildGatewayConfig(gateway);
    res.json({ config: redactConfig(config), problems, summary });
  } catch (error) {
    sendServerError(res, error, 'Failed to build the configuration');
  }
};

const push = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    res.json(await pushGateway(gateway));
  } catch (error) {
    sendServerError(res, error, 'Failed to push the configuration');
  }
};

const status = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    res.json({ nodes: await gatewayStatus(gateway) });
  } catch (error) {
    sendServerError(res, error, 'Failed to check the gateway');
  }
};

const requests = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const { status: statusFilter, api, client, text, limit } = req.query;
    res.json(await recentRequests(gateway, { status: statusFilter, api, client, text, limit: Math.min(500, Number(limit) || 200) }));
  } catch (error) {
    sendServerError(res, error, 'Failed to load requests');
  }
};

const usage = async (req, res) => {
  try {
    const gateway = await findOrgGateway(req);
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    if (req.query.collect === 'true') await collectUsage(gateway);
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    res.json(await usageSeries({ gatewayId: gateway.id }, days));
  } catch (error) {
    sendServerError(res, error, 'Failed to load usage');
  }
};

module.exports = {
  gatewayIncludes,
  serializeGateway,
  describeGateway,
  certificateWarnings,
  listCatalogs,
  createCatalog,
  updateCatalog,
  deleteCatalog,
  pushCatalog,
  listGateways,
  createGateway,
  getGateway,
  updateGateway,
  deleteGateway,
  updateObservability,
  addNode,
  updateNode,
  removeNode,
  adminTicket,
  addHandler,
  updateHandler,
  removeHandler,
  downloadCredentials,
  renewCredentials,
  revokeCredential,
  previewConfig,
  push,
  status,
  requests,
  usage,
};
