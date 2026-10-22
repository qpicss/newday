// Encrypts private keys before they are stored in the database (AES-256-GCM).
// The key comes from PKI_MASTER_KEY (32 bytes, base64). Without it a key is derived from
// JWT_SECRET, which means changing JWT_SECRET makes stored private keys unreadable.
const crypto = require('crypto');

let cachedKey = null;

const masterKey = () => {
  if (cachedKey) return cachedKey;
  if (process.env.PKI_MASTER_KEY) {
    const key = Buffer.from(process.env.PKI_MASTER_KEY, 'base64');
    if (key.length !== 32) {
      throw new Error('PKI_MASTER_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)');
    }
    cachedKey = key;
  } else {
    if (!process.env.JWT_SECRET) {
      throw new Error('Set PKI_MASTER_KEY (or JWT_SECRET) to store private keys');
    }
    cachedKey = Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'oauth-server', 'pki-master-key', 32));
  }
  return cachedKey;
};

const seal = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
};

const open = (sealed) => {
  const [version, iv, tag, ciphertext] = String(sealed).split('.');
  if (version !== 'v1') throw new Error('Unknown sealed secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('A stored private key could not be decrypted. Was PKI_MASTER_KEY or JWT_SECRET changed?');
  }
};

module.exports = { seal, open };
