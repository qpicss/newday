// Reads usage from push nodes on a timer (pull nodes report it over the link themselves).
//   GATEWAY_USAGE_COLLECT_MS: interval, default 60000; 0 turns it off.
const { Gateway } = require('../models');
const { gatewayIncludes } = require('./gatewayQueries');
const { collectUsage } = require('./gatewayPush');

const startUsageCollector = () => {
  const intervalMs = Number(process.env.GATEWAY_USAGE_COLLECT_MS ?? 60000);
  if (!intervalMs) return null;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const gateways = await Gateway.findAll({ include: gatewayIncludes });
      for (const gateway of gateways) {
        if (gateway.nodes.some((node) => node.mode !== 'pull' && node.url)) await collectUsage(gateway);
      }
    } catch (error) {
      console.error('Usage collection failed:', error.message);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
};

module.exports = { startUsageCollector };
