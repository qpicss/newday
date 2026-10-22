// Recent requests kept in memory for the admin UI and the console's live view.
// Subscribers (server-sent event streams) receive every new entry.

class RequestLog {
  constructor(size = 500) {
    this.size = size;
    this.enabled = true;
    this.entries = [];
    this.sequence = 0;
    this.subscribers = new Set();
  }

  configure({ enabled = true, size = 500 } = {}) {
    this.enabled = enabled !== false;
    this.size = Math.min(10000, Math.max(10, Number(size) || 500));
    if (!this.enabled) this.entries = [];
    if (this.entries.length > this.size) this.entries = this.entries.slice(-this.size);
  }

  add(event) {
    if (!this.enabled) return;
    this.sequence += 1;
    const entry = { seq: this.sequence, ...event };
    this.entries.push(entry);
    if (this.entries.length > this.size) this.entries.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  // Newest first. Filters: since (sequence), status ('2xx'...'5xx' or number), api, client, text.
  list({ since = 0, limit = 100, status, api, client, text } = {}) {
    const max = Math.min(1000, Math.max(1, Number(limit) || 100));
    const result = [];
    for (let i = this.entries.length - 1; i >= 0 && result.length < max; i -= 1) {
      const entry = this.entries[i];
      if (entry.seq <= since) break;
      if (status && !(String(entry.status) === String(status) || `${Math.floor(entry.status / 100)}xx` === status)) continue;
      if (api && entry.api !== api) continue;
      if (client && entry.clientId !== client && entry.application !== client) continue;
      if (text && !`${entry.method} ${entry.path} ${entry.requestId} ${entry.traceId} ${entry.error || ''}`.toLowerCase().includes(String(text).toLowerCase())) continue;
      result.push(entry);
    }
    return { enabled: this.enabled, size: this.size, latest: this.sequence, entries: result };
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
}

module.exports = { RequestLog };
