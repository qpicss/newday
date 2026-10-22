// Small HTTP helpers shared by the management server and the traffic handlers.

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    reject(new HttpError(413, 'payload_too_large', `Request bodies are limited to ${limit} bytes`));
    req.resume();
    return;
  }

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      reject(new HttpError(413, 'payload_too_large', `Request bodies are limited to ${limit} bytes`));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const sendJson = (res, status, body, headers = {}) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
};

// Headers that describe one connection and must not be forwarded (RFC 9110 section 7.6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const withoutHopByHop = (headers) => {
  const listed = String(headers.connection || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && !listed.includes(lower) && value !== undefined) {
      result[lower] = value;
    }
  }
  return result;
};

module.exports = { HttpError, readBody, sendJson, withoutHopByHop };
