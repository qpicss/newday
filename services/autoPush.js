// Pushes gateways automatically after changes. Changes in one organization are debounced into a
// single push of each of its gateways that has auto-push on, a catalog and push nodes.
// Pull nodes need nothing: they fetch the new configuration on their next poll.
//   GATEWAY_AUTO_PUSH=false turns it off; GATEWAY_AUTO_PUSH_DELAY_MS sets the debounce (default 2000).
const { Gateway } = require('../models');
const { gatewayIncludes } = require('./gatewayQueries');
const { buildGatewayConfig } = require('./gatewayConfig');
const { pushGateway } = require('./gatewayPush');

const timers = new Map();
let enabled = process.env.GATEWAY_AUTO_PUSH !== 'false';
const delayMs = () => Number(process.env.GATEWAY_AUTO_PUSH_DELAY_MS) || 2000;

const pushOrganization = async (organizationId) => {
  timers.delete(organizationId);
  const gateways = await Gateway.findAll({ where: { organizationId, autoPush: true }, include: gatewayIncludes });
  const results = [];
  for (const gateway of gateways) {
    if (!gateway.catalogId || !gateway.nodes.some((node) => node.mode !== 'pull' && node.url)) continue;
    const { hash, problems } = await buildGatewayConfig(gateway);
    if (problems.length || hash === gateway.lastPushedHash) continue;
    try {
      const result = await pushGateway(gateway);
      results.push({ gateway: gateway.name, ok: result.ok });
      console.log(JSON.stringify({ message: 'auto-push', gateway: gateway.name, ok: result.ok, version: result.version }));
    } catch (error) {
      console.error('Auto-push failed for', gateway.name, error.message);
    }
  }
  return results;
};

const scheduleAutoPush = (organizationId) => {
  if (!enabled || !organizationId) return;
  clearTimeout(timers.get(organizationId));
  const timer = setTimeout(() => {
    pushOrganization(organizationId).catch((error) => console.error('Auto-push failed:', error.message));
  }, delayMs());
  timer.unref?.();
  timers.set(organizationId, timer);
};

// Middleware: schedules an auto-push after any successful change made through the organization API.
const SKIP = /\/(push|status|credentials|renew|requests|usage|config|test|revoke|admin-ticket)(\/|$)/;
const autoPushAfterChanges = (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !SKIP.test(req.path)) {
    res.on('finish', () => {
      if (res.statusCode < 400) scheduleAutoPush(req.user?.organizationId);
    });
  }
  next();
};

const setAutoPushEnabled = (value) => {
  enabled = Boolean(value);
};

module.exports = { scheduleAutoPush, pushOrganization, autoPushAfterChanges, setAutoPushEnabled };
