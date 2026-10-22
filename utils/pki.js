// Self-signed PKI for management <-> gateway mTLS, plus the gateway token signing key.
//
//   management CA (self-signed, 10 years)
//     ├── management client certificate   CN=oauth-server-management   (clientAuth: console -> gateway)
//     ├── management link certificate     CN=oauth-server-management   (serverAuth: gateway -> console link)
//     ├── gateway certificates            CN=gateway:<gatewayId>       (serverAuth + clientAuth; also the admin UI)
//     └── handler certificates            CN=<public hostname>         (serverAuth, for HTTPS handlers)
//
// Keys are generated with node:crypto; certificates are built and signed with node-forge.
// The console's own certificates renew themselves when they are within 30 days of expiry.
const crypto = require('crypto');
const forge = require('node-forge');
const SystemKey = require('../models/SystemKey');
const { seal, open } = require('./secretBox');

const MANAGEMENT_COMMON_NAME = 'oauth-server-management';
const CREDENTIALS_FORMAT = 'oauth-server-gateway-credentials/v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 30 * DAY_MS;

const generateKeyPair = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const fingerprintOf = (certificatePem) => new crypto.X509Certificate(certificatePem).fingerprint256;

const isIpAddress = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
const altName = (name) => (isIpAddress(name) ? { type: 7, ip: name.replace(/^\[|\]$/g, '') } : { type: 2, value: name });

// Signed by `issuer`, or self-signed with `privateKeyPem` when there is no issuer (the CA).
const buildCertificate = ({ commonName, publicKeyPem, privateKeyPem, issuer, days, isCa = false, serverAuth = false, clientAuth = false, altNames = [] }) => {
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  // Positive 128-bit serial
  cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + days * DAY_MS);

  const subject = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'OAuth Server' },
  ];
  cert.setSubject(subject);
  const issuerCert = issuer ? forge.pki.certificateFromPem(issuer.certificatePem) : null;
  cert.setIssuer(issuerCert ? issuerCert.subject.attributes : subject);

  const extensions = [{ name: 'basicConstraints', cA: isCa, critical: true }];
  if (isCa) {
    extensions.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true });
  } else {
    extensions.push(
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth, clientAuth }
    );
  }
  if (altNames.length) extensions.push({ name: 'subjectAltName', altNames });
  extensions.push({ name: 'subjectKeyIdentifier' });
  cert.setExtensions(extensions);

  cert.sign(forge.pki.privateKeyFromPem(issuer ? issuer.privateKeyPem : privateKeyPem), forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
};

const loadKey = async (name) => {
  const row = await SystemKey.findByPk(name);
  return row && {
    certificatePem: row.certificatePem,
    publicKeyPem: row.publicKeyPem,
    privateKeyPem: open(row.privateKeySealed),
  };
};

const saveKey = async (name, { certificatePem = null, publicKeyPem, privateKeyPem }, { replace = false } = {}) => {
  if (replace) {
    await SystemKey.upsert({ name, certificatePem, publicKeyPem, privateKeySealed: seal(privateKeyPem) });
    return { certificatePem, publicKeyPem, privateKeyPem };
  }
  // If another process created the key first, keep theirs.
  const [row] = await SystemKey.findOrCreate({
    where: { name },
    defaults: { certificatePem, publicKeyPem, privateKeySealed: seal(privateKeyPem) },
  });
  return { certificatePem: row.certificatePem, publicKeyPem: row.publicKeyPem, privateKeyPem: open(row.privateKeySealed) };
};

const expiresSoon = (certificatePem) => new Date(new crypto.X509Certificate(certificatePem).validTo).getTime() - Date.now() < RENEW_BEFORE_MS;

// Host names the gateway link certificate must cover.
const linkHostnames = () => {
  // host.docker.internal: how gateway containers on the console's own machine reach it.
  const names = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);
  for (const value of [process.env.GATEWAY_LINK_PUBLIC_URL, process.env.APP_URL]) {
    try {
      if (value) names.add(new URL(value).hostname);
    } catch {
      // ignore invalid URLs
    }
  }
  return [...names].sort();
};

const loadOrCreatePki = async () => {
  let ca = await loadKey('management-ca');
  if (!ca) {
    const keys = generateKeyPair();
    const certificatePem = buildCertificate({ commonName: 'OAuth Server Management CA', publicKeyPem: keys.publicKey, privateKeyPem: keys.privateKey, days: 3650, isCa: true });
    // Self-signed: the CA signs its own certificate.
    ca = await saveKey('management-ca', { certificatePem, publicKeyPem: keys.publicKey, privateKeyPem: keys.privateKey });
  }

  let client = await loadKey('management-client');
  if (!client || expiresSoon(client.certificatePem)) {
    const keys = generateKeyPair();
    const certificatePem = buildCertificate({
      commonName: MANAGEMENT_COMMON_NAME, publicKeyPem: keys.publicKey, issuer: ca, days: 825, clientAuth: true,
    });
    client = await saveKey('management-client', { certificatePem, publicKeyPem: keys.publicKey, privateKeyPem: keys.privateKey }, { replace: Boolean(client) });
  }

  // Reissued when it nears expiry or when the configured host names change.
  const hostnames = linkHostnames();
  const expectedSan = hostnames.map((name) => (isIpAddress(name) ? `IP Address:${name}` : `DNS:${name}`)).sort().join(', ');
  let link = await loadKey('management-link');
  const currentSan = link ? (new crypto.X509Certificate(link.certificatePem).subjectAltName || '').split(', ').sort().join(', ') : null;
  if (!link || expiresSoon(link.certificatePem) || currentSan !== expectedSan) {
    const keys = generateKeyPair();
    const certificatePem = buildCertificate({
      commonName: MANAGEMENT_COMMON_NAME, publicKeyPem: keys.publicKey, issuer: ca, days: 397, serverAuth: true, altNames: hostnames.map(altName),
    });
    link = await saveKey('management-link', { certificatePem, publicKeyPem: keys.publicKey, privateKeyPem: keys.privateKey }, { replace: Boolean(link) });
  }

  let tokenKey = await loadKey('token-signing');
  if (!tokenKey) {
    const keys = generateKeyPair();
    tokenKey = await saveKey('token-signing', { publicKeyPem: keys.publicKey, privateKeyPem: keys.privateKey });
  }
  const kid = crypto.createHash('sha256').update(tokenKey.publicKeyPem).digest('base64url').slice(0, 16);

  return {
    ca: { ...ca, fingerprint: fingerprintOf(ca.certificatePem), validTo: new crypto.X509Certificate(ca.certificatePem).validTo },
    client,
    link,
    tokenKey: { ...tokenKey, kid },
  };
};

// Created once per process and cached; the first call generates and stores missing keys.
let pkiPromise = null;
let pkiLoadedAt = 0;
const getPki = () => {
  // Refreshed daily so long-running consoles renew their own certificates.
  if (pkiPromise && Date.now() - pkiLoadedAt > DAY_MS) pkiPromise = null;
  if (!pkiPromise) {
    pkiLoadedAt = Date.now();
    pkiPromise = loadOrCreatePki().catch((error) => {
      pkiPromise = null;
      throw error;
    });
  }
  return pkiPromise;
};

// Tests recreate the database, so they need a fresh PKI.
const resetPkiCache = () => {
  pkiPromise = null;
};

// Everything one gateway (all of its nodes) needs to talk to management. Every certificate is
// recorded so it can be listed, revoked and tracked for expiry. The certificate also covers
// localhost and the public host name so it can serve the gateway's admin UI.
const issueGatewayCredentials = async (gateway, { source = 'download' } = {}) => {
  // Required lazily: models/index.js loads this module's models.
  const { GatewayCredential } = require('../models');
  const { ca } = await getPki();
  const keys = generateKeyPair();
  const hostnames = new Set(['localhost', '127.0.0.1']);
  try {
    hostnames.add(new URL(gateway.publicUrl).hostname);
  } catch {
    // no public host
  }
  const certificatePem = buildCertificate({
    commonName: `gateway:${gateway.id}`,
    publicKeyPem: keys.publicKey,
    issuer: ca,
    days: 825,
    serverAuth: true,
    clientAuth: true,
    altNames: [{ type: 6, value: `urn:oauth-server:gateway:${gateway.id}` }, ...[...hostnames].map(altName)],
  });
  const bundle = {
    format: CREDENTIALS_FORMAT,
    gatewayId: gateway.id,
    gatewayName: gateway.name,
    issuedAt: new Date().toISOString(),
    managementCa: ca.certificatePem,
    certificate: certificatePem,
    privateKey: keys.privateKey,
  };
  const x509 = new crypto.X509Certificate(certificatePem);
  const credential = await GatewayCredential.create({
    gatewayId: gateway.id,
    serialNumber: x509.serialNumber,
    fingerprint: x509.fingerprint256,
    validTo: new Date(x509.validTo),
    source,
    bundleSealed: source === 'renewal' ? seal(JSON.stringify(bundle)) : null,
  });
  return { bundle, credential };
};

// Server certificate for an HTTPS connection handler, signed by the management CA.
const issueHandlerCertificate = async (hostnames) => {
  const { ca } = await getPki();
  const keys = generateKeyPair();
  const names = [...new Set(hostnames.filter(Boolean))];
  const certificatePem = buildCertificate({
    commonName: names[0] || 'localhost',
    publicKeyPem: keys.publicKey,
    issuer: ca,
    days: 397,
    serverAuth: true,
    altNames: names.map(altName),
  });
  return { certificatePem, privateKeyPem: keys.privateKey };
};

module.exports = {
  MANAGEMENT_COMMON_NAME,
  CREDENTIALS_FORMAT,
  getPki,
  resetPkiCache,
  issueGatewayCredentials,
  issueHandlerCertificate,
  fingerprintOf,
};
