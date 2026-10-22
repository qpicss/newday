// Off-loads request events to an external system in batches, so observability data does not have
// to live (only) on the gateway. Targets:
//   http  POST a JSON array of request events to any URL (log pipeline, SIEM, webhook)
//   otlp  POST OpenTelemetry logs (OTLP/HTTP JSON) to a collector, e.g. http://collector:4318/v1/logs
// Delivery failures are retried with backoff; when the queue is full the oldest events are dropped.

const MAX_BACKOFF_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;

const attribute = (key, value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
};

// One OTLP log record per request, correlated with the trace.
const toOtlp = (events, resource) => ({
  resourceLogs: [{
    resource: {
      attributes: [
        attribute('service.name', 'oauth-server-gateway'),
        attribute('service.instance.id', resource.nodeName),
        attribute('gateway.id', resource.gatewayId),
        attribute('gateway.name', resource.gatewayName),
      ].filter(Boolean),
    },
    scopeLogs: [{
      scope: { name: 'oauth-server-gateway', version: '1.0.0' },
      logRecords: events.map((event) => ({
        timeUnixNano: `${BigInt(Date.parse(event.time)) * 1000000n}`,
        severityNumber: event.status >= 500 ? 17 : event.status >= 400 ? 13 : 9,
        severityText: event.status >= 500 ? 'ERROR' : event.status >= 400 ? 'WARN' : 'INFO',
        body: { stringValue: `${event.method} ${event.path} ${event.status}` },
        traceId: event.traceId,
        spanId: event.spanId,
        attributes: [
          attribute('http.request.method', event.method),
          attribute('url.path', event.path),
          attribute('http.response.status_code', event.status),
          attribute('gateway.handler', event.handler),
          attribute('gateway.api', event.api),
          attribute('gateway.product', event.product),
          attribute('client.id', event.clientId),
          attribute('client.application', event.application),
          attribute('request.id', event.requestId),
          attribute('duration_ms', event.durationMs),
          attribute('upstream.duration_ms', event.upstreamMs),
          attribute('policy.duration_ms', event.policyMs),
          attribute('error.type', event.error),
          attribute('client.address', event.remoteAddress),
        ].filter(Boolean),
      })),
    }],
  }],
});

class Offloader {
  constructor({ logger, metrics, resource }) {
    this.logger = logger;
    this.metrics = metrics;
    this.resource = resource;
    this.target = { type: 'none' };
    this.queue = [];
    this.timer = null;
    this.flushing = false;
    this.backoffMs = 0;
    this.stats = { sent: 0, failed: 0, dropped: 0, lastError: null, lastSuccessAt: null, lastAttemptAt: null };
  }

  configure(offload = {}) {
    const type = ['http', 'otlp'].includes(offload.type) ? offload.type : 'none';
    this.target = {
      type,
      url: offload.url || null,
      headers: offload.headers || {},
      batchSize: Math.min(5000, Math.max(1, Number(offload.batchSize) || 100)),
      flushIntervalMs: Math.min(300000, Math.max(500, Number(offload.flushIntervalMs) || 5000)),
      maxQueue: Math.min(200000, Math.max(100, Number(offload.maxQueue) || 10000)),
      sampleRate: Math.min(1, Math.max(0, offload.sampleRate === undefined ? 1 : Number(offload.sampleRate))),
    };
    if (type === 'none' || !this.target.url) {
      this.queue = [];
      this.stop();
      return;
    }
    this.schedule(this.target.flushIntervalMs);
  }

  get active() {
    return this.target.type !== 'none' && Boolean(this.target.url);
  }

  enqueue(event) {
    if (!this.active) return;
    if (this.target.sampleRate < 1 && Math.random() >= this.target.sampleRate) return;
    this.queue.push(event);
    while (this.queue.length > this.target.maxQueue) {
      this.queue.shift();
      this.stats.dropped += 1;
      this.metrics.offloadDropped.inc();
    }
    if (this.queue.length >= this.target.batchSize && !this.backoffMs) this.schedule(0);
  }

  schedule(delayMs) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delayMs);
    this.timer.unref();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  async flush() {
    if (this.flushing || !this.active) return;
    if (!this.queue.length) {
      this.schedule(this.target.flushIntervalMs);
      return;
    }
    this.flushing = true;
    const batch = this.queue.splice(0, this.target.batchSize);
    this.stats.lastAttemptAt = new Date().toISOString();
    try {
      const body = this.target.type === 'otlp' ? toOtlp(batch, this.resource) : batch;
      const response = await fetch(this.target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.target.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`The off-load target answered HTTP ${response.status}`);
      await response.arrayBuffer();
      this.stats.sent += batch.length;
      this.stats.lastSuccessAt = new Date().toISOString();
      this.stats.lastError = null;
      this.metrics.offloadSent.inc({}, batch.length);
      this.backoffMs = 0;
    } catch (error) {
      // Put the batch back in front so order is kept, then back off.
      this.queue.unshift(...batch);
      while (this.queue.length > this.target.maxQueue) {
        this.queue.shift();
        this.stats.dropped += 1;
        this.metrics.offloadDropped.inc();
      }
      this.stats.failed += 1;
      this.stats.lastError = error.name === 'TimeoutError' ? 'The off-load target did not answer in time' : error.message;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(1000, this.backoffMs * 2));
      this.logger.warn('off-load failed', { target: this.target.type, error: this.stats.lastError, retryInMs: this.backoffMs });
    } finally {
      this.flushing = false;
    }
    this.schedule(this.backoffMs || (this.queue.length >= this.target.batchSize ? 0 : this.target.flushIntervalMs));
  }

  // Sends what is queued before shutdown (best effort, one attempt).
  async drain() {
    this.stop();
    if (this.active && this.queue.length) {
      this.backoffMs = 0;
      await this.flush();
      this.stop();
    }
  }

  status() {
    return {
      type: this.target.type,
      url: this.target.url,
      active: this.active,
      queued: this.queue.length,
      sampleRate: this.target.sampleRate,
      ...this.stats,
    };
  }
}

module.exports = { Offloader, toOtlp };
