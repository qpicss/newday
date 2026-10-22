// Worker thread that holds compiled gateway scripts and runs them on request.
// Scripts are loaded per configuration "generation" so a new push can be compiled while the
// previous one keeps serving traffic. Flow tests load into their own generation.
//
// Library calls from scripts: hashing, encryption and JWTs are done here; HTTP requests and rate
// limits need the gateway's connections and counters, so they go to the main thread.
const { parentPort } = require('worker_threads');
const nodeCrypto = require('crypto');
const jsonwebtoken = require('jsonwebtoken');
const { compileScript } = require('./policy');

const generations = new Map(); // generation -> Map(key -> compiled script)

const HASHES = ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'sha3-256', 'sha3-512'];
const ENCODINGS = ['hex', 'base64', 'base64url'];
const HMAC_ALGORITHMS = ['HS256', 'HS384', 'HS512'];
const KEY_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
const MAIN_THREAD_CALLS = new Set(['http.request', 'rateLimit.check']);

const pick = (value, allowed, fallback, what) => {
  const chosen = value === undefined || value === null ? fallback : String(value).toLowerCase();
  if (!allowed.includes(chosen)) throw new Error(`Unknown ${what} "${value}". Use one of: ${allowed.join(', ')}`);
  return chosen;
};
const encodingOf = (value) => pick(value, ENCODINGS, 'hex', 'encoding');
const aesKey = (key) => nodeCrypto.createHash('sha256').update(String(key)).digest();
const isPem = (key) => /-----BEGIN [A-Z ]+-----/.test(key);

const jwtAlgorithm = (value, fallback) => {
  const algorithm = value === undefined || value === null ? fallback : String(value).toUpperCase();
  if (![...HMAC_ALGORITHMS, ...KEY_ALGORITHMS].includes(algorithm)) throw new Error(`Unsupported JWT algorithm "${value}"`);
  return algorithm;
};

const SIGN_OPTIONS = ['expiresIn', 'notBefore', 'audience', 'issuer', 'subject', 'jwtid', 'keyid', 'noTimestamp', 'header'];
const VERIFY_OPTIONS = ['audience', 'issuer', 'subject', 'clockTolerance', 'maxAge', 'ignoreExpiration', 'jwtid', 'nonce'];
const only = (options, names) => Object.fromEntries(Object.entries(options && typeof options === 'object' ? options : {})
  .filter(([name, value]) => names.includes(name) && value !== undefined && value !== null));

const LOCAL = {
  'crypto.hash': ({ algorithm, data, encoding }) => nodeCrypto.createHash(pick(algorithm, HASHES, 'sha256', 'hash algorithm'))
    .update(String(data)).digest(encodingOf(encoding)),
  'crypto.hmac': ({ algorithm, key, data, encoding }) => nodeCrypto.createHmac(pick(algorithm, HASHES, 'sha256', 'hash algorithm'), String(key))
    .update(String(data)).digest(encodingOf(encoding)),
  'crypto.randomUUID': () => nodeCrypto.randomUUID(),
  'crypto.randomBytes': ({ size, encoding }) => {
    const count = Number(size);
    if (!Number.isInteger(count) || count < 1 || count > 1024) throw new Error('randomBytes takes a size from 1 to 1024');
    return nodeCrypto.randomBytes(count).toString(encodingOf(encoding));
  },
  // AES-256-GCM with a key derived from the given secret. The token carries IV and tag.
  'crypto.encrypt': ({ data, key }) => {
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', aesKey(key), iv);
    const encrypted = Buffer.concat([cipher.update(String(data), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  },
  'crypto.decrypt': ({ token, key }) => {
    const [version, iv, tag, encrypted] = String(token).split('.');
    try {
      if (version !== 'v1' || !iv || !tag || encrypted === undefined) throw new Error('format');
      const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', aesKey(key), Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('The value could not be decrypted with this key');
    }
  },
  'jwt.sign': ({ payload, key, options }) => {
    if (!key) throw new Error('jwt.sign needs a secret or a PEM private key');
    const algorithm = jwtAlgorithm(options?.algorithm, isPem(key) ? 'RS256' : 'HS256');
    if (KEY_ALGORITHMS.includes(algorithm) !== isPem(key)) {
      throw new Error(`${algorithm} needs ${KEY_ALGORITHMS.includes(algorithm) ? 'a PEM private key' : 'a shared secret, not a PEM key'}`);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('jwt.sign takes an object payload');
    return jsonwebtoken.sign(payload, key, { ...only(options, SIGN_OPTIONS), algorithm });
  },
  // The accepted algorithms always follow the key type, so a token can't pick a weaker one.
  'jwt.verify': ({ token, key, options }) => {
    if (!key) throw new Error('jwt.verify needs a secret or a PEM public key');
    const family = isPem(key) ? KEY_ALGORITHMS : HMAC_ALGORITHMS;
    const algorithms = Array.isArray(options?.algorithms) && options.algorithms.length
      ? options.algorithms.map((algorithm) => jwtAlgorithm(algorithm)).filter((algorithm) => family.includes(algorithm))
      : family;
    if (!algorithms.length) throw new Error('None of the requested algorithms fits this key');
    try {
      return jsonwebtoken.verify(String(token), key, { ...only(options, VERIFY_OPTIONS), algorithms });
    } catch (error) {
      throw new Error(`The token is not valid: ${error.message}`);
    }
  },
};

const fromMain = new Map(); // callId -> { resolve, reject }
let nextCallId = 1;

const hostFor = (runId) => (kind, args, { deadline }) => {
  if (LOCAL[kind]) return Promise.resolve().then(() => LOCAL[kind](args || {}));
  if (!MAIN_THREAD_CALLS.has(kind)) return Promise.reject(new Error(`Unknown library call ${kind}`));
  return new Promise((resolve, reject) => {
    const callId = nextCallId;
    nextCallId += 1;
    fromMain.set(callId, { resolve, reject });
    parentPort.postMessage({ type: 'host', id: runId, callId, kind, args, deadline });
  });
};

const run = async ({ id, generation, key, input }) => {
  const script = generations.get(generation)?.get(key);
  if (!script) {
    parentPort.postMessage({ type: 'result', id, error: 'The script is not loaded on this worker' });
    return;
  }
  const started = performance.now();
  try {
    const result = await script.run(input, hostFor(id));
    parentPort.postMessage({ type: 'result', id, result, durationMs: performance.now() - started });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id, error: error.message, logs: error.logs || [], durationMs: performance.now() - started });
  }
};

parentPort.on('message', (message) => {
  switch (message.type) {
    case 'load': {
      const compiled = new Map();
      const errors = [];
      for (const script of message.scripts) {
        try {
          compiled.set(script.key, compileScript(script));
        } catch (error) {
          errors.push({ key: script.key, message: error.message });
        }
      }
      if (!errors.length) generations.set(message.generation, compiled);
      parentPort.postMessage({ type: 'loaded', id: message.id, errors });
      break;
    }
    case 'retain':
      for (const generation of generations.keys()) {
        if (generation !== message.generation && !String(generation).startsWith('test-')) generations.delete(generation);
      }
      break;
    case 'drop':
      generations.delete(message.generation);
      break;
    case 'run':
      // Runs share the thread but not their contexts, so they can overlap while awaiting.
      run(message);
      break;
    case 'hostResult': {
      const pending = fromMain.get(message.callId);
      if (!pending) break;
      fromMain.delete(message.callId);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
      break;
    }
    default:
      break;
  }
});
