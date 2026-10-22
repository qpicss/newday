// Backend connections: timeouts, retries, circuit breaker, credentials and TLS for reaching upstreams.
const crypto = require('crypto');
const { Api, Connection } = require('../models');
const { sendServerError } = require('../utils/http');
const { seal } = require('../utils/secretBox');

const AUTH_TYPES = ['none', 'basic', 'bearer', 'header'];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

const certificateInfo = (pem) => {
  try {
    const cert = new crypto.X509Certificate(pem);
    return { subject: cert.subject.replace(/\n/g, ', '), issuer: cert.issuer.replace(/\n/g, ', '), validTo: cert.validTo, fingerprint: cert.fingerprint256 };
  } catch {
    return null;
  }
};

const serializeConnection = (connection) => {
  const { settings } = connection;
  return {
    id: connection.id,
    name: connection.name,
    connectTimeoutMs: settings.connectTimeoutMs,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    retryOn: settings.retryOn,
    circuitBreaker: settings.circuitBreaker,
    auth: { type: settings.auth.type, username: settings.auth.username, headerName: settings.auth.headerName, hasSecret: Boolean(connection.authSecretSealed) },
    tls: {
      rejectUnauthorized: settings.tls.rejectUnauthorized,
      serverName: settings.tls.serverName,
      ca: settings.tls.caPem ? certificateInfo(settings.tls.caPem) : null,
      clientCertificate: settings.tls.clientCertificatePem ? certificateInfo(settings.tls.clientCertificatePem) : null,
    },
    ...(connection.apis && { apis: connection.apis.map((api) => ({ id: api.id, name: api.name })) }),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
};

const integer = (value, min, max, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be a whole number between ${min} and ${max}`);
  }
  return number;
};

// Builds the new settings and secrets from a request body on top of the current ones.
const applyInput = (body, current, { create = false } = {}) => {
  const settings = JSON.parse(JSON.stringify(current.settings || Connection.DEFAULT_SETTINGS));
  const secrets = {};
  const result = { settings, secrets };

  if (create || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) throw new Error('Connection name is required (max 255 characters)');
    result.name = name;
  }
  if (body.connectTimeoutMs !== undefined) settings.connectTimeoutMs = integer(body.connectTimeoutMs, 100, 60000, 'Connect timeout');
  if (body.timeoutMs !== undefined) settings.timeoutMs = integer(body.timeoutMs, 100, 300000, 'Response timeout');
  if (body.retries !== undefined) settings.retries = integer(body.retries, 0, 5, 'Retries');
  if (body.retryOn !== undefined) {
    const list = Array.isArray(body.retryOn) ? body.retryOn : String(body.retryOn).split(/[\s,]+/).filter(Boolean);
    settings.retryOn = [...new Set(list.map((status) => integer(status, 400, 599, 'Retry status codes')))].sort();
  }
  if (body.circuitBreaker !== undefined) {
    const breaker = body.circuitBreaker || {};
    settings.circuitBreaker = {
      enabled: breaker.enabled === true || breaker.enabled === 'true' || breaker.enabled === 'on',
      failureThreshold: integer(breaker.failureThreshold ?? settings.circuitBreaker.failureThreshold, 1, 100, 'Failure threshold'),
      cooldownMs: integer(breaker.cooldownMs ?? settings.circuitBreaker.cooldownMs, 1000, 600000, 'Cooldown'),
    };
  }
  if (body.auth !== undefined) {
    const auth = body.auth || {};
    if (!AUTH_TYPES.includes(auth.type)) throw new Error('Authentication must be none, basic, bearer or header');
    settings.auth = { type: auth.type, username: null, headerName: null };
    if (auth.type === 'basic') {
      if (typeof auth.username !== 'string' || !auth.username.trim()) throw new Error('Basic authentication needs a username');
      settings.auth.username = auth.username.trim();
    }
    if (auth.type === 'header') {
      if (!HEADER_NAME.test(String(auth.headerName || ''))) throw new Error('Enter a valid header name, e.g. x-api-key');
      settings.auth.headerName = auth.headerName.trim().toLowerCase();
    }
    if (auth.type === 'none') {
      secrets.authSecretSealed = null;
    } else if (typeof auth.secret === 'string' && auth.secret) {
      if (auth.secret.length > 4096 || /[\r\n]/.test(auth.secret)) throw new Error('The secret must be a single line of at most 4096 characters');
      secrets.authSecretSealed = seal(auth.secret);
    } else if (!current.authSecretSealed) {
      throw new Error(auth.type === 'basic' ? 'Enter the password' : 'Enter the secret value');
    }
  }
  if (body.tls !== undefined) {
    const tls = body.tls || {};
    settings.tls.rejectUnauthorized = !(tls.rejectUnauthorized === false || tls.rejectUnauthorized === 'false');
    settings.tls.serverName = typeof tls.serverName === 'string' && tls.serverName.trim() ? tls.serverName.trim().slice(0, 253) : null;
    if (tls.caPem !== undefined) {
      if (!tls.caPem) settings.tls.caPem = null;
      else if (!certificateInfo(tls.caPem)) throw new Error('The CA certificate must be PEM (-----BEGIN CERTIFICATE-----)');
      else settings.tls.caPem = tls.caPem.trim();
    }
    if (tls.removeClientCertificate) {
      settings.tls.clientCertificatePem = null;
      secrets.clientKeySealed = null;
    } else if (tls.clientCertificatePem || tls.clientKeyPem) {
      try {
        const cert = new crypto.X509Certificate(tls.clientCertificatePem);
        if (!cert.checkPrivateKey(crypto.createPrivateKey(tls.clientKeyPem))) throw new Error('mismatch');
      } catch {
        throw new Error('Paste a PEM client certificate and its matching PEM private key');
      }
      settings.tls.clientCertificatePem = tls.clientCertificatePem.trim();
      secrets.clientKeySealed = seal(tls.clientKeyPem.trim());
    }
  }
  return result;
};

const findOrgConnection = (req, options = {}) => Connection.findOne({
  where: { id: req.params.id, organizationId: req.user.organizationId },
  ...options,
});

const apisInclude = { association: 'apis', attributes: ['id', 'name'] };

const listConnections = async (req, res) => {
  try {
    const connections = await Connection.findAll({
      where: { organizationId: req.user.organizationId },
      include: [apisInclude],
      order: [['name', 'ASC']],
    });
    res.json({ connections: connections.map(serializeConnection) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load connections');
  }
};

const createConnection = async (req, res) => {
  let input;
  try {
    input = applyInput(req.body || {}, {}, { create: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const connection = await Connection.create({
      organizationId: req.user.organizationId,
      name: input.name,
      settings: input.settings,
      ...input.secrets,
    });
    connection.apis = [];
    res.status(201).json({ connection: serializeConnection(connection) });
  } catch (error) {
    sendServerError(res, error, 'Failed to create connection');
  }
};

const getConnection = async (req, res) => {
  try {
    const connection = await findOrgConnection(req, { include: [apisInclude] });
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    res.json({ connection: serializeConnection(connection) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load connection');
  }
};

const updateConnection = async (req, res) => {
  try {
    const connection = await findOrgConnection(req, { include: [apisInclude] });
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    let input;
    try {
      input = applyInput(req.body || {}, connection);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    await connection.update({ ...(input.name && { name: input.name }), settings: input.settings, ...input.secrets });
    res.json({ connection: serializeConnection(connection) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update connection');
  }
};

// APIs using the connection fall back to the default settings.
const deleteConnection = async (req, res) => {
  try {
    const connection = await findOrgConnection(req);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    await Api.update({ connectionId: null }, { where: { connectionId: connection.id, organizationId: req.user.organizationId } });
    await connection.destroy();
    res.json({ message: 'Connection deleted' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete connection');
  }
};

module.exports = {
  serializeConnection,
  listConnections,
  createConnection,
  getConnection,
  updateConnection,
  deleteConnection,
};
