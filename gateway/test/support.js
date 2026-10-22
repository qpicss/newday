// Test fixtures: a throwaway PKI shaped like the management console's, mock upstreams,
// management (mTLS) requests and signed access tokens.
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const forge = require('node-forge');
const jwt = require('jsonwebtoken');
const { FORMAT } = require('../src/credentials');
const { createLogger } = require('../src/logger');

const keyPair = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const issue = ({ commonName, issuer, publicKey, ca = false, serverAuth = false, clientAuth = false, altNames = [] }) => {
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const subject = [{ name: 'commonName', value: commonName }];
  cert.setSubject(subject);
  cert.setIssuer(issuer ? forge.pki.certificateFromPem(issuer.certificate).subject.attributes : subject);
  cert.setExtensions(ca
    ? [{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }]
    : [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth, clientAuth },
      ...(altNames.length ? [{ name: 'subjectAltName', altNames }] : []),
    ]);
  cert.sign(forge.pki.privateKeyFromPem(issuer ? issuer.privateKey : null), forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
};

const createAuthority = (commonName = 'Test Management CA') => {
  const keys = keyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const subject = [{ name: 'commonName', value: commonName }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }]);
  cert.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  return { certificate: forge.pki.certificateToPem(cert), privateKey: keys.privateKey };
};

const issuePair = (authority, commonName, usage) => {
  const keys = keyPair();
  return { certificate: issue({ commonName, issuer: authority, publicKey: keys.publicKey, ...usage }), privateKey: keys.privateKey };
};

const createPki = (gatewayId = crypto.randomUUID()) => {
  const authority = createAuthority();
  return {
    gatewayId,
    authority,
    gateway: issuePair(authority, `gateway:${gatewayId}`, { serverAuth: true, clientAuth: true }),
    management: issuePair(authority, 'oauth-server-management', { clientAuth: true }),
    // The console's link endpoint (server side of gateway -> console calls)
    consoleServer: issuePair(authority, 'oauth-server-management', { serverAuth: true }),
    impostor: issuePair(authority, 'someone-else', { clientAuth: true }),
    tokenKey: { kid: 'test-key', ...keyPair() },
  };
};

const credentialsFor = (pki) => ({
  format: FORMAT,
  gatewayId: pki.gatewayId,
  gatewayName: 'Test gateway',
  managementCa: pki.authority.certificate,
  certificate: pki.gateway.certificate,
  privateKey: pki.gateway.privateKey,
});

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

// Calls the gateway's management endpoint the way the console does.
const managementRequest = ({ port, method = 'GET', path, body, client, pki }) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const request = https.request({
    host: '127.0.0.1',
    port,
    method,
    path,
    key: client.privateKey,
    cert: client.certificate,
    ca: [pki.authority.certificate],
    checkServerIdentity: (host, cert) => (cert.subject.CN === `gateway:${pki.gatewayId}` ? undefined : new Error('wrong gateway')),
    headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
  });
  request.on('error', reject);
  request.end(payload);
});

// An upstream that records what it receives and echoes it back.
const startUpstream = () => new Promise((resolve) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(received);
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ echoed: received }));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}/backend`,
      requests,
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
    });
  });
});

const ISSUER = 'https://console.test';
const AUDIENCE = 'oauth-server-gateway';

const tokenFor = (pki, { clientId = 'client-1', expiresIn = 600, audience = AUDIENCE, key = pki.tokenKey } = {}) => jwt.sign(
  {},
  key.privateKey,
  { algorithm: 'RS256', keyid: key.kid, subject: clientId, audience, issuer: ISSUER, expiresIn }
);

// Policy flows from a chain of steps: Input -> steps -> Output.
const chainFlow = (steps) => {
  const nodes = [
    { id: 'input', type: 'input', x: 0, y: 0 },
    ...steps.map((step, index) => ({ id: `step${index + 1}`, x: (index + 1) * 260, y: 0, ...step })),
    { id: 'output', type: 'output', x: (steps.length + 1) * 260, y: 0 },
  ];
  return { nodes, edges: nodes.slice(0, -1).map((node, index) => ({ from: node.id, port: 'next', to: nodes[index + 1].id })) };
};
const scriptStep = (code, extra = {}) => ({ type: 'script', name: extra.name || 'Script', config: { code, timeoutMs: extra.timeoutMs } });
// Proxies to the backend with the request's path, unless the test says otherwise.
const invokeStep = (config = {}, name = 'Call the backend') => ({ type: 'invoke', name, config: { appendPath: true, ...config } });
const policyOf = (steps, { id = 'policy', name = 'Policy' } = {}) => ({ id, name, flow: chainFlow(steps) });
// A script (optional) and then the API's backend: how a proxied API looks.
const proxyPolicy = (policy) => policyOf([...(policy ? [scriptStep(policy.code, policy)] : []), invokeStep()], policy || { id: 'proxy', name: 'Proxy' });

const buildConfig = (pki, { handlerPort, upstreamUrl, policy = null, flow, rateLimit = { enabled: false }, subscribedClients = ['client-1'], nodeCount = 1, version = 'v1' }) => ({
  schema: 2,
  version,
  generatedAt: new Date().toISOString(),
  gateway: { id: pki.gatewayId, name: 'Test gateway', nodeCount },
  issuer: ISSUER,
  audience: AUDIENCE,
  tokenKeys: [{ kid: pki.tokenKey.kid, publicKey: pki.tokenKey.publicKey }],
  handlers: [{ id: 'h1', name: 'Public HTTP', port: handlerPort, protocol: 'http' }],
  apis: [{
    id: 'api-orders',
    name: 'Orders API',
    version: '1.0.0',
    basePath: '/acme/orders',
    upstreamUrl,
    operations: [
      { method: 'get', path: '/orders' },
      { method: 'post', path: '/orders' },
      { method: 'get', path: '/orders/{id}' },
    ],
    flow: flow === undefined ? proxyPolicy(policy) : flow,
  }],
  products: [{ id: 'prod-1', name: 'Orders Starter', apiIds: ['api-orders'], rateLimit }],
  subscriptions: subscribedClients.map((clientId) => ({ clientId, application: `App ${clientId}`, productIds: ['prod-1'] })),
});

const silentLogger = () => createLogger('silent');

module.exports = {
  createAuthority,
  issuePair,
  createPki,
  credentialsFor,
  freePort,
  managementRequest,
  startUpstream,
  tokenFor,
  buildConfig,
  chainFlow,
  scriptStep,
  invokeStep,
  policyOf,
  proxyPolicy,
  silentLogger,
};
