// Per-minute usage counters for billing and the console's usage charts. Drained by whichever
// channel delivers them first (the management link, or the console reading GET /v1/usage).

const MAX_KEYS = 50000;

class UsageAggregator {
  constructor() {
    this.entries = new Map();
    this.dropped = 0;
  }

  record({ clientId, productId, apiId, status, durationMs }) {
    if (!clientId || !productId || !apiId) return;
    const minute = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const key = `${minute}|${clientId}|${productId}|${apiId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_KEYS) {
        this.dropped += 1;
        return;
      }
      entry = { minute, clientId, productId, apiId, requests: 0, errors: 0, rateLimited: 0, latencyMsTotal: 0 };
      this.entries.set(key, entry);
    }
    entry.requests += 1;
    if (status >= 500) entry.errors += 1;
    if (status === 429) entry.rateLimited += 1;
    entry.latencyMsTotal += Math.round(durationMs || 0);
  }

  drain() {
    const records = [...this.entries.values()];
    this.entries.clear();
    return records;
  }

  // Puts records back after a failed delivery so they are sent next time.
  restore(records) {
    for (const record of records) {
      const key = `${record.minute}|${record.clientId}|${record.productId}|${record.apiId}`;
      const entry = this.entries.get(key);
      if (entry) {
        entry.requests += record.requests;
        entry.errors += record.errors;
        entry.rateLimited += record.rateLimited;
        entry.latencyMsTotal += record.latencyMsTotal;
      } else if (this.entries.size < MAX_KEYS) {
        this.entries.set(key, { ...record });
      }
    }
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { UsageAggregator };
