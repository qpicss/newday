// Gateway scripts: the JavaScript modules run by "Gateway script" steps of a policy flow (flow.js).
//
//   module.exports = async function (callcontext) { ... }
//   An object { onRequest, onResponse } also works: onRequest runs while no step has set a
//   response yet, onResponse once one has.
//
// callcontext
//   original                     the incoming request, read-only
//   method / path / query        the request as the next steps see it (read/write); path is the operation path
//   headers / body               (read/write); body is a string, or an object sent as JSON
//   bodyEncoding                 'utf8', or 'base64' when the request body is binary
//   response                     null, or { status, headers, body } set by an Invoke step or a script (read/write)
//   variables                    values shared between the steps of the flow (read/write, JSON values)
//   request                      what the last Invoke step sent, read-only (null before one ran)
//   api, consumer, requestId, traceId
//   reply(status, body, headers) answers the client right away; the rest of the flow is skipped
//
// Libraries (functions marked async return promises; use await)
//   crypto       sha256(), hmacSha256(); async hash(), hmac(), randomUUID(), randomBytes(), encrypt(), decrypt()
//   hash         async md5(), sha1(), sha256(), sha384(), sha512(), hmac()
//   jwt          async sign(), verify(); decode()
//   http         async request(), get(), post(), put(), patch(), delete(), head()
//   rateLimit    async check(key, limit, period)
//   querystring  parse(), stringify(), escape(), unescape()
//   base64       encode(), decode(), encodeUrl()
//   console      log(), info(), warn(), error() to the gateway log
//
// Isolation: every run gets a new vm context with no require, process, timers or eval/new
// Function, inside a policy worker thread (policyRunner.js). The libraries are plain JavaScript
// inside the context. Calls that need the host (hashing, JWTs, HTTP, rate limits) are queued
// inside the context as JSON strings; the host reads them, does the work and settles each one with
// another JSON string, so no host object ever reaches the script. The vm timeout stops synchronous
// loops; the caller stops anything else by restarting the worker.
const vm = require('vm');

class PolicyError extends Error {
  constructor(message, { logs = [] } = {}) {
    super(message);
    this.logs = logs;
  }
}

const DEFAULT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
// The longest a script may compute without awaiting anything.
const MAX_SLICE_MS = 5000;
const MAX_HOST_CALLS = 50;
const MAX_VARIABLES_BYTES = 1024 * 1024;

// Helpers implemented in plain JavaScript inside the sandbox (no host functions involved).
const HELPERS = `
const __utf8 = (text) => {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        i += 1;
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return out;
};
const __fromUtf8 = (bytes) => {
  let text = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    let code;
    if (b < 0x80) code = b;
    else if (b < 0xe0) code = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) { code = ((b & 15) << 12) | ((bytes[i++] & 63) << 6); code |= bytes[i++] & 63; }
    else { code = ((b & 7) << 18) | ((bytes[i++] & 63) << 12); code |= (bytes[i++] & 63) << 6; code |= bytes[i++] & 63; }
    if (code > 0xffff) { code -= 0x10000; text += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023)); }
    else text += String.fromCharCode(code);
  }
  return text;
};
const __K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const __rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));
const __sha256 = (input) => {
  const bytes = input.slice();
  const bitLength = input.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i -= 1) bytes.push(Math.floor(bitLength / Math.pow(2, i * 8)) & 255);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = (bytes[offset + 4 * t] << 24) | (bytes[offset + 4 * t + 1] << 16) | (bytes[offset + 4 * t + 2] << 8) | bytes[offset + 4 * t + 3];
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = __rotr(w[t - 15], 7) ^ __rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = __rotr(w[t - 2], 17) ^ __rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let t = 0; t < 64; t += 1) {
      const t1 = (h + (__rotr(e, 6) ^ __rotr(e, 11) ^ __rotr(e, 25)) + ((e & f) ^ (~e & g)) + __K[t] + w[t]) | 0;
      const t2 = ((__rotr(a, 2) ^ __rotr(a, 13) ^ __rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    hash[0] = (hash[0] + a) | 0; hash[1] = (hash[1] + b) | 0; hash[2] = (hash[2] + c) | 0; hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0; hash[5] = (hash[5] + f) | 0; hash[6] = (hash[6] + g) | 0; hash[7] = (hash[7] + h) | 0;
  }
  const out = [];
  for (const value of hash) out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
  return out;
};
const __hmac = (key, data) => {
  let block = key.length > 64 ? __sha256(key) : key.slice();
  while (block.length < 64) block.push(0);
  const outer = block.map((byte) => byte ^ 0x5c);
  const inner = block.map((byte) => byte ^ 0x36);
  return __sha256(outer.concat(__sha256(inner.concat(data))));
};
const __ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const __toBase64 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += __ALPHABET[(n >> 18) & 63] + __ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? __ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? __ALPHABET[n & 63] : '=';
  }
  return out;
};
const __fromBase64 = (text) => {
  const clean = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = (__ALPHABET.indexOf(clean[i]) << 18) | (__ALPHABET.indexOf(clean[i + 1]) << 12)
      | ((clean[i + 2] ? __ALPHABET.indexOf(clean[i + 2]) : 0) << 6) | (clean[i + 3] ? __ALPHABET.indexOf(clean[i + 3]) : 0);
    bytes.push((n >> 16) & 255);
    if (clean[i + 2]) bytes.push((n >> 8) & 255);
    if (clean[i + 3]) bytes.push(n & 255);
  }
  return bytes;
};
const __encode = (bytes, encoding) => {
  if (encoding === 'base64') return __toBase64(bytes);
  if (encoding === 'base64url') return __toBase64(bytes).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
`;

// The libraries scripts see. Host calls go through __host(): the request is queued as a JSON string
// and the returned promise (created inside the context) is settled by __settle().
const LIBRARIES = `
const __pending = [];
const __waiting = new Map();
let __calls = 0;
const __host = (kind, args) => new Promise((resolve, reject) => {
  __calls += 1;
  if (__calls > ${MAX_HOST_CALLS}) {
    reject(new Error('A script can make at most ${MAX_HOST_CALLS} library calls per request'));
    return;
  }
  let encoded;
  try {
    encoded = JSON.stringify(args === undefined ? null : args);
  } catch (error) {
    reject(new Error(kind + ' takes JSON values only'));
    return;
  }
  __waiting.set(__calls, { resolve, reject });
  __pending.push('{"id":' + __calls + ',"kind":' + JSON.stringify(kind) + ',"args":' + encoded + '}');
});
globalThis.__drain = () => {
  const out = '[' + __pending.join(',') + ']';
  __pending.length = 0;
  return out;
};
globalThis.__settle = () => {
  const settlement = JSON.parse(globalThis.__settlement);
  globalThis.__settlement = null;
  const waiting = __waiting.get(settlement.id);
  if (!waiting) return;
  __waiting.delete(settlement.id);
  if (settlement.ok) waiting.resolve(settlement.value);
  else waiting.reject(new Error(settlement.error));
};
const __string = (value) => (typeof value === 'string' ? value
  : value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

const crypto = Object.freeze({
  sha256: (data, encoding = 'hex') => __encode(__sha256(__utf8(String(data))), encoding),
  hmacSha256: (key, data, encoding = 'hex') => __encode(__hmac(__utf8(String(key)), __utf8(String(data))), encoding),
  hash: (algorithm, data, encoding = 'hex') => __host('crypto.hash', { algorithm: String(algorithm), data: __string(data), encoding }),
  hmac: (algorithm, key, data, encoding = 'hex') => __host('crypto.hmac', { algorithm: String(algorithm), key: __string(key), data: __string(data), encoding }),
  randomUUID: () => __host('crypto.randomUUID', {}),
  randomBytes: (size, encoding = 'hex') => __host('crypto.randomBytes', { size, encoding }),
  encrypt: (data, key) => __host('crypto.encrypt', { data: __string(data), key: __string(key) }),
  decrypt: (token, key) => __host('crypto.decrypt', { token: __string(token), key: __string(key) }),
});
const hash = Object.freeze({
  md5: (data, encoding) => crypto.hash('md5', data, encoding),
  sha1: (data, encoding) => crypto.hash('sha1', data, encoding),
  sha256: (data, encoding) => crypto.hash('sha256', data, encoding),
  sha384: (data, encoding) => crypto.hash('sha384', data, encoding),
  sha512: (data, encoding) => crypto.hash('sha512', data, encoding),
  hmac: (algorithm, key, data, encoding) => crypto.hmac(algorithm, key, data, encoding),
});
const base64 = Object.freeze({
  encode: (text) => __toBase64(__utf8(String(text))),
  encodeUrl: (text) => __encode(__utf8(String(text)), 'base64url'),
  decode: (text) => __fromUtf8(__fromBase64(text)),
});
const __jsonPart = (part) => JSON.parse(__fromUtf8(__fromBase64(part)));
const jwt = Object.freeze({
  sign: (payload, key, options = {}) => __host('jwt.sign', { payload, key: __string(key), options }),
  verify: (token, key, options = {}) => __host('jwt.verify', { token: __string(token), key: __string(key), options }),
  decode: (token) => {
    const parts = __string(token).split('.');
    if (parts.length !== 3) return null;
    try {
      return { header: __jsonPart(parts[0]), payload: __jsonPart(parts[1]) };
    } catch (error) {
      return null;
    }
  },
});
const http = Object.freeze({
  request: (options) => __host('http.request', options || {}),
  get: (url, options = {}) => http.request({ ...options, method: 'GET', url }),
  head: (url, options = {}) => http.request({ ...options, method: 'HEAD', url }),
  delete: (url, options = {}) => http.request({ ...options, method: 'DELETE', url }),
  post: (url, body, options = {}) => http.request({ ...options, method: 'POST', url, body }),
  put: (url, body, options = {}) => http.request({ ...options, method: 'PUT', url, body }),
  patch: (url, body, options = {}) => http.request({ ...options, method: 'PATCH', url, body }),
});
const rateLimit = Object.freeze({
  check: (key, limit, period = 'minute') => __host('rateLimit.check', { key: __string(key), limit, period }),
});
const __decode = (value) => {
  try {
    return decodeURIComponent(value.replace(/\\+/g, ' '));
  } catch (error) {
    return value;
  }
};
const querystring = Object.freeze({
  parse: (text) => {
    const result = {};
    String(text || '').replace(/^\\?/, '').split('&').forEach((pair) => {
      if (!pair) return;
      const index = pair.indexOf('=');
      const name = __decode(index < 0 ? pair : pair.slice(0, index));
      if (name === '__proto__') return;
      const value = index < 0 ? '' : __decode(pair.slice(index + 1));
      if (Object.prototype.hasOwnProperty.call(result, name)) result[name] = [].concat(result[name], value);
      else result[name] = value;
    });
    return result;
  },
  stringify: (object) => Object.keys(object || {})
    .flatMap((name) => [].concat(object[name])
      .filter((value) => value !== undefined && value !== null)
      .map((value) => encodeURIComponent(name) + '=' + encodeURIComponent(String(value))))
    .join('&'),
  escape: (value) => encodeURIComponent(String(value)),
  unescape: (value) => __decode(String(value)),
});
`;

const PARAMETERS = 'module, exports, require, console, crypto, base64, hash, jwt, http, rateLimit, querystring';

// The script source is placed inside this wrapper; PREFIX_LINES keeps error line numbers right.
const PREFIX = `(function () {
'use strict';
${HELPERS}
${LIBRARIES}
const __freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(__freeze);
    Object.freeze(value);
  }
  return value;
};
const __logs = [];
const __format = (args) => args.map((arg) => (typeof arg === 'string' ? arg : (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })())).join(' ');
const console = {
  log: (...args) => { __logs.push(['info', __format(args)]); },
  info: (...args) => { __logs.push(['info', __format(args)]); },
  warn: (...args) => { __logs.push(['warn', __format(args)]); },
  error: (...args) => { __logs.push(['error', __format(args)]); },
};
const require = (name) => { throw new Error('require("' + name + '") is not available in gateway scripts. Use the built-in libraries: crypto, hash, jwt, http, rateLimit, querystring, base64.'); };
const module = { exports: {} };
(function (${PARAMETERS}) {
`;
const SUFFIX = `
}).call(module.exports, module, module.exports, require, console, crypto, base64, hash, jwt, http, rateLimit, querystring);
const __exported = module.exports;
const __main = typeof __exported === 'function' ? __exported : null;
const __onRequest = __exported && typeof __exported === 'object' ? (__exported.onRequest || __exported.default) : undefined;
const __onResponse = __exported && typeof __exported === 'object' ? __exported.onResponse : undefined;
if (!__main && typeof __onRequest !== 'function' && typeof __onResponse !== 'function') {
  throw new Error('The script must export a function: module.exports = async function (callcontext) { ... }');
}
globalThis.__invoke = () => {
  const input = JSON.parse(globalThis.__input);
  globalThis.__input = null;
  let reply = null;
  const callcontext = {
    original: __freeze(input.original),
    api: __freeze(input.api),
    consumer: __freeze(input.consumer),
    request: __freeze(input.request === undefined ? null : input.request),
    requestId: input.requestId,
    traceId: input.traceId,
    method: input.method,
    path: input.path,
    query: input.query,
    headers: input.headers,
    body: input.body,
    bodyEncoding: input.bodyEncoding || 'utf8',
    response: input.response === undefined ? null : input.response,
    variables: input.variables || {},
    log: (...args) => { __logs.push(['info', __format(args)]); },
    reply(status, body, headers) {
      reply = { status, body: body === undefined ? '' : body, headers: headers || {} };
    },
  };
  const handler = __main || (callcontext.response ? __onResponse : __onRequest);
  const done = () => {
    globalThis.__output = JSON.stringify({
      ok: true,
      method: callcontext.method,
      path: callcontext.path,
      query: callcontext.query,
      headers: callcontext.headers,
      body: callcontext.body,
      response: callcontext.response,
      variables: callcontext.variables,
      reply,
      logs: __logs,
    });
  };
  const failed = (error) => { globalThis.__output = JSON.stringify({ ok: false, error: String((error && error.message) || error), logs: __logs }); };
  globalThis.__output = null;
  if (typeof handler !== 'function') {
    done();
    return;
  }
  // The handler starts synchronously, so the vm timeout covers its synchronous part.
  let result;
  try {
    result = handler(callcontext);
  } catch (error) {
    failed(error);
    return;
  }
  Promise.resolve(result).then(() => {
    try {
      done();
    } catch (error) {
      failed(error);
    }
  }, failed);
};
})();
`;
const PREFIX_LINES = PREFIX.split('\n').length - 1;

const INVOKE = new vm.Script('globalThis.__invoke();', { filename: 'gateway:invoke' });
const DRAIN = new vm.Script('globalThis.__drain();', { filename: 'gateway:drain' });
const SETTLE = new vm.Script('globalThis.__settle();', { filename: 'gateway:settle' });

const clampTimeout = (value) => Math.min(MAX_TIMEOUT_MS, Math.max(10, Number(value) || DEFAULT_TIMEOUT_MS));

// Compiles the code without running it, so syntax errors point at the script, not the wrapper.
const checkScriptSyntax = (script) => {
  const name = script.name || script.id || 'script';
  try {
    new vm.Script(`(function (${PARAMETERS}) {\n${String(script.code || '')}\n})`, {
      filename: `script:${name}`,
      lineOffset: -1,
    });
  } catch (error) {
    throw new PolicyError(`Script "${name}" has a syntax error: ${error.message}`);
  }
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const METHOD = /^[A-Z]{1,20}$/;

// Turns script output into string header values (lower-case names, no CR/LF).
const normalizeHeaders = (headers) => {
  const result = {};
  if (!headers || typeof headers !== 'object') return result;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const lower = String(name).toLowerCase();
    if (!HEADER_NAME.test(lower)) continue;
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    if (values.some((item) => /[\r\n]/.test(item))) continue;
    result[lower] = Array.isArray(value) ? values : values[0];
  }
  return result;
};

const normalizeBody = (body) => {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
};

const normalizeQuery = (query) => {
  const result = {};
  if (!query || typeof query !== 'object') return result;
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    result[String(name)] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return result;
};

const normalizeStatus = (status, fallback) => {
  const number = Number(status);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : fallback;
};

const normalizeResponse = (response) => {
  if (!response || typeof response !== 'object') return null;
  return {
    status: normalizeStatus(response.status, 200),
    headers: normalizeHeaders(response.headers),
    body: normalizeBody(response.body),
    bodyWasObject: response.body !== null && typeof response.body === 'object',
    ...(response.bodyEncoding === 'base64' && { bodyEncoding: 'base64' }),
  };
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const noHost = (kind) => Promise.reject(new Error(`${kind} is not available here`));

const compileScript = (script) => {
  const name = script.name || script.id || 'script';
  const timeoutMs = clampTimeout(script.timeoutMs);
  const sliceMs = Math.min(timeoutMs, MAX_SLICE_MS);
  const filename = `script:${name}`;

  checkScriptSyntax(script);
  const compiled = new vm.Script(PREFIX + String(script.code || '') + SUFFIX, { filename, lineOffset: -PREFIX_LINES });

  const execute = (code, context, what) => {
    try {
      return code.runInContext(context, { timeout: sliceMs, displayErrors: false });
    } catch (error) {
      if (/timed out/i.test(error.message)) throw new PolicyError(`Script "${name}" did not finish within ${sliceMs} ms`);
      throw new PolicyError(`Script "${name}" ${what}: ${error.message}`);
    }
  };

  // A new context per run: nothing leaks from one request to the next, and runs never share state.
  const load = () => {
    const context = vm.createContext(Object.create(null), {
      name: filename,
      codeGeneration: { strings: false, wasm: false },
    });
    execute(compiled, context, 'failed to load');
    return context;
  };
  load(); // reports a missing export when the configuration is loaded, not on the first request

  // `host(kind, args, { deadline })` performs library calls; it returns a promise.
  const run = async (input, host = noHost) => {
    const deadline = Date.now() + timeoutMs;
    const timedOut = () => new PolicyError(`Script "${name}" did not finish within ${timeoutMs} ms`);
    const context = load();
    context.__input = JSON.stringify(input);
    execute(INVOKE, context, 'failed');

    const settled = [];
    let outstanding = 0;
    let wake = null;
    for (;;) {
      // Promise callbacks of the script run in the microtask checkpoint before the next turn.
      await nextTurn();
      const raw = context.__output;
      if (typeof raw === 'string') return finish(JSON.parse(raw), input);
      if (Date.now() > deadline) throw timedOut();

      const calls = JSON.parse(execute(DRAIN, context, 'failed'));
      for (const call of calls) {
        outstanding += 1;
        Promise.resolve()
          .then(() => host(call.kind, call.args, { deadline }))
          .then(
            (value) => ({ id: call.id, ok: true, value: value === undefined ? null : value }),
            (error) => ({ id: call.id, ok: false, error: String((error && error.message) || error) })
          )
          .then((settlement) => {
            outstanding -= 1;
            settled.push(settlement);
            if (wake) wake();
          });
      }
      if (!settled.length) {
        if (!outstanding) {
          throw new PolicyError(`Script "${name}" did not finish. It may be waiting on a promise that never resolves.`);
        }
        let timer;
        await new Promise((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        });
        wake = null;
        clearTimeout(timer);
        if (!settled.length) throw timedOut();
      }
      while (settled.length) {
        context.__settlement = JSON.stringify(settled.shift());
        execute(SETTLE, context, 'failed');
      }
    }
  };

  const finish = (output, input) => {
    if (!output.ok) {
      throw new PolicyError(`Script "${name}" threw an error: ${output.error}`, { logs: output.logs });
    }
    let reply = null;
    if (output.reply) {
      reply = {
        status: normalizeStatus(output.reply.status, 200),
        headers: normalizeHeaders(output.reply.headers),
        body: normalizeBody(output.reply.body),
      };
    }
    const variables = output.variables && typeof output.variables === 'object' && !Array.isArray(output.variables) ? output.variables : {};
    if (JSON.stringify(variables).length > MAX_VARIABLES_BYTES) {
      throw new PolicyError(`Script "${name}" stored more than 1 MB in callcontext.variables`, { logs: output.logs });
    }
    const method = String(output.method || input.method || 'GET').toUpperCase();
    const path = typeof output.path === 'string' && output.path.startsWith('/') && !/[\r\n\s#?]/.test(output.path)
      ? output.path
      : input.path;
    return {
      method: METHOD.test(method) ? method : input.method,
      path,
      query: normalizeQuery(output.query),
      headers: normalizeHeaders(output.headers),
      body: normalizeBody(output.body),
      bodyWasObject: output.body !== null && typeof output.body === 'object',
      response: normalizeResponse(output.response),
      variables,
      reply,
      logs: output.logs || [],
    };
  };

  return { key: script.key, name, timeoutMs, run };
};

module.exports = {
  compileScript,
  checkScriptSyntax,
  // The console's name for the same check.
  checkPolicySyntax: checkScriptSyntax,
  clampTimeout,
  normalizeHeaders,
  PolicyError,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_SLICE_MS,
};
