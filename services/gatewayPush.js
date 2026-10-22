// Talks to gateway nodes over mTLS. Management presents its client certificate and only accepts a
// node whose certificate (issued by the same self-signed CA, not revoked) names this gateway.
// Pull-mode nodes have no push address; they pick up changes from the link (services/linkServer.js).
const https = require('https');
const { GatewayCredential } = require('../models');
const { getPki, issueGatewayCredentials } = require('../utils/pki');
const { buildGatewayConfig } = require('./gatewayConfig');
const { recordUsage } = require('./usage');
const { runTask, pollingNodes } = require('./linkTasks');

const NODE_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const CERTIFICATE_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_SIGNATURE_FAILURE', 'CERT_HAS_EXPIRED',
]);

const describeError = (error) => {
  if (error.code === 'WRONG_GATEWAY' || error.code === 'REVOKED') return error.message;
  if (error.code === 'ECONNREFUSED') return 'Connection refused. Is the gateway running, and is its management port reachable from this server?';
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return 'Host not found. Check the node address.';
  if (error.code === 'ETIMEDOUT' || error.message === 'timed out') return `No answer within ${NODE_TIMEOUT_MS / 1000} seconds.`;
  if (error.code === 'CERT_HAS_EXPIRED') return 'The node\'s certificate has expired. Download new credentials and restart the node.';
  if (CERTIFICATE_ERRORS.has(error.code)) return 'The node\'s certificate was not issued by this console. Download the gateway credentials again and restart the node.';
  if (error.code === 'ECONNRESET' || /alert|handshake/i.test(error.message)) {
    return 'The node closed the connection during the TLS handshake. It may be using credentials from another console.';
  }
  return error.message;
};

const revokedFingerprints = async (gatewayId) => new Set((await GatewayCredential.findAll({
  where: { gatewayId },
  attributes: ['fingerprint', 'revokedAt'],
})).filter((credential) => credential.revokedAt).map((credential) => credential.fingerprint));

const callNode = (node, gatewayId, pki, { method, path, body, revoked = new Set() }) => new Promise((resolve) => {
  let url;
  try {
    url = new URL(path, node.url);
  } catch {
    resolve({ ok: false, error: 'The node address is not a valid URL' });
    return;
  }

  const payload = body === undefined ? null : JSON.stringify(body);
  let peerFingerprint = null;
  const request = https.request(url, {
    method,
    key: pki.client.privateKeyPem,
    cert: pki.client.certificatePem,
    ca: [pki.ca.certificatePem],
    agent: false,
    timeout: NODE_TIMEOUT_MS,
    minVersion: 'TLSv1.2',
    // Node addresses are often IPs or internal names, so identity is the gateway ID in the certificate.
    checkServerIdentity: (host, cert) => {
      if (cert?.subject?.CN !== `gateway:${gatewayId}`) {
        return Object.assign(new Error(`This address answers with the certificate of ${cert?.subject?.CN || 'an unknown server'}, not this gateway.`), { code: 'WRONG_GATEWAY' });
      }
      if (revoked.has(cert.fingerprint256)) {
        return Object.assign(new Error('The node presents a revoked certificate. Renew or download new credentials for it.'), { code: 'REVOKED' });
      }
      peerFingerprint = cert.fingerprint256;
      return undefined;
    },
    headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
  }, (response) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
    });
    response.on('end', () => {
      let json = null;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // not JSON
      }
      const ok = response.statusCode >= 200 && response.statusCode < 300;
      resolve({
        ok,
        status: response.statusCode,
        body: json,
        fingerprint: peerFingerprint,
        error: ok ? null : (json?.message || `The node answered HTTP ${response.statusCode}`),
      });
    });
  });
  request.on('timeout', () => request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
  request.on('error', (error) => resolve({ ok: false, error: describeError(error) }));
  request.end(payload);
});

const pushNodesOf = (gateway) => gateway.nodes.filter((node) => node.mode !== 'pull' && node.url);

// Builds the configuration and sends it to every push node. `gateway` must include nodes and handlers.
const pushGateway = async (gateway) => {
  const { config, hash, problems, summary } = await buildGatewayConfig(gateway);
  if (!gateway.nodes.length) {
    problems.push('Add at least one node: start a gateway with GATEWAY_MANAGEMENT_URL so it registers itself, or add its management address.');
  }
  if (problems.length) {
    return { ok: false, problems, nodes: [], version: config.version, summary };
  }

  const pki = await getPki();
  const revoked = await revokedFingerprints(gateway.id);
  const pushedAt = new Date();
  const nodes = await Promise.all(gateway.nodes.map(async (node) => {
    if (node.mode === 'pull' || !node.url) {
      return {
        id: node.id,
        name: node.name,
        url: null,
        status: 'pull',
        error: null,
        message: `Pulls its configuration from the console${node.configVersion === config.version ? ' and is up to date' : ' within seconds'}.`,
        handlers: [],
      };
    }
    const result = await callNode(node, gateway.id, pki, { method: 'PUT', path: '/v1/config', body: config, revoked });
    const failedHandlers = result.ok ? (result.body?.handlers || []).filter((handler) => !handler.listening) : [];
    const status = !result.ok ? 'error' : failedHandlers.length ? 'warning' : 'ok';
    const error = !result.ok
      ? result.error
      : failedHandlers.map((handler) => `${handler.name}: ${handler.error}`).join('; ') || null;

    await node.update({
      lastPushAt: pushedAt,
      lastPushStatus: status,
      lastError: error,
      configVersion: result.ok ? result.body?.version : node.configVersion,
      ...(result.fingerprint && { certificateFingerprint: result.fingerprint, lastSeenAt: pushedAt }),
    });
    return { id: node.id, name: node.name, url: node.url, status, error, handlers: result.body?.handlers || [] };
  }));

  const ok = nodes.every((node) => node.status !== 'error');
  if (ok && pushNodesOf(gateway).length) {
    await gateway.update({ lastPushedHash: hash, lastPushedAt: pushedAt });
  }
  return { ok, problems: [], nodes, version: config.version, summary };
};

// Asks every push node for its current state; pull nodes are reported from their last heartbeat.
const gatewayStatus = async (gateway) => {
  const pki = await getPki();
  const revoked = await revokedFingerprints(gateway.id);
  return Promise.all(gateway.nodes.map(async (node) => {
    if (node.mode === 'pull' || !node.url) {
      const recent = node.lastSeenAt && Date.now() - new Date(node.lastSeenAt).getTime() < 120000;
      return {
        id: node.id, name: node.name, url: null, mode: 'pull', reachable: Boolean(recent),
        error: recent ? null : 'No heartbeat in the last 2 minutes',
        status: { version: node.configVersion, lastSeenAt: node.lastSeenAt, softwareVersion: node.softwareVersion },
      };
    }
    const result = await callNode(node, gateway.id, pki, { method: 'GET', path: '/v1/status', revoked });
    if (!result.ok) {
      await node.update({ lastError: result.error });
    } else {
      await node.update({
        lastError: null,
        configVersion: result.body?.version ?? node.configVersion,
        lastSeenAt: new Date(),
        softwareVersion: result.body?.softwareVersion || node.softwareVersion,
        certificateFingerprint: result.fingerprint || node.certificateFingerprint,
      });
    }
    return { id: node.id, name: node.name, url: node.url, mode: 'push', reachable: result.ok, error: result.error, status: result.ok ? result.body : null };
  }));
};

// A gateway is running when at least one node answers now (push) or sent a heartbeat recently (pull).
const isGatewayRunning = async (gateway) => (await gatewayStatus(gateway)).some((node) => node.reachable);

// Issues a new certificate and installs it on every push node. Pull nodes fetch it on their next
// heartbeat. The old certificate stays valid until it is revoked.
const renewGatewayCredentials = async (gateway) => {
  const { bundle, credential } = await issueGatewayCredentials(gateway, { source: 'renewal' });
  await gateway.update({ credentialsIssuedAt: new Date() });
  const pki = await getPki();
  const revoked = await revokedFingerprints(gateway.id);
  const nodes = await Promise.all(gateway.nodes.map(async (node) => {
    if (node.mode === 'pull' || !node.url) {
      return { id: node.id, name: node.name, status: 'pull', error: null };
    }
    const result = await callNode(node, gateway.id, pki, { method: 'PUT', path: '/v1/credentials', body: bundle, revoked });
    if (result.ok) await node.update({ certificateFingerprint: credential.fingerprint });
    return { id: node.id, name: node.name, status: result.ok ? 'ok' : 'error', error: result.error };
  }));
  return { credential, nodes };
};

// Reads (and resets) usage counters on every push node and stores them.
const collectUsage = async (gateway) => {
  const pki = await getPki();
  const revoked = await revokedFingerprints(gateway.id);
  let stored = 0;
  for (const node of pushNodesOf(gateway)) {
    const result = await callNode(node, gateway.id, pki, { method: 'GET', path: '/v1/usage', revoked });
    if (result.ok && result.body?.records?.length) {
      stored += await recordUsage(gateway, result.body.records);
    }
  }
  return stored;
};

// Asks a pull node for its request log over the link.
const pullNodeRequests = async (gateway, node, query) => {
  if (!pollingNodes(gateway.id).includes(node.name)) {
    return { ok: false, error: 'Not connected to the console right now. Is the node running?' };
  }
  const result = await runTask(gateway.id, 'requests', query, { timeoutMs: 10000, node: node.name });
  if (!result) return { ok: false, error: 'Not connected to the console right now. Is the node running?' };
  if (result.status !== 200) return { ok: false, error: result.body?.message || `The node answered HTTP ${result.status}` };
  return { ok: true, body: result.body };
};

// Recent requests from every node, newest first: push nodes are called, pull nodes are asked over the link.
const recentRequests = async (gateway, query = {}) => {
  const pki = await getPki();
  const revoked = await revokedFingerprints(gateway.id);
  const filters = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ''));
  const params = new URLSearchParams(filters).toString();
  const results = await Promise.all(gateway.nodes.map(async (node) => {
    const result = node.mode === 'pull' || !node.url
      ? await pullNodeRequests(gateway, node, filters)
      : await callNode(node, gateway.id, pki, { method: 'GET', path: `/v1/requests${params ? `?${params}` : ''}`, revoked });
    return { node, result };
  }));
  const entries = [];
  const nodes = [];
  for (const { node, result } of results) {
    nodes.push({ name: node.name, mode: node.mode === 'pull' || !node.url ? 'pull' : 'push', reachable: result.ok, error: result.error, enabled: result.body?.enabled });
    if (result.ok) entries.push(...(result.body.entries || []).map((entry) => ({ ...entry, node: node.name })));
  }
  entries.sort((a, b) => (a.time < b.time ? 1 : -1));
  return { entries: entries.slice(0, Number(query.limit) || 200), nodes };
};

// Runs a policy flow on a gateway node (never on the console) against a sample request.
// Push nodes are called directly; pull nodes get the test as a task over their link.
// Resolves to { ok, gateway, node, result } or { ok: false, error, unavailable? }.
const testFlowOnGateway = async (gateways, payload) => {
  const pki = await getPki();
  const attempts = [];
  const answer = (gateway, node, status, body) => {
    if (status === 200) return { ok: true, gateway: gateway.name, node, result: body };
    if (status === 400 || status === 422) return { ok: false, gateway: gateway.name, node, error: body?.message, logs: body?.logs || [] };
    return null;
  };
  for (const gateway of gateways) {
    const revoked = await revokedFingerprints(gateway.id);
    for (const node of pushNodesOf(gateway)) {
      const result = await callNode(node, gateway.id, pki, { method: 'POST', path: '/v1/policy-test', body: payload, revoked });
      const outcome = answer(gateway, node.name, result.ok ? 200 : result.status, result.body);
      if (outcome) return outcome;
      attempts.push(`${gateway.name} / ${node.name}: ${result.error}`);
    }
  }
  for (const gateway of gateways) {
    if (!pollingNodes(gateway.id).length) continue;
    const result = await runTask(gateway.id, 'flow-test', payload);
    if (!result) continue;
    const outcome = answer(gateway, result.node, result.status, result.body);
    if (outcome) return outcome;
    attempts.push(`${gateway.name} / ${result.node}: ${result.body?.message || `HTTP ${result.status}`}`);
  }
  return {
    ok: false,
    unavailable: true,
    error: attempts.length
      ? `No gateway node could run the test. ${attempts.join(' ')}`
      : 'Tests run on a gateway node, and none is connected right now. Start a node of one of your gateways (its page shows the command), then run the test again.',
  };
};

module.exports = {
  isGatewayRunning,
  pushGateway,
  gatewayStatus,
  renewGatewayCredentials,
  collectUsage,
  recentRequests,
  testFlowOnGateway,
  callNode,
  describeError,
  revokedFingerprints,
};
