// Runtime settings from environment variables. Everything else (APIs, ports, policies)
// arrives from the management console.
const path = require('path');

const toNumber = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const toBoolean = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
};

const loadSettings = (env = process.env) => ({
  // mTLS endpoint the management console pushes configuration to
  managementHost: env.GATEWAY_MANAGEMENT_HOST || '0.0.0.0',
  managementPort: toNumber(env.GATEWAY_MANAGEMENT_PORT, 9443),
  // The console's link address; set it to let the node register and pull its configuration
  managementUrl: env.GATEWAY_MANAGEMENT_URL || null,
  nodeName: env.GATEWAY_NODE_NAME || null,
  // Management address of this node that the console can push to (optional in pull mode)
  advertiseUrl: env.GATEWAY_ADVERTISE_URL || null,
  pollIntervalMs: toNumber(env.GATEWAY_POLL_INTERVAL_MS, 15000),
  heartbeatIntervalMs: toNumber(env.GATEWAY_HEARTBEAT_INTERVAL_MS, 30000),
  usageIntervalMs: toNumber(env.GATEWAY_USAGE_INTERVAL_MS, 60000),
  // Plain HTTP liveness/readiness probes and Prometheus metrics
  healthHost: env.GATEWAY_HEALTH_HOST || '0.0.0.0',
  healthPort: toNumber(env.GATEWAY_HEALTH_PORT, 9080),
  // Admin UI (HTTPS), signed in with org admin credentials
  adminEnabled: toBoolean(env.GATEWAY_ADMIN_ENABLED, true),
  adminHost: env.GATEWAY_ADMIN_HOST || '0.0.0.0',
  adminPort: toNumber(env.GATEWAY_ADMIN_PORT, 9445),
  // Address the connection handlers (API traffic ports) bind to
  bindHost: env.GATEWAY_BIND_HOST || '0.0.0.0',
  credentialsFile: path.resolve(env.GATEWAY_CREDENTIALS || 'credentials.json'),
  dataDir: path.resolve(env.GATEWAY_DATA_DIR || 'data'),
  maxBodyBytes: toNumber(env.GATEWAY_MAX_BODY_BYTES, 10 * 1024 * 1024),
  upstreamTimeoutMs: toNumber(env.GATEWAY_UPSTREAM_TIMEOUT_MS, 30000),
  // Shared rate limits across a cluster
  redisUrl: env.GATEWAY_REDIS_URL || null,
  // Worker threads that run policies; a stuck policy only blocks and restarts its own worker
  policyWorkers: toNumber(env.GATEWAY_POLICY_WORKERS, 2),
  logLevel: env.GATEWAY_LOG_LEVEL || 'info',
});

module.exports = { loadSettings };
