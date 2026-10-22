// The checking steps of a flow: Validate request (headers and query against the OpenAPI
// operation), Validate body (the request body against the operation's requestBody) and Security
// (threats.js). A step that finds a problem answers the client itself and ends the flow.
const { validate, readParameter, formToObject } = require('./schema');
const { inspect, createFailureTracker } = require('./threats');

const CHECK_TYPES = new Set(['validateRequest', 'validateBody', 'security']);
// Live traffic always has an operation; a test has one when it runs as an API and its method and
// path match one of the API's operations.
const NO_OPERATION = 'No OpenAPI operation matches this request, so nothing was checked. In a test, choose "Run as API" and one of its paths.';

let fallbackTracker = null;

const reply = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body });
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// "application/json; charset=utf-8" against the media types an operation declares, most specific first.
const matchMediaType = (declared, contentType) => {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const keys = Object.keys(declared);
  const lower = new Map(keys.map((key) => [key.split(';')[0].trim().toLowerCase(), key]));
  if (type && lower.has(type)) return lower.get(type);
  const [major] = type.split('/');
  if (type && lower.has(`${major}/*`)) return lower.get(`${major}/*`);
  if (lower.has('*/*')) return lower.get('*/*');
  return null;
};

const isJsonType = (type) => /^application\/(.+\+)?json$/i.test(type.split(';')[0].trim()) || /\+json\b/i.test(type);

const validateRequest = (config, state, contract) => {
  if (!contract) return { outcome: NO_OPERATION };
  const parameters = (contract.parameters || []).filter((param) => (param.in === 'header' && config.headers) || (param.in === 'query' && config.query));
  const errors = [];
  for (const param of parameters) {
    const read = readParameter(param, param.in === 'header' ? state.headers : state.query || {});
    const where = { in: param.in, name: param.name };
    if (read.error) errors.push({ ...where, message: read.error });
    else if (!read.present) {
      if (param.required) errors.push({ ...where, message: 'is required' });
    } else if (!(param.allowEmptyValue && read.value === '')) {
      validate(param.schema, read.value, { request: true }).forEach((error) => errors.push({ ...where, ...(error.path && { path: error.path }), message: error.message }));
    }
  }
  if (config.query && config.rejectUnknownQuery) {
    const queryParams = (contract.parameters || []).filter((param) => param.in === 'query');
    const known = (name) => queryParams.some((param) => param.name === name
      || (param.style === 'deepObject' && name.startsWith(`${param.name}[`))
      || (param.schema?.properties && Object.prototype.hasOwnProperty.call(param.schema.properties, name) && (param.style || 'form') === 'form' && param.explode !== false));
    Object.keys(state.query || {}).filter((name) => !known(name)).forEach((name) => errors.push({ in: 'query', name, message: 'is not a declared parameter' }));
  }
  const checked = [config.headers && 'headers', config.query && 'query'].filter(Boolean).join(' and ') || 'nothing';
  if (!errors.length) return { outcome: `${plural(parameters.length, 'declared parameter')} checked (${checked}); all valid` };
  return {
    outcome: `${plural(errors.length, 'problem')} in the ${checked}; answered 422`,
    problems: errors,
    reply: reply(422, { error: 'invalid_request', message: 'The request does not match the API definition', errors }),
  };
};

const validateBody = (config, state, contract) => {
  if (!contract) return { outcome: NO_OPERATION };
  const declared = contract.body;
  const body = state.body || Buffer.alloc(0);
  if (!declared) return { outcome: 'The operation declares no request body; nothing to check' };
  const fail = (status, error, message, errors) => ({
    outcome: `${message}; answered ${status}`,
    ...(errors && { problems: errors }),
    reply: reply(status, { error, message, ...(errors && { errors }) }),
  });
  if (!body.length) {
    return declared.required ? fail(422, 'invalid_body', 'A request body is required') : { outcome: 'No body sent, and the body is optional' };
  }
  const contentType = state.headers['content-type'] || '';
  const content = declared.content || {};
  const mediaType = matchMediaType(content, contentType);
  if (!mediaType) {
    const accepted = Object.keys(content).join(', ');
    return fail(415, 'unsupported_media_type', contentType
      ? `The content type ${String(contentType).split(';')[0]} is not accepted. Send one of: ${accepted}`
      : `Send a Content-Type header, one of: ${accepted}`);
  }
  const schema = content[mediaType]?.schema;
  if (schema === undefined || schema === null) return { outcome: `${mediaType} accepted; the definition has no schema for it` };

  const text = body.toString('utf8');
  let value;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  if (isJsonType(type) || isJsonType(mediaType)) {
    try {
      value = JSON.parse(text);
    } catch {
      return fail(422, 'invalid_body', 'The request body is not valid JSON');
    }
  } else if (type === 'application/x-www-form-urlencoded') {
    value = formToObject(text, schema);
  } else if (type.startsWith('text/')) {
    value = text;
  } else {
    return { outcome: `${type || mediaType} accepted; only JSON, form and text bodies are checked against a schema` };
  }
  const errors = validate(schema, value, { request: true, rejectUnknown: config.rejectUnknown });
  if (!errors.length) return { outcome: `The ${type || mediaType} body matches the schema` };
  return fail(422, 'invalid_body', 'The request body does not match the API definition', errors.map((error) => ({ ...(error.path && { path: error.path }), message: error.message })));
};

const security = (config, state, ctx) => {
  const tracker = ctx.tracker || (fallbackTracker ||= createFailureTracker());
  const result = inspect(config, { path: state.path, query: state.query, headers: state.headers, body: state.body || Buffer.alloc(0) }, { ...ctx, tracker });
  if (result.watch) state.watches.push(result.watch);
  if (result.findings.length) ctx.onFindings?.(result.findings, Boolean(result.reply));
  const found = result.findings.map((finding) => `${finding.label} in ${finding.location}`);
  if (result.reply) {
    const { status, error, message, headers } = result.reply;
    return { outcome: `Blocked: ${found[0]}; answered ${status}`, problems: result.findings, reply: reply(status, { error, message }, headers) };
  }
  if (found.length) return { outcome: `Found ${found.join(', ')}; let through (monitor only)`, problems: result.findings };
  return { outcome: 'No threat found' };
};

// ctx: { contract, remoteAddress, clientId, tracker, scope, requestId, onFindings }
const runCheck = (node, state, ctx = {}) => {
  let result;
  if (node.type === 'validateRequest') result = validateRequest(node.config, state, ctx.contract);
  else if (node.type === 'validateBody') result = validateBody(node.config, state, ctx.contract);
  else result = security(node.config, state, ctx);
  if (result.reply && ctx.requestId) result.reply.body.requestId = ctx.requestId;
  return result;
};

module.exports = { CHECK_TYPES, runCheck, matchMediaType };
