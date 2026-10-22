// Sliding-window rate limiting (weighted current + previous fixed window).
//   LocalRateLimiter  in memory; in a cluster each node enforces its share of the limit
//   RedisRateLimiter  shared by every node through Redis (GATEWAY_REDIS_URL), so the limit is exact.
//                     If Redis is unreachable it falls back to the local limiter until Redis returns.

const PERIOD_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };

class LocalRateLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.windows = new Map();
    this.lastSweep = this.now();
    this.shared = false;
  }

  // Counts one request for `key`. Returns { allowed, limit, remaining, resetSeconds }.
  hit(key, limit, period) {
    const windowMs = PERIOD_MS[period] || PERIOD_MS.minute;
    const now = this.now();
    this.sweep(now);

    const windowStart = Math.floor(now / windowMs) * windowMs;
    let entry = this.windows.get(key);
    if (!entry || entry.windowMs !== windowMs) {
      entry = { windowMs, windowStart, count: 0, previous: 0 };
      this.windows.set(key, entry);
    }
    if (entry.windowStart !== windowStart) {
      entry.previous = windowStart - entry.windowStart === windowMs ? entry.count : 0;
      entry.count = 0;
      entry.windowStart = windowStart;
    }

    const elapsed = now - windowStart;
    const weightedPrevious = entry.previous * ((windowMs - elapsed) / windowMs);
    const used = Math.floor(weightedPrevious) + entry.count;
    const resetSeconds = Math.max(1, Math.ceil((windowMs - elapsed) / 1000));

    if (used >= limit) {
      return { allowed: false, limit, remaining: 0, resetSeconds };
    }
    entry.count += 1;
    return { allowed: true, limit, remaining: Math.max(0, limit - used - 1), resetSeconds };
  }

  // Drops windows idle for more than two periods so memory stays bounded.
  sweep(now) {
    if (now - this.lastSweep < 60000) return;
    this.lastSweep = now;
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart > entry.windowMs * 2) {
        this.windows.delete(key);
      }
    }
  }

  clear() {
    this.windows.clear();
  }

  status() {
    return { mode: 'local', shared: false };
  }

  async close() {}
}

// Atomic in Redis: read the current and previous window counters, then count the request if allowed.
const SLIDING_WINDOW = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
local limit = tonumber(ARGV[1])
local used = math.floor(previous * tonumber(ARGV[2])) + current
if used >= limit then
  return {0, used}
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return {1, used + 1}
`;

class RedisRateLimiter {
  // `client` is a node-redis v4 client (or anything with connect(), eval(script, { keys, arguments }), quit()).
  constructor({ client, prefix = 'gateway', logger, now = () => Date.now() }) {
    this.client = client;
    this.prefix = prefix;
    this.logger = logger;
    this.now = now;
    this.fallback = new LocalRateLimiter({ now });
    this.healthy = false;
    this.lastError = null;
    this.shared = true;
    this.connecting = client.connect().then(() => {
      this.healthy = true;
      logger.info('rate limits shared through Redis');
    }).catch((error) => {
      this.lastError = error.message;
      logger.error('Redis unavailable; using local rate limits', { error: error.message });
    });
    client.on?.('error', (error) => {
      if (this.healthy) logger.warn('Redis connection problem; using local rate limits', { error: error.message });
      this.healthy = false;
      this.lastError = error.message;
    });
    client.on?.('ready', () => {
      if (!this.healthy) logger.info('Redis connection restored');
      this.healthy = true;
    });
  }

  // `localShare` is the limit to enforce locally if Redis is down (the node's share).
  async hit(key, limit, period, localShare = limit) {
    const windowMs = PERIOD_MS[period] || PERIOD_MS.minute;
    const now = this.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const elapsed = now - windowStart;
    const resetSeconds = Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
    if (!this.healthy) return this.fallback.hit(key, localShare, period);
    try {
      const [allowed, used] = await this.client.eval(SLIDING_WINDOW, {
        keys: [`${this.prefix}:rl:${key}:${windowStart}`, `${this.prefix}:rl:${key}:${windowStart - windowMs}`],
        arguments: [String(limit), String((windowMs - elapsed) / windowMs), String(windowMs * 2)],
      });
      return {
        allowed: Number(allowed) === 1,
        limit,
        remaining: Math.max(0, limit - Number(used)),
        resetSeconds,
      };
    } catch (error) {
      this.healthy = false;
      this.lastError = error.message;
      this.logger.warn('Redis rate limit failed; using local rate limits', { error: error.message });
      return this.fallback.hit(key, localShare, period);
    }
  }

  status() {
    return { mode: 'redis', shared: this.healthy, healthy: this.healthy, lastError: this.lastError };
  }

  async close() {
    try {
      await this.connecting;
      await this.client.quit();
    } catch {
      // already closed
    }
  }
}

const createRateLimiter = ({ redisUrl, gatewayId, logger }) => {
  if (!redisUrl) return new LocalRateLimiter();
  // Loaded only when Redis is configured.
  const { createClient } = require('redis');
  const client = createClient({
    url: redisUrl,
    socket: { connectTimeout: 3000, reconnectStrategy: (retries) => Math.min(retries * 500, 10000) },
  });
  return new RedisRateLimiter({ client, prefix: `gateway:${gatewayId}`, logger });
};

module.exports = { LocalRateLimiter, RedisRateLimiter, createRateLimiter, PERIOD_MS, RateLimiter: LocalRateLimiter };
