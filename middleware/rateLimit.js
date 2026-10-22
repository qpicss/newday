// Small in-memory, per-IP rate limiter. State is per process, so use a shared
// store (e.g. Redis) instead if the app is ever run as multiple instances.
const limiters = new Set();

const createRateLimiter = ({ windowMs, max, message, skipSuccessful = false }) => {
  const hits = new Map();

  const pruneExpired = (now) => {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) {
        hits.delete(key);
      }
    }
  };

  const middleware = (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10000) {
      pruneExpired(now);
    }

    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    if (entry.count >= max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }

    // Count up front so parallel requests cannot slip past the limit,
    // then give the attempt back if it succeeded.
    entry.count += 1;
    if (skipSuccessful) {
      res.on('finish', () => {
        if (res.statusCode < 400 && entry.count > 0) {
          entry.count -= 1;
        }
      });
    }
    next();
  };

  middleware.reset = () => hits.clear();
  limiters.add(middleware);
  return middleware;
};

const resetRateLimits = () => {
  limiters.forEach((limiter) => limiter.reset());
};

module.exports = { createRateLimiter, resetRateLimits };
