// Upstream connections: how the gateway reaches an API's backend.
// Each connection configured in the console has its own pooled agent (with optional mTLS and custom
// CAs), timeouts, retries for idempotent methods, credentials and a circuit breaker. APIs without a
// connection use the defaults.
const http = require('http');
const https = require('https');
const tls = require('tls');
const { HttpError } = require('./http');

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRYABLE_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET']);
const DEFAULT_ID = '__default';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const defaultsFor = (settings) => ({
  id: DEFAULT_ID,
  name: 'default',
  connectTimeoutMs: 5000,
  timeoutMs: settings.upstreamTimeoutMs,
  retries: 0,
  retryOn: [502, 503, 504],
  circuitBreaker: { enabled: false, failureThreshold: 5, cooldownMs: 30000 },
  auth: { type: 'none' },
  tls: { rejectUnauthorized: true },
});

const buildAgents = (connection) => {
  const options = { keepAlive: true, maxSockets: 100, maxFreeSockets: 20 };
  const tlsOptions = connection.tls || {};
  const httpsOptions = {
    ...options,
    rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
    // Custom CAs are added to, not substituted for, the system trust store.
    ...(tlsOptions.ca && { ca: [...tls.rootCertificates, tlsOptions.ca] }),
    ...(tlsOptions.clientCertificate && tlsOptions.clientKey && { cert: tlsOptions.clientCertificate, key: tlsOptions.clientKey }),
    ...(tlsOptions.serverName && { servername: tlsOptions.serverName }),
  };
  return { http: new http.Agent(options), https: new https.Agent(httpsOptions) };
};

const authHeaders = (auth = {}) => {
  switch (auth.type) {
    case 'basic':
      return { authorization: `Basic ${Buffer.from(`${auth.username || ''}:${auth.secret || ''}`).toString('base64')}` };
    case 'bearer':
      return { authorization: `Bearer ${auth.secret || ''}` };
    case 'header':
      return auth.headerName ? { [auth.headerName.toLowerCase()]: auth.secret || '' } : {};
    default:
      return {};
  }
};

class UpstreamConnections {
  constructor({ settings, metrics, logger }) {
    this.settings = settings;
    this.metrics = metrics;
    this.logger = logger;
    this.entries = new Map();
    this.entries.set(DEFAULT_ID, this.createEntry(defaultsFor(settings)));
  }

  createEntry(config) {
    return {
      config,
      fingerprint: JSON.stringify(config),
      agents: buildAgents(config),
      breaker: { failures: 0, openUntil: 0, state: 'closed' },
    };
  }

  // Keeps agents and breaker state for connections that did not change.
  configure(connections = []) {
    const wanted = new Set([DEFAULT_ID]);
    for (const connection of connections) {
      wanted.add(connection.id);
      const config = { ...defaultsFor(this.settings), ...connection, circuitBreaker: { ...defaultsFor(this.settings).circuitBreaker, ...(connection.circuitBreaker || {}) } };
      const existing = this.entries.get(connection.id);
      if (existing && existing.fingerprint === JSON.stringify(config)) continue;
      if (existing) this.destroy(existing);
      this.entries.set(connection.id, this.createEntry(config));
    }
    for (const [id, entry] of this.entries) {
      if (!wanted.has(id)) {
        this.destroy(entry);
        this.entries.delete(id);
      }
    }
  }

  destroy(entry) {
    entry.agents.http.destroy();
    entry.agents.https.destroy();
  }

  get(connectionId) {
    return this.entries.get(connectionId) || this.entries.get(DEFAULT_ID);
  }

  status() {
    return [...this.entries.values()]
      .filter((entry) => entry.config.id !== DEFAULT_ID)
      .map((entry) => ({ id: entry.config.id, name: entry.config.name, circuit: entry.breaker.state, failures: entry.breaker.failures }));
  }

  breakerAllows(entry) {
    const { breaker, config } = entry;
    if (!config.circuitBreaker.enabled || breaker.state === 'closed') return true;
    if (breaker.state === 'open' && Date.now() >= breaker.openUntil) {
      breaker.state = 'half-open';
      return true;
    }
    return breaker.state === 'half-open' ? false : Date.now() >= breaker.openUntil;
  }

  recordResult(entry, failed) {
    const { breaker, config } = entry;
    if (!config.circuitBreaker.enabled) return;
    if (!failed) {
      if (breaker.state !== 'closed') this.logger.info('circuit closed', { connection: config.name });
      breaker.failures = 0;
      breaker.state = 'closed';
      this.metrics.circuitOpen.set({ connection: config.name }, 0);
      return;
    }
    breaker.failures += 1;
    if (breaker.state === 'half-open' || breaker.failures >= config.circuitBreaker.failureThreshold) {
      breaker.state = 'open';
      breaker.openUntil = Date.now() + config.circuitBreaker.cooldownMs;
      this.metrics.circuitOpen.set({ connection: config.name }, 1);
      this.logger.warn('circuit opened', { connection: config.name, failures: breaker.failures, cooldownMs: config.circuitBreaker.cooldownMs });
    }
  }

  once(entry, { target, method, headers, body, timeoutMs }) {
    const { config } = entry;
    const responseTimeoutMs = timeoutMs || config.timeoutMs;
    const transport = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? entry.agents.https : entry.agents.http;
    return new Promise((resolve, reject) => {
      const request = transport.request(target, { method, headers, agent }, resolve);
      request.on('socket', (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(() => request.destroy(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' })), config.connectTimeoutMs);
        socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(timer));
        socket.once('close', () => clearTimeout(timer));
      });
      request.setTimeout(responseTimeoutMs, () => {
        request.destroy(Object.assign(new Error('response timeout'), { code: 'RESPONSE_TIMEOUT' }));
      });
      request.on('error', reject);
      request.end(body);
    });
  }

  // Sends the request with retries and circuit breaking. Resolves to the upstream response stream.
  // `request.timeoutMs` overrides the connection's response timeout.
  async send(entry, request) {
    const { config } = entry;
    if (!this.breakerAllows(entry)) {
      throw new HttpError(503, 'circuit_open', 'The upstream is failing and temporarily not called. Try again shortly.', {
        'retry-after': String(Math.max(1, Math.ceil((entry.breaker.openUntil - Date.now()) / 1000))),
      });
    }

    const attempts = IDEMPOTENT.has(request.method) ? Math.max(0, config.retries) + 1 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await this.once(entry, request);
        const retryable = config.retryOn.includes(response.statusCode);
        if (retryable && attempt < attempts) {
          response.resume();
          await sleep(100 * 2 ** (attempt - 1));
          continue;
        }
        this.recordResult(entry, retryable && response.statusCode >= 500);
        return response;
      } catch (error) {
        const retryable = RETRYABLE_ERRORS.has(error.code) || error.code === 'CONNECT_TIMEOUT';
        if (retryable && attempt < attempts) {
          await sleep(100 * 2 ** (attempt - 1));
          continue;
        }
        this.recordResult(entry, true);
        if (error.code === 'CONNECT_TIMEOUT') throw new HttpError(504, 'upstream_timeout', `The upstream did not accept a connection within ${config.connectTimeoutMs} ms`);
        if (error.code === 'RESPONSE_TIMEOUT') throw new HttpError(504, 'upstream_timeout', `The upstream did not respond within ${request.timeoutMs || config.timeoutMs} ms`);
        if (error.code && /CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS/.test(error.code)) {
          throw new HttpError(502, 'upstream_tls_error', 'The upstream certificate could not be verified');
        }
        throw new HttpError(502, 'bad_gateway', 'The upstream could not be reached');
      }
    }
  }

  closeAll() {
    for (const entry of this.entries.values()) this.destroy(entry);
  }
}

module.exports = { UpstreamConnections, authHeaders, DEFAULT_ID };
