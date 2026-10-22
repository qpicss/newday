// Observability built into the gateway: metrics, time series, request log, usage and off-loading.
// Every finished request goes through record().
const { createMetrics } = require('./metrics');
const { RequestLog } = require('./requestLog');
const { Offloader } = require('./offload');
const { UsageAggregator } = require('./usage');

const DEFAULTS = {
  requestLog: { enabled: true, size: 500 },
  metrics: { enabled: true },
  offload: { type: 'none' },
};

const createObservability = ({ logger, resource }) => {
  const metrics = createMetrics();
  const requestLog = new RequestLog(DEFAULTS.requestLog.size);
  const usage = new UsageAggregator();
  const offloader = new Offloader({ logger, metrics, resource });
  let settings = DEFAULTS;

  const configure = (observability = {}) => {
    settings = {
      requestLog: { ...DEFAULTS.requestLog, ...(observability.requestLog || {}) },
      metrics: { ...DEFAULTS.metrics, ...(observability.metrics || {}) },
      offload: { ...DEFAULTS.offload, ...(observability.offload || {}) },
    };
    requestLog.configure(settings.requestLog);
    offloader.configure(settings.offload);
  };

  const record = (event) => {
    const statusClass = `${Math.floor(event.status / 100)}xx`;
    metrics.requests.inc({ api: event.api || 'none', handler: event.handler, status_class: statusClass });
    metrics.duration.observe({ api: event.api || 'none' }, event.durationMs / 1000);
    if (event.upstreamMs !== undefined) metrics.upstreamDuration.observe({ api: event.api || 'none' }, event.upstreamMs / 1000);
    metrics.series.record(event.status, event.durationMs);
    usage.record(event);
    requestLog.add(event);
    offloader.enqueue(event);
    logger.info('request', {
      requestId: event.requestId,
      traceId: event.traceId,
      handler: event.handler,
      method: event.method,
      path: event.path,
      api: event.api,
      clientId: event.clientId,
      status: event.status,
      durationMs: event.durationMs,
      ...(event.upstream && { upstream: event.upstream.map((call) => `${call.method} ${call.url} -> ${call.status || call.error}`) }),
      ...(event.threats && { threats: event.threats }),
      ...(event.error && { error: event.error }),
    });
  };

  return {
    configure,
    record,
    metrics,
    requestLog,
    usage,
    offloader,
    metricsEnabled: () => settings.metrics.enabled !== false,
    settings: () => settings,
  };
};

module.exports = { createObservability, DEFAULTS };
