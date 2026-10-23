// The console keeps track of the nodes it connects to (push nodes): on a timer it asks each one for
// its status over mTLS, records whether it answered (lastSeenAt / lastError), and sends the deployed
// configuration again to a node that answers with an older one (for example after it was recreated
// with an empty data volume). Pull nodes report themselves with heartbeats over the link instead.
//   GATEWAY_MONITOR_MS: interval, default 30000; 0 turns it off.
const { Gateway } = require('../models');
const { gatewayIncludes } = require('./gatewayQueries');
const { buildGatewayConfig } = require('./gatewayConfig');
const { gatewayStatus, pushToNode, pushNodesOf, revokedFingerprints } = require('./gatewayPush');
const { getPki } = require('../utils/pki');

// Checks the push nodes of `gateway` (or just `only`) and brings the ones that answer up to the
// deployed configuration. Only the configuration that was last pushed is sent again: changes that
// were never pushed stay undeployed. Resolves to [{ id, name, reachable, error, resent }].
const checkGateway = async (gateway, { only = pushNodesOf(gateway) } = {}) => {
  if (!only.length) return [];
  const statuses = await gatewayStatus(gateway, { only });
  const deployed = gateway.lastPushedHash ? gateway.lastPushedHash.slice(0, 12) : null;
  const behind = statuses.filter((status) => status.reachable && deployed && status.status?.version !== deployed);

  const resent = new Set();
  if (behind.length) {
    const { config, hash, problems } = await buildGatewayConfig(gateway);
    if (!problems.length && hash === gateway.lastPushedHash) {
      const pki = await getPki();
      const revoked = await revokedFingerprints(gateway.id);
      for (const status of behind) {
        const node = only.find((item) => item.id === status.id);
        const result = await pushToNode(node, gateway.id, config, { pki, revoked });
        if (result.status !== 'error') resent.add(node.id);
      }
    }
  }
  return statuses.map((status) => ({ id: status.id, name: status.name, reachable: status.reachable, error: status.error, resent: resent.has(status.id) }));
};

const checkAllGateways = async () => {
  const gateways = await Gateway.findAll({ include: gatewayIncludes });
  for (const gateway of gateways) {
    if (!pushNodesOf(gateway).length) continue;
    try {
      const results = await checkGateway(gateway);
      for (const result of results.filter((item) => item.resent)) {
        console.log(`Gateway monitor: sent the deployed configuration of ${gateway.name} to ${result.name} again`);
      }
    } catch (error) {
      console.error(`Gateway monitor: checking ${gateway.name} failed:`, error.message);
    }
  }
};

const startGatewayMonitor = () => {
  const intervalMs = Number(process.env.GATEWAY_MONITOR_MS ?? 30000);
  if (!intervalMs) return null;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await checkAllGateways();
    } catch (error) {
      console.error('Gateway monitor failed:', error.message);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
};

module.exports = { checkGateway, checkAllGateways, startGatewayMonitor };
