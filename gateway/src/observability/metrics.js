// Prometheus metrics (text exposition format 0.0.4) plus a short in-memory time series for the
// admin UI charts. Labels use API, product and handler names, never raw paths, to keep cardinality low.

const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labelText = (names, values) => (names.length
  ? `{${names.map((name, index) => `${name}="${escapeLabel(values[index] ?? '')}"`).join(',')}}`
  : '');

class Counter {
  constructor(name, help, labelNames = []) {
    Object.assign(this, { name, help, labelNames, type: 'counter', values: new Map() });
  }

  inc(labels = {}, amount = 1) {
    const values = this.labelNames.map((name) => labels[name] ?? '');
    const key = JSON.stringify(values);
    const entry = this.values.get(key) || { values, value: 0 };
    entry.value += amount;
    this.values.set(key, entry);
  }

  render() {
    return [...this.values.values()].map((entry) => `${this.name}${labelText(this.labelNames, entry.values)} ${entry.value}`);
  }
}

class Gauge extends Counter {
  constructor(name, help, labelNames = []) {
    super(name, help, labelNames);
    this.type = 'gauge';
  }

  set(labels = {}, value = 0) {
    const values = this.labelNames.map((name) => labels[name] ?? '');
    this.values.set(JSON.stringify(values), { values, value });
  }

  reset() {
    this.values.clear();
  }
}

class Histogram {
  constructor(name, help, labelNames = [], buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
    Object.assign(this, { name, help, labelNames, buckets, type: 'histogram', values: new Map() });
  }

  observe(labels = {}, seconds = 0) {
    const values = this.labelNames.map((name) => labels[name] ?? '');
    const key = JSON.stringify(values);
    let entry = this.values.get(key);
    if (!entry) {
      entry = { values, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.values.set(key, entry);
    }
    this.buckets.forEach((bound, index) => {
      if (seconds <= bound) entry.counts[index] += 1;
    });
    entry.sum += seconds;
    entry.count += 1;
  }

  render() {
    const lines = [];
    for (const entry of this.values.values()) {
      this.buckets.forEach((bound, index) => {
        lines.push(`${this.name}_bucket${labelText([...this.labelNames, 'le'], [...entry.values, String(bound)])} ${entry.counts[index]}`);
      });
      lines.push(`${this.name}_bucket${labelText([...this.labelNames, 'le'], [...entry.values, '+Inf'])} ${entry.count}`);
      lines.push(`${this.name}_sum${labelText(this.labelNames, entry.values)} ${entry.sum}`);
      lines.push(`${this.name}_count${labelText(this.labelNames, entry.values)} ${entry.count}`);
    }
    return lines;
  }
}

// 10-second buckets for the last 30 minutes: request count, errors, latency samples.
const BUCKET_MS = 10000;
const BUCKETS = 180;
const MAX_SAMPLES = 200;

class TimeSeries {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.buckets = new Map();
  }

  record(status, durationMs) {
    const start = Math.floor(this.now() / BUCKET_MS) * BUCKET_MS;
    let bucket = this.buckets.get(start);
    if (!bucket) {
      bucket = { start, requests: 0, errors: 0, rateLimited: 0, samples: [] };
      this.buckets.set(start, bucket);
      const oldest = start - BUCKET_MS * BUCKETS;
      for (const key of this.buckets.keys()) if (key <= oldest) this.buckets.delete(key);
    }
    bucket.requests += 1;
    if (status >= 500) bucket.errors += 1;
    if (status === 429) bucket.rateLimited += 1;
    if (bucket.samples.length < MAX_SAMPLES) bucket.samples.push(durationMs);
    else bucket.samples[Math.floor(Math.random() * MAX_SAMPLES)] = durationMs;
  }

  // One point per bucket for the requested window, oldest first, including empty buckets.
  series(minutes = 15) {
    const count = Math.min(BUCKETS, Math.ceil((minutes * 60000) / BUCKET_MS));
    const current = Math.floor(this.now() / BUCKET_MS) * BUCKET_MS;
    const percentile = (samples, p) => {
      if (!samples.length) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10;
    };
    const points = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const start = current - i * BUCKET_MS;
      const bucket = this.buckets.get(start);
      points.push({
        time: new Date(start).toISOString(),
        requests: bucket?.requests || 0,
        errors: bucket?.errors || 0,
        rateLimited: bucket?.rateLimited || 0,
        p50: bucket ? percentile(bucket.samples, 0.5) : null,
        p95: bucket ? percentile(bucket.samples, 0.95) : null,
      });
    }
    return { bucketSeconds: BUCKET_MS / 1000, points };
  }
}

const createMetrics = () => {
  const registry = [];
  const add = (metric) => {
    registry.push(metric);
    return metric;
  };
  const metrics = {
    requests: add(new Counter('gateway_requests_total', 'Requests handled, by API, handler and status class', ['api', 'handler', 'status_class'])),
    duration: add(new Histogram('gateway_request_duration_seconds', 'Time from request received to response sent', ['api'])),
    upstreamDuration: add(new Histogram('gateway_upstream_duration_seconds', 'Time spent waiting for the upstream', ['api'])),
    upstreamErrors: add(new Counter('gateway_upstream_errors_total', 'Upstream calls that failed', ['api', 'reason'])),
    policyErrors: add(new Counter('gateway_policy_errors_total', 'Policy runs that failed', ['policy', 'reason'])),
    rateLimited: add(new Counter('gateway_rate_limited_total', 'Requests rejected by a product rate limit', ['product'])),
    threats: add(new Counter('gateway_threats_total', 'Requests a Security step found a threat in', ['rule', 'action'])),
    authFailures: add(new Counter('gateway_auth_failures_total', 'Requests rejected for a missing or invalid token, or no access', ['reason'])),
    circuitOpen: add(new Gauge('gateway_circuit_open', '1 while the circuit breaker of a connection is open', ['connection'])),
    configInfo: add(new Gauge('gateway_config_info', 'Configuration version currently applied', ['version'])),
    offloadDropped: add(new Counter('gateway_offload_dropped_total', 'Request events dropped because the off-load queue was full', [])),
    offloadSent: add(new Counter('gateway_offload_sent_total', 'Request events delivered to the off-load target', [])),
  };
  const series = new TimeSeries();

  const render = () => {
    const memory = process.memoryUsage();
    const lines = [];
    for (const metric of registry) {
      lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`, ...metric.render());
    }
    lines.push(
      '# HELP process_resident_memory_bytes Resident memory size in bytes', '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${memory.rss}`,
      '# HELP nodejs_heap_used_bytes V8 heap in use', '# TYPE nodejs_heap_used_bytes gauge', `nodejs_heap_used_bytes ${memory.heapUsed}`,
      '# HELP process_uptime_seconds Seconds since the gateway started', '# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round(process.uptime())}`,
    );
    return `${lines.join('\n')}\n`;
  };

  return { ...metrics, series, render };
};

module.exports = { createMetrics, Counter, Gauge, Histogram, TimeSeries };
