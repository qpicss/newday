// The credentials file is downloaded from the management console for one gateway.
// It holds the management CA (self-signed) and this gateway's certificate and key.
const fs = require('fs');
const path = require('path');
const { X509Certificate, createPrivateKey } = require('crypto');

const FORMAT = 'oauth-server-gateway-credentials/v1';
const MANAGEMENT_COMMON_NAME = 'oauth-server-management';
const GATEWAY_PREFIX = 'gateway:';

const commonNameOf = (certificate) => {
  const subject = (certificate instanceof X509Certificate ? certificate : new X509Certificate(certificate)).subject;
  const line = subject.split('\n').find((part) => part.startsWith('CN='));
  return line ? line.slice(3) : null;
};

const parseCredentials = (bundle) => {
  if (!bundle || bundle.format !== FORMAT) {
    throw new Error(`Credentials must be a "${FORMAT}" file downloaded from the management console`);
  }
  for (const field of ['managementCa', 'certificate', 'privateKey']) {
    if (typeof bundle[field] !== 'string' || !bundle[field].includes('-----BEGIN')) {
      throw new Error(`The credentials file is missing "${field}"`);
    }
  }

  const ca = new X509Certificate(bundle.managementCa);
  const certificate = new X509Certificate(bundle.certificate);
  if (!certificate.verify(ca.publicKey)) {
    throw new Error('The gateway certificate was not issued by the management CA in the same file');
  }
  if (!certificate.checkPrivateKey(createPrivateKey(bundle.privateKey))) {
    throw new Error('The private key does not match the gateway certificate');
  }

  const commonName = commonNameOf(certificate);
  if (!commonName || !commonName.startsWith(GATEWAY_PREFIX)) {
    throw new Error('The certificate is not a gateway certificate');
  }
  const gatewayId = commonName.slice(GATEWAY_PREFIX.length);
  if (bundle.gatewayId && bundle.gatewayId !== gatewayId) {
    throw new Error('The credentials file names a different gateway than its certificate');
  }

  return {
    gatewayId,
    gatewayName: bundle.gatewayName || gatewayId,
    managementCa: bundle.managementCa,
    certificate: bundle.certificate,
    privateKey: bundle.privateKey,
    validTo: certificate.validTo,
    fingerprint: certificate.fingerprint256,
    serialNumber: certificate.serialNumber,
    bundle,
  };
};

// Renewed credentials (sent by the console) are kept in the data directory and win over the
// original file as long as they belong to the same gateway and expire later.
const RENEWED_FILE = 'credentials.json';

const loadEffectiveCredentials = (file, dataDir) => {
  const renewedFile = path.join(dataDir, RENEWED_FILE);
  let renewed = null;
  if (fs.existsSync(renewedFile)) {
    try {
      renewed = parseCredentials(JSON.parse(fs.readFileSync(renewedFile, 'utf8')));
    } catch {
      renewed = null;
    }
  }
  let original = null;
  try {
    original = loadCredentials(file);
  } catch (error) {
    if (!renewed) throw error;
  }
  if (!original) return renewed;
  if (renewed && renewed.gatewayId === original.gatewayId && new Date(renewed.validTo) > new Date(original.validTo)) {
    return renewed;
  }
  return original;
};

const saveRenewedCredentials = async (dataDir, credentials) => {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, RENEWED_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(credentials.bundle), { mode: 0o600 });
  await fs.promises.rename(temporary, file);
};

const loadCredentials = (file) => {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the credentials file at ${file} (${error.code || error.message}). Download it from the gateway's page in the management console.`);
  }
  try {
    return parseCredentials(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid credentials file at ${file}: ${error.message}`);
  }
};

module.exports = {
  FORMAT,
  MANAGEMENT_COMMON_NAME,
  GATEWAY_PREFIX,
  commonNameOf,
  parseCredentials,
  loadCredentials,
  loadEffectiveCredentials,
  saveRenewedCredentials,
};
