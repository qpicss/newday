// The gateway's own connection to the management console ("link"), over mTLS with the gateway
// certificate. Used to register the node, pull configuration, send heartbeats, report usage,
// fetch renewed credentials, check admin UI sign-ins and pick up work from the console (flow tests),
// which a pull node can't receive any other way.
//
// The console address comes from GATEWAY_MANAGEMENT_URL, or from the last pushed configuration.
// With GATEWAY_MANAGEMENT_URL set, a node needs no inbound management port at all ("pull" mode).
const https = require('https');
const os = require('os');
const { MANAGEMENT_COMMON_NAME } = require('./credentials');

const REQUEST_TIMEOUT_MS = 10000;
// Tasks are long-polled: the console holds the request open until it has work (or 25 s pass).
const TASK_WAIT_SECONDS = 25;
const TASK_RETRY_MS = 5000;
const SOFTWARE_VERSION = require('../package.json').version;

class LinkError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

class ManagementLink {
  constructor({ settings, getCredentials, logger, onConfig, onRenewal, getStatus, usage, onTask }) {
    this.settings = settings;
    this.getCredentials = getCredentials;
    this.logger = logger;
    this.onConfig = onConfig;
    this.onRenewal = onRenewal;
    this.getStatus = getStatus;
    this.usage = usage;
    this.onTask = onTask;
    this.configuredUrl = settings.managementUrl || null;
    this.pushedUrl = null;
    this.nodeName = settings.nodeName || os.hostname();
    this.timers = [];
    this.inflight = new Set();
    this.running = false;
    this.state = { registered: false, lastContactAt: null, lastError: null, currentVersion: null };
  }

  get url() {
    return this.configuredUrl || this.pushedUrl;
  }

  // Called when a pushed configuration names the console's link address.
  setPushedUrl(url) {
    const changed = url && url !== this.pushedUrl;
    this.pushedUrl = url || null;
    if (changed && !this.configuredUrl && this.running) this.register();
  }

  request(method, path, body, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const base = this.url;
    if (!base) return Promise.reject(new LinkError('No management console address is known. Set GATEWAY_MANAGEMENT_URL or push a configuration.'));
    const credentials = this.getCredentials();
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method,
        key: credentials.privateKey,
        cert: credentials.certificate,
        ca: [credentials.managementCa],
        agent: false,
        timeout: timeoutMs,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (host, cert) => (cert?.subject?.CN === MANAGEMENT_COMMON_NAME
          ? undefined
          : new Error(`The console address answered with the certificate of ${cert?.subject?.CN || 'an unknown server'}`)),
        headers: {
          ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...(method === 'GET' && path.startsWith('/v1/config') && this.state.currentVersion && { 'if-none-match': `"${this.state.currentVersion}"` }),
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // not JSON
          }
          this.state.lastContactAt = new Date().toISOString();
          if (response.statusCode === 304) {
            resolve({ status: 304, body: null });
            return;
          }
          if (response.statusCode >= 400) {
            reject(new LinkError(json?.error || `The console answered HTTP ${response.statusCode}`, response.statusCode));
            return;
          }
          resolve({ status: response.statusCode, body: json });
        });
      });
      this.inflight.add(request);
      request.on('close', () => this.inflight.delete(request));
      request.on('timeout', () => request.destroy(new LinkError('The console did not answer in time')));
      request.on('error', (error) => reject(error instanceof LinkError ? error : new LinkError(`The console could not be reached: ${error.message}`)));
      request.end(payload);
    });
  }

  async register() {
    try {
      const status = this.getStatus();
      await this.request('POST', '/v1/register', {
        nodeName: this.nodeName,
        advertiseUrl: this.settings.advertiseUrl || null,
        softwareVersion: SOFTWARE_VERSION,
        version: status.version,
        certificateFingerprint: this.getCredentials().fingerprint,
      });
      this.state.registered = true;
      this.state.lastError = null;
      this.logger.info('registered with the management console', { url: this.url, nodeName: this.nodeName });
    } catch (error) {
      this.state.lastError = error.message;
      this.logger.warn('could not register with the management console', { url: this.url, error: error.message });
    }
  }

  async pollConfig() {
    try {
      const response = await this.request('GET', '/v1/config');
      if (response.status === 200 && response.body?.config) {
        await this.onConfig(response.body.config);
      }
      this.state.lastError = null;
    } catch (error) {
      this.state.lastError = error.message;
      if (error.status !== 409) this.logger.warn('configuration poll failed', { error: error.message });
    }
  }

  async heartbeat() {
    try {
      const status = this.getStatus();
      const response = await this.request('POST', '/v1/heartbeat', {
        nodeName: this.nodeName,
        version: status.version,
        softwareVersion: SOFTWARE_VERSION,
        certificateFingerprint: this.getCredentials().fingerprint,
        certificateValidTo: status.certificateValidTo,
        uptimeSeconds: status.uptimeSeconds,
        stats: status.stats,
        handlers: status.handlers,
      });
      if (response.body?.renewalAvailable) await this.fetchRenewal();
    } catch (error) {
      this.state.lastError = error.message;
    }
  }

  async fetchRenewal() {
    try {
      const response = await this.request('GET', '/v1/credentials');
      if (response.body?.credentials) await this.onRenewal(response.body.credentials);
    } catch (error) {
      this.logger.warn('could not fetch renewed credentials', { error: error.message });
    }
  }

  async reportUsage() {
    const records = this.usage.drain();
    if (!records.length) return;
    try {
      await this.request('POST', '/v1/usage', { nodeName: this.nodeName, records });
    } catch (error) {
      this.usage.restore(records);
      this.logger.warn('usage report failed; will retry', { error: error.message, records: records.length });
    }
  }

  // Signs an org admin into the gateway admin UI. Resolves to the user, or throws a LinkError.
  async verifyAdmin(email, password) {
    const response = await this.request('POST', '/v1/admin-login', { email, password, nodeName: this.nodeName });
    return response.body.user;
  }

  // Runs console tasks one after another while the link is up (pull mode only).
  async taskLoop() {
    while (this.running && this.onTask) {
      if (!this.url) {
        await this.pause(TASK_RETRY_MS);
        continue;
      }
      try {
        const response = await this.request('GET', `/v1/tasks?wait=${TASK_WAIT_SECONDS}&node=${encodeURIComponent(this.nodeName)}`, undefined, { timeoutMs: (TASK_WAIT_SECONDS + 10) * 1000 });
        const task = response.status === 200 ? response.body?.task : null;
        if (task) {
          const result = await this.onTask(task);
          await this.request('POST', `/v1/tasks/${encodeURIComponent(task.id)}/result`, { result });
        }
      } catch (error) {
        if (this.running) this.logger.debug?.('task poll failed', { error: error.message });
        await this.pause(TASK_RETRY_MS);
      }
    }
  }

  pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this.timers.push(timer);
    });
  }

  every(intervalMs, task) {
    let timer;
    const loop = async () => {
      if (!this.running) return;
      if (this.url) await task();
      timer = setTimeout(loop, intervalMs);
      timer.unref();
      this.timers.push(timer);
    };
    timer = setTimeout(loop, intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  async start() {
    this.running = true;
    if (this.url) {
      await this.register();
      await this.pollConfig();
    }
    this.every(this.settings.pollIntervalMs, () => this.pollConfig());
    this.every(this.settings.heartbeatIntervalMs, () => this.heartbeat());
    this.every(this.settings.usageIntervalMs, () => this.reportUsage());
    if (this.configuredUrl) this.taskLoop();
  }

  async stop() {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    // A waiting task poll would otherwise keep the process alive for up to half a minute.
    for (const request of this.inflight) request.destroy();
    this.timers = [];
    // Last chance to deliver usage counted since the previous report.
    if (this.url) await this.reportUsage();
  }

  status() {
    return { url: this.url, source: this.configuredUrl ? 'environment' : this.pushedUrl ? 'configuration' : null, nodeName: this.nodeName, ...this.state };
  }
}

module.exports = { ManagementLink, LinkError, SOFTWARE_VERSION };
