// mTLS endpoint for the management console. Both sides use certificates issued by the
// management console's self-signed CA: the gateway only accepts the management client
// certificate, and management only accepts a server certificate naming this gateway.
//
//   PUT  /v1/config        apply a configuration
//   PUT  /v1/credentials   install renewed gateway credentials (no re-download needed)
//   GET  /v1/status        version, handlers, connections, observability, link state
//   GET  /v1/usage         usage counters since the last read (and resets them)
//   GET  /v1/requests      recent requests from the request log (?since=&limit=&status=&api=)
//   POST /v1/policy-test   run a policy flow against a sample request without deploying it
const https = require('https');
const { readBody, sendJson, HttpError } = require('./http');
const { MANAGEMENT_COMMON_NAME } = require('./credentials');
const { ConfigError } = require('./runtime');
const { PolicyError } = require('./policy');

const MAX_CONFIG_BYTES = 50 * 1024 * 1024;

const readJson = async (req, limit = MAX_CONFIG_BYTES) => {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON');
  }
};

const createManagementServer = ({ credentials, logger, actions }) => {
  const handle = async (req, res) => {
    const peer = req.socket.getPeerCertificate();
    if (!req.client.authorized || peer?.subject?.CN !== MANAGEMENT_COMMON_NAME) {
      logger.warn('management request rejected', { peer: peer?.subject?.CN || null });
      sendJson(res, 403, { error: 'forbidden', message: 'Only the management console may call this endpoint' });
      return;
    }

    const url = new URL(req.url, 'https://gateway.invalid');
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case 'GET /v1/status':
          sendJson(res, 200, actions.status());
          return;
        case 'PUT /v1/config':
          sendJson(res, 200, await actions.applyConfig(await readJson(req)));
          return;
        case 'PUT /v1/credentials':
          sendJson(res, 200, await actions.applyCredentials(await readJson(req, 1024 * 1024)));
          return;
        case 'GET /v1/usage':
          sendJson(res, 200, { records: actions.drainUsage() });
          return;
        case 'GET /v1/requests':
          sendJson(res, 200, actions.listRequests(Object.fromEntries(url.searchParams)));
          return;
        case 'POST /v1/policy-test': {
          sendJson(res, 200, await actions.testFlow(await readJson(req, 8 * 1024 * 1024)));
          return;
        }
        default:
          sendJson(res, 404, { error: 'not_found', message: 'Unknown management endpoint' });
      }
    } catch (error) {
      if (error instanceof ConfigError) {
        logger.warn('request from management rejected', { route, error: error.message });
        sendJson(res, 400, { error: 'invalid_configuration', message: error.message });
        return;
      }
      if (error instanceof PolicyError) {
        sendJson(res, 422, { error: 'policy_error', message: error.message, logs: error.logs });
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
        return;
      }
      logger.error('management request failed', { route, error: error.message });
      sendJson(res, 500, { error: 'internal_error', message: 'The gateway could not complete the request' });
    }
  };

  return https.createServer({
    key: credentials.privateKey,
    cert: credentials.certificate,
    ca: [credentials.managementCa],
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  }, handle);
};

module.exports = { createManagementServer };
