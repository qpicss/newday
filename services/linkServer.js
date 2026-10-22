// The console side of the gateway link: an mTLS listener (separate from the web console) that only
// accepts gateway certificates issued by the management CA and not revoked.
//
//   POST /v1/register      a node announces itself (pull nodes appear in the console automatically)
//   GET  /v1/config        the gateway's configuration (ETag = version; 304 when unchanged)
//   POST /v1/heartbeat     node status; answers whether renewed credentials are waiting
//   GET  /v1/credentials   the latest renewed credentials
//   POST /v1/usage         usage counters
//   POST /v1/admin-login   checks an org admin's email and password for the gateway admin UI
//   GET  /v1/tasks         long poll for work from the console (flow tests); 204 when there is none
//   POST /v1/tasks/:id/result  the result of a task
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { GatewayNode, GatewayCredential, User, Organization, Membership } = require('../models');
const { getPki } = require('../utils/pki');
const { open } = require('../utils/secretBox');
const { buildGatewayConfig } = require('./gatewayConfig');
const { recordUsage } = require('./usage');
const { loadGateway } = require('./gatewayQueries');
const { linkSettings } = require('../utils/linkSettings');
const { nextTask, completeTask } = require('./linkTasks');

const NODE_NAME = /^[\w.:@-]{1,100}$/;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

// Constant work for unknown emails so response time does not reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const advertisedOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

const createLinkApp = ({ logger = console } = {}) => {
  const app = express();
  const loginFailures = new Map();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // Identify the gateway from its client certificate.
  app.use(async (req, res, next) => {
    try {
      const cert = req.socket.getPeerCertificate();
      const commonName = cert?.subject?.CN || '';
      if (!req.client.authorized || !commonName.startsWith('gateway:')) {
        return res.status(403).json({ error: 'A gateway certificate is required' });
      }
      const gatewayId = commonName.slice('gateway:'.length);
      const gateway = await loadGateway({ id: gatewayId });
      if (!gateway) return res.status(404).json({ error: 'This gateway no longer exists in the console' });

      let credential = await GatewayCredential.findOne({ where: { fingerprint: cert.fingerprint256 } });
      if (credential && (credential.gatewayId !== gateway.id || credential.revokedAt)) {
        return res.status(403).json({ error: 'This certificate has been revoked. Renew or download new credentials.' });
      }
      // Certificates issued before credentials were tracked are recorded on first use.
      if (!credential) {
        const x509 = new crypto.X509Certificate(cert.raw);
        credential = await GatewayCredential.create({
          gatewayId: gateway.id,
          serialNumber: x509.serialNumber,
          fingerprint: x509.fingerprint256,
          validTo: new Date(x509.validTo),
          source: 'download',
        });
      }
      req.gateway = gateway;
      req.fingerprint = cert.fingerprint256;
      next();
    } catch (error) {
      next(error);
    }
  });

  const findOrCreateNode = async (req, nodeName) => {
    if (!NODE_NAME.test(String(nodeName || ''))) return null;
    let node = req.gateway.nodes.find((candidate) => candidate.name === nodeName);
    if (!node) {
      const url = advertisedOrigin(req.body?.advertiseUrl);
      node = await GatewayNode.create({ gatewayId: req.gateway.id, name: nodeName, url, mode: url ? 'push' : 'pull' });
      logger.info?.(`gateway node registered: ${req.gateway.name} / ${nodeName}`);
    }
    return node;
  };

  app.post('/v1/register', async (req, res, next) => {
    try {
      const node = await findOrCreateNode(req, req.body?.nodeName);
      if (!node) return res.status(400).json({ error: 'nodeName must be 1-100 letters, digits, ".", "-", "_", ":" or "@"' });
      await node.update({
        lastSeenAt: new Date(),
        softwareVersion: String(req.body.softwareVersion || '').slice(0, 40) || node.softwareVersion,
        configVersion: req.body.version ?? node.configVersion,
        certificateFingerprint: req.fingerprint,
      });
      res.json({ nodeId: node.id, gatewayId: req.gateway.id, gatewayName: req.gateway.name });
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/config', async (req, res, next) => {
    try {
      const { config, problems } = await buildGatewayConfig(req.gateway);
      if (problems.length) return res.status(409).json({ error: problems.join(' ') });
      res.set('ETag', `"${config.version}"`);
      if (req.get('if-none-match') === `"${config.version}"`) return res.status(304).end();
      res.json({ config });
    } catch (error) {
      next(error);
    }
  });

  // Latest renewal that the node is not using yet.
  const pendingRenewal = async (gatewayId, fingerprint) => {
    const latest = await GatewayCredential.findOne({
      where: { gatewayId, source: 'renewal', revokedAt: null },
      order: [['createdAt', 'DESC']],
    });
    return latest && latest.bundleSealed && latest.fingerprint !== fingerprint ? latest : null;
  };

  app.post('/v1/heartbeat', async (req, res, next) => {
    try {
      const node = await findOrCreateNode(req, req.body?.nodeName);
      if (!node) return res.status(400).json({ error: 'nodeName is required' });
      await node.update({
        lastSeenAt: new Date(),
        configVersion: req.body.version ?? node.configVersion,
        softwareVersion: String(req.body.softwareVersion || '').slice(0, 40) || node.softwareVersion,
        certificateFingerprint: req.fingerprint,
      });
      res.json({ renewalAvailable: Boolean(await pendingRenewal(req.gateway.id, req.fingerprint)) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/credentials', async (req, res, next) => {
    try {
      const renewal = await pendingRenewal(req.gateway.id, req.fingerprint);
      if (!renewal) return res.status(404).json({ error: 'No renewed credentials are waiting' });
      res.set('Cache-Control', 'no-store');
      res.json({ credentials: JSON.parse(open(renewal.bundleSealed)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/usage', async (req, res, next) => {
    try {
      const stored = await recordUsage(req.gateway, Array.isArray(req.body?.records) ? req.body.records.slice(0, 50000) : []);
      res.json({ stored });
    } catch (error) {
      next(error);
    }
  });

  // Only admins of the organization that owns this gateway (and platform admins) may use its admin UI.
  app.post('/v1/admin-login', async (req, res, next) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const key = `${req.gateway.id}:${email}`;
      const record = loginFailures.get(key);
      if (record && record.resetAt > Date.now() && record.count >= LOGIN_MAX_FAILURES) {
        return res.status(429).json({ error: 'Too many failed sign-ins for this account. Try again later.' });
      }

      const user = email ? await User.findOne({ where: { email } }) : null;
      const passwordOk = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
      const membership = user && passwordOk
        ? await Membership.findOne({ where: { userId: user.id, organizationId: req.gateway.organizationId } })
        : null;
      const allowed = user && passwordOk && (membership?.role === 'admin' || user.role === 'admin');
      if (!allowed) {
        const entry = record && record.resetAt > Date.now() ? record : { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
        entry.count += 1;
        loginFailures.set(key, entry);
        return res.status(401).json({ error: 'invalid credentials' });
      }
      loginFailures.delete(key);
      const organization = await Organization.findByPk(req.gateway.organizationId, { attributes: ['name'] });
      logger.info?.(`gateway admin UI sign-in: ${user.email} on ${req.gateway.name} (${req.body?.nodeName || 'unknown node'})`);
      res.json({ user: { id: user.id, name: user.name, email: user.email, organization: organization?.name || '' } });
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/tasks', async (req, res, next) => {
    try {
      const nodeName = String(req.query.node || '');
      if (!NODE_NAME.test(nodeName)) return res.status(400).json({ error: 'node must name the polling node' });
      const waitMs = Math.max(1, Math.min(30, Number(req.query.wait) || 25)) * 1000;
      const { promise, cancel } = nextTask(req.gateway.id, nodeName, waitMs);
      res.on('close', cancel);
      const task = await promise;
      if (res.writableEnded || res.destroyed) return undefined;
      if (!task) return res.status(204).end();
      res.json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/tasks/:id/result', (req, res) => {
    if (!completeTask(req.gateway.id, req.params.id, req.body?.result)) return res.status(404).json({ error: 'Unknown or expired task' });
    res.status(204).end();
  });

  app.use((req, res) => res.status(404).json({ error: 'Unknown link endpoint' }));
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ error: 'The console could not complete the request' });
  });
  return app;
};

const startLinkServer = async ({ port, host } = linkSettings(), options = {}) => {
  const pki = await getPki();
  const server = https.createServer({
    key: pki.link.privateKeyPem,
    cert: pki.link.certificatePem,
    ca: [pki.ca.certificatePem],
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  }, createLinkApp(options));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
};

module.exports = { createLinkApp, startLinkServer };
