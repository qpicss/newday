// What a gateway still needs before it serves a catalog, shown as a checklist in the console.

// "Running": a pull node with a recent heartbeat, or a push node whose last contact worked.
// (Attaching to a catalog checks the nodes live; see isGatewayRunning in services/gatewayPush.js.)
const RUNNING_WINDOW_MS = 2 * 60 * 1000;
const isRecentlySeen = (gateway) => (gateway.nodes || []).some((node) => {
  if (!node.lastSeenAt) return false;
  if (node.mode === 'pull' || !node.url) return Date.now() - new Date(node.lastSeenAt).getTime() < RUNNING_WINDOW_MS;
  return !node.lastError;
});

const SETUP_STEPS = [
  { key: 'port', title: 'Open a port for API traffic', done: (gateway) => (gateway.handlers || []).length > 0 },
  { key: 'credentials', title: 'Download the credentials', done: (gateway) => Boolean(gateway.credentialsIssuedAt) },
  { key: 'node', title: 'Start a node', done: (gateway, running) => running },
  { key: 'catalog', title: 'Attach it to a catalog', done: (gateway) => Boolean(gateway.catalogId || gateway.catalog) },
];

// { running, steps: [{ key, title, done }], next (first step not done, or null), doneCount, total }
const gatewaySetup = (gateway) => {
  const running = isRecentlySeen(gateway);
  const steps = SETUP_STEPS.map((step) => ({ key: step.key, title: step.title, done: step.done(gateway, running) }));
  const next = steps.find((step) => !step.done) || null;
  return { running, steps, next, doneCount: steps.filter((step) => step.done).length, total: steps.length };
};

module.exports = { isRecentlySeen, gatewaySetup };
