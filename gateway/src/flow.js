// Policy flows: the graph of steps a gateway runs for an API request.
//
//   Input -> steps -> Output, joined by directed lines (edges). Step types:
//     script   a JavaScript module (policy.js) that reads and changes callcontext
//     if       sends the request down its "true" or "false" line, by conditions
//     invoke   calls an HTTP service (the API's backend or any URL)
//     validateRequest  checks headers and query against the API's OpenAPI operation (422 if not)
//     validateBody     checks the body against the operation's requestBody schema (422 or 415 if not)
//     security         blocks injection attempts, oversized input, listed addresses and brute force
//   Output answers the client with callcontext.response, or, when no step set one, with the
//   request itself (so a new API returns exactly what it receives until someone adds logic).
//
// Shared by the console (validation on save, problems before a push, the editor in the
// browser as /js/flow.js) and the gateway (validation of a pushed configuration, branch
// conditions, templates). Plain JavaScript without dependencies.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PolicyFlow = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const FLOW_VERSION = 1;
  const LIMITS = { nodes: 60, edges: 200, conditions: 20, pairs: 30, code: 100000, template: 20000, name: 80, value: 2000 };
  const STEP_TYPES = ['script', 'if', 'invoke', 'validateRequest', 'validateBody', 'security'];
  const TYPES = ['input', 'output', ...STEP_TYPES];
  const PORTS = {
    input: ['next'], script: ['next'], invoke: ['next'], if: ['true', 'false'],
    validateRequest: ['next'], validateBody: ['next'], security: ['next'], output: [],
  };
  const TYPE_LABELS = {
    input: 'Input', output: 'Output', script: 'Gateway script', if: 'If', invoke: 'Invoke service',
    validateRequest: 'Validate request', validateBody: 'Validate body', security: 'Security',
  };
  const SECURITY_CHECKS = {
    sqlInjection: 'SQL injection',
    scriptInjection: 'Script injection (XSS)',
    pathTraversal: 'Path traversal',
    commandInjection: 'Command injection',
    nosqlInjection: 'NoSQL operators and prototype keys',
  };
  // 0 turns a size limit off.
  const SECURITY_LIMITS = {
    maxBodyKb: { min: 0, max: 102400, label: 'The body limit (KB)' },
    maxJsonDepth: { min: 0, max: 1000, label: 'The JSON depth' },
    maxJsonEntries: { min: 0, max: 10000000, label: 'The number of JSON entries' },
    bruteMax: { min: 1, max: 1000, label: 'The failed attempts' },
    bruteWindow: { min: 1, max: 86400, label: 'The counting window (seconds)' },
    bruteLockout: { min: 1, max: 604800, label: 'The lockout (seconds)' },
  };
  const BRUTE_KEYS = ['ip', 'client', 'header', 'body'];
  const PORT_LABELS = { next: 'Next', true: 'Yes', false: 'No' };
  const SCRIPT_TIMEOUT = { min: 10, max: 30000, default: 1000 };
  const INVOKE_TIMEOUT = { min: 100, max: 300000 };
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const CONDITION_SOURCES = {
    method: { label: 'Method', path: 'request.method' },
    path: { label: 'Path', path: 'request.path' },
    header: { label: 'Request header', path: 'request.headers', named: true },
    query: { label: 'Query parameter', path: 'request.query', named: true },
    body: { label: 'Request body', path: 'request', named: true, json: true },
    variable: { label: 'Variable', path: 'variables', named: true, required: true },
    status: { label: 'Response status', path: 'response.status' },
    responseHeader: { label: 'Response header', path: 'response.headers', named: true },
    responseBody: { label: 'Response body', path: 'response', named: true, json: true },
    clientId: { label: 'Client ID', path: 'consumer.clientId' },
    application: { label: 'Application', path: 'consumer.application' },
    product: { label: 'Product', path: 'consumer.product.name' },
  };
  const OPERATORS = {
    equals: 'equals',
    notEquals: 'does not equal',
    contains: 'contains',
    notContains: 'does not contain',
    startsWith: 'starts with',
    endsWith: 'ends with',
    in: 'is one of',
    greaterThan: 'is greater than',
    lessThan: 'is less than',
    exists: 'is present',
    notExists: 'is missing',
  };
  const UNARY = ['exists', 'notExists'];
  const ID = /^[A-Za-z0-9_-]{1,40}$/;
  const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
  const TEMPLATE = /\{\{\s*([A-Za-z0-9_.$-]+)\s*\}\}/g;

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).slice(0, max);
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

  class FlowError extends Error {}
  const fail = (message) => { throw new FlowError(message); };

  const defaultConfig = (type) => {
    switch (type) {
      case 'script':
        return { code: '', fileName: null, timeoutMs: SCRIPT_TIMEOUT.default };
      case 'if':
        return { match: 'all', conditions: [{ source: 'header', name: 'x-debug', operator: 'equals', value: 'true' }] };
      case 'invoke':
        return {
          target: 'backend', url: '', appendPath: false, method: 'request', connectionId: null, timeoutMs: null,
          followRedirects: 0, forwardHeaders: true, headers: [], removeHeaders: [], query: [],
          body: 'request', bodyTemplate: '', contentType: '', responseTo: 'response', variable: '', onError: 'fail',
        };
      case 'validateRequest':
        return { headers: true, query: true, rejectUnknownQuery: false };
      case 'validateBody':
        return { rejectUnknown: false };
      case 'security':
        return {
          mode: 'block',
          sqlInjection: true, scriptInjection: true, pathTraversal: true, commandInjection: true, nosqlInjection: true,
          scanPath: true, scanQuery: true, scanHeaders: true, scanBody: true,
          maxBodyKb: 0, maxJsonDepth: 32, maxJsonEntries: 10000,
          ipAllow: [], ipDeny: [],
          bruteForce: false, bruteKey: 'ip', bruteKeyName: '', bruteStatuses: [401, 403], bruteMax: 5, bruteWindow: 300, bruteLockout: 900,
        };
      default:
        return {};
    }
  };

  // The flow a new API starts with: the request goes straight to Output, which returns it.
  const defaultFlow = () => ({
    version: FLOW_VERSION,
    nodes: [
      { id: 'input', type: 'input', name: TYPE_LABELS.input, x: 40, y: 160, config: {} },
      { id: 'output', type: 'output', name: TYPE_LABELS.output, x: 560, y: 160, config: {} },
    ],
    edges: [{ id: 'input-next', from: 'input', port: 'next', to: 'output' }],
  });

  const pairs = (list, label, step) => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > LIMITS.pairs) fail(`${step}: ${label} must be a list of at most ${LIMITS.pairs} entries`);
    return list.filter((item) => isObject(item) && text(item.name, 100).trim()).map((item) => {
      const name = text(item.name, 100).trim();
      if (!HEADER_NAME.test(name)) fail(`${step}: "${name}" is not a valid ${label === 'query parameters' ? 'parameter' : 'header'} name`);
      const value = text(item.value, LIMITS.value);
      if (/[\r\n]/.test(value)) fail(`${step}: the value of "${name}" can't contain line breaks`);
      return { name: label === 'headers' ? name.toLowerCase() : name, value };
    });
  };

  const IPV4_RANGE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/;
  const IPV6_RANGE = /^[0-9A-Fa-f:]{2,39}(\/(\d{1,3}))?$/;
  const isRange = (value) => {
    const v4 = value.match(IPV4_RANGE);
    if (v4) return v4.slice(1, 5).every((part) => Number(part) <= 255) && (v4[6] === undefined || Number(v4[6]) <= 32);
    const v6 = value.match(IPV6_RANGE);
    return Boolean(v6) && value.includes(':') && (v6[2] === undefined || Number(v6[2]) <= 128);
  };
  // A list given as an array or as text separated by commas, spaces or lines.
  const list = (raw, max) => (Array.isArray(raw) ? raw : text(raw, 20000).split(/[,\s]+/))
    .map((item) => text(item, 100).trim()).filter(Boolean).slice(0, max + 1);
  const whole = (raw, fallback, { min, max, label }, step) => {
    const value = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) fail(`${step}: ${label.toLowerCase()} must be a whole number from ${min} to ${max}`);
    return value;
  };

  const normalizeConfig = (type, config, step) => {
    const raw = isObject(config) ? config : {};
    const defaults = defaultConfig(type);
    if (type === 'script') {
      if (raw.code !== undefined && typeof raw.code !== 'string') fail(`${step}: the code must be text`);
      if ((raw.code || '').length > LIMITS.code) fail(`${step}: the code is longer than ${LIMITS.code.toLocaleString('en-US')} characters`);
      const timeoutMs = raw.timeoutMs === undefined || raw.timeoutMs === null || raw.timeoutMs === '' ? defaults.timeoutMs : Number(raw.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < SCRIPT_TIMEOUT.min || timeoutMs > SCRIPT_TIMEOUT.max) {
        fail(`${step}: the time limit must be a whole number of milliseconds between ${SCRIPT_TIMEOUT.min} and ${SCRIPT_TIMEOUT.max}`);
      }
      return { code: raw.code || '', fileName: raw.fileName ? text(raw.fileName, 200) : null, timeoutMs };
    }
    if (type === 'if') {
      const conditions = raw.conditions === undefined ? [] : raw.conditions;
      if (!Array.isArray(conditions) || conditions.length > LIMITS.conditions) fail(`${step}: use at most ${LIMITS.conditions} conditions`);
      return {
        match: oneOf(raw.match, ['all', 'any'], 'all'),
        conditions: conditions.map((condition) => {
          if (!isObject(condition) || !CONDITION_SOURCES[condition.source]) fail(`${step}: choose what each condition checks`);
          if (!OPERATORS[condition.operator]) fail(`${step}: choose how each condition compares`);
          const source = CONDITION_SOURCES[condition.source];
          const name = source.named ? text(condition.name, 200).trim() : '';
          if (source.required && !name) fail(`${step}: name the ${source.label.toLowerCase()} a condition checks`);
          if (condition.source === 'header' || condition.source === 'responseHeader') {
            if (name && !HEADER_NAME.test(name)) fail(`${step}: "${name}" is not a valid header name`);
          }
          return {
            source: condition.source,
            name: condition.source.endsWith('eader') ? name.toLowerCase() : name,
            operator: condition.operator,
            value: UNARY.includes(condition.operator) ? '' : text(condition.value, LIMITS.value),
          };
        }),
      };
    }
    if (type === 'invoke') {
      const target = oneOf(raw.target, ['backend', 'url'], 'backend');
      const url = text(raw.url, LIMITS.template).trim();
      if (url &&!/^https?:\/\//i.test(url) && !/^\{\{/.test(url)) fail(`${step}: the URL must start with https:// or http://`);
      const method = raw.method === 'request' || raw.method === undefined ? 'request' : String(raw.method).toUpperCase();
      if (method !== 'request' && !METHODS.includes(method)) fail(`${step}: unknown HTTP method ${method}`);
      let timeoutMs = null;
      if (raw.timeoutMs !== undefined && raw.timeoutMs !== null && raw.timeoutMs !== '') {
        timeoutMs = Number(raw.timeoutMs);
        if (!Number.isInteger(timeoutMs) || timeoutMs < INVOKE_TIMEOUT.min || timeoutMs > INVOKE_TIMEOUT.max) {
          fail(`${step}: the timeout must be between ${INVOKE_TIMEOUT.min} and ${INVOKE_TIMEOUT.max} ms, or empty to use the connection's`);
        }
      }
      const followRedirects = raw.followRedirects === undefined || raw.followRedirects === null || raw.followRedirects === '' ? 0 : Number(raw.followRedirects);
      if (!Number.isInteger(followRedirects) || followRedirects < 0 || followRedirects > 5) fail(`${step}: follow at most 5 redirects`);
      const responseTo = oneOf(raw.responseTo, ['response', 'variable'], 'response');
      const variable = text(raw.variable, 64).trim();
      if (responseTo === 'variable' && !VARIABLE.test(variable)) {
        fail(`${step}: name the variable with letters, digits and _ (for example backendResult)`);
      }
      const removeHeaders = (Array.isArray(raw.removeHeaders) ? raw.removeHeaders : text(raw.removeHeaders, 2000).split(','))
        .map((name) => text(name, 100).trim().toLowerCase()).filter(Boolean);
      if (removeHeaders.length > LIMITS.pairs) fail(`${step}: remove at most ${LIMITS.pairs} headers`);
      removeHeaders.forEach((name) => { if (!HEADER_NAME.test(name)) fail(`${step}: "${name}" is not a valid header name`); });
      const contentType = text(raw.contentType, 200).trim();
      if (/[\r\n]/.test(contentType)) fail(`${step}: the content type can't contain line breaks`);
      return {
        target,
        url,
        // Off unless asked for: the step calls its URL exactly as written.
        appendPath: bool(raw.appendPath, false),
        method,
        connectionId: raw.connectionId ? text(raw.connectionId, 64) : null,
        timeoutMs,
        followRedirects,
        forwardHeaders: bool(raw.forwardHeaders, true),
        headers: pairs(raw.headers, 'headers', step),
        removeHeaders,
        query: pairs(raw.query, 'query parameters', step),
        body: oneOf(raw.body, ['request', 'none', 'custom'], 'request'),
        bodyTemplate: text(raw.bodyTemplate, LIMITS.template),
        contentType,
        responseTo,
        variable: responseTo === 'variable' ? variable : '',
        onError: oneOf(raw.onError, ['fail', 'continue'], 'fail'),
      };
    }
    if (type === 'validateRequest') {
      return { headers: bool(raw.headers, true), query: bool(raw.query, true), rejectUnknownQuery: bool(raw.rejectUnknownQuery, false) };
    }
    if (type === 'validateBody') {
      return { rejectUnknown: bool(raw.rejectUnknown, false) };
    }
    if (type === 'security') {
      const ranges = (key, label) => {
        const values = list(raw[key], 100);
        if (values.length > 100) fail(`${step}: list at most 100 addresses to ${label}`);
        values.forEach((value) => { if (!isRange(value)) fail(`${step}: "${value}" is not an IP address or range such as 203.0.113.0/24`); });
        return values;
      };
      const statuses = raw.bruteStatuses === undefined ? defaults.bruteStatuses : list(raw.bruteStatuses, 20).map(Number);
      if (statuses.length > 20 || statuses.some((status) => !Number.isInteger(status) || status < 400 || status > 599)) {
        fail(`${step}: failed attempts are answers with status codes from 400 to 599, such as 401, 403`);
      }
      const bruteKey = oneOf(raw.bruteKey, BRUTE_KEYS, 'ip');
      const bruteKeyName = text(raw.bruteKeyName, 100).trim();
      if (bruteKey === 'header' && bruteKeyName && !HEADER_NAME.test(bruteKeyName)) fail(`${step}: "${bruteKeyName}" is not a valid header name`);
      const result = {
        mode: oneOf(raw.mode, ['block', 'monitor'], 'block'),
        ...Object.fromEntries(Object.keys(SECURITY_CHECKS).map((key) => [key, bool(raw[key], true)])),
        scanPath: bool(raw.scanPath, true),
        scanQuery: bool(raw.scanQuery, true),
        scanHeaders: bool(raw.scanHeaders, true),
        scanBody: bool(raw.scanBody, true),
        ipAllow: ranges('ipAllow', 'allow'),
        ipDeny: ranges('ipDeny', 'deny'),
        bruteForce: bool(raw.bruteForce, false),
        bruteKey,
        bruteKeyName: bruteKey === 'header' ? bruteKeyName.toLowerCase() : bruteKey === 'body' ? bruteKeyName : '',
        bruteStatuses: [...new Set(statuses)],
      };
      for (const [key, range] of Object.entries(SECURITY_LIMITS)) result[key] = whole(raw[key], defaults[key], range, step);
      return result;
    }
    return {};
  };

  // Checks the shape of a flow and fills in defaults. Throws FlowError with a message for people.
  // A flow can be saved while incomplete; flowProblems() lists what blocks deploying it.
  const parseFlow = (raw) => {
    let value = raw;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        fail('The flow is not valid JSON');
      }
    }
    if (!isObject(value)) fail('The flow must be an object with nodes and edges');
    if (!Array.isArray(value.nodes) || !value.nodes.length) fail('The flow has no steps');
    if (value.nodes.length > LIMITS.nodes) fail(`A flow can have at most ${LIMITS.nodes} steps`);
    const edges = value.edges === undefined ? [] : value.edges;
    if (!Array.isArray(edges) || edges.length > LIMITS.edges) fail(`A flow can have at most ${LIMITS.edges} lines`);

    const ids = new Set();
    const nodes = value.nodes.map((node) => {
      if (!isObject(node)) fail('Each step must be an object');
      if (!TYPES.includes(node.type)) fail(`Unknown step type "${text(node.type, 40)}"`);
      const id = text(node.id, 41);
      if (!ID.test(id)) fail('Each step needs an id of letters, digits, - and _');
      if (ids.has(id)) fail(`Two steps share the id "${id}"`);
      ids.add(id);
      const name = text(node.name, LIMITS.name).trim() || TYPE_LABELS[node.type];
      const coordinate = (number) => (Number.isFinite(Number(number)) ? Math.round(Math.max(-10000, Math.min(10000, Number(number)))) : 0);
      return { id, type: node.type, name, x: coordinate(node.x), y: coordinate(node.y), config: normalizeConfig(node.type, node.config, `Step "${name}"`) };
    });
    ['input', 'output'].forEach((type) => {
      const count = nodes.filter((node) => node.type === type).length;
      if (count !== 1) fail(`A flow has exactly one ${TYPE_LABELS[type]} step`);
    });

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const used = new Set();
    const normalizedEdges = edges.map((edge) => {
      if (!isObject(edge)) fail('Each line must be an object');
      const from = byId.get(text(edge.from, 41));
      const to = byId.get(text(edge.to, 41));
      if (!from || !to) fail('A line connects a step that does not exist');
      if (from.type === 'output') fail('No line can start at Output: it answers the client');
      const port = edge.port === undefined ? PORTS[from.type][0] : text(edge.port, 10);
      if (!PORTS[from.type].includes(port)) fail(`"${from.name}" has no "${port}" connection point`);
      if (to.type === 'input') fail('No line can lead into Input');
      if (from.id === to.id) fail(`A line from "${from.name}" can't lead back to itself`);
      const key = `${from.id}:${port}`;
      if (used.has(key)) fail(`"${from.name}" has two lines from the same connection point`);
      used.add(key);
      return { id: `${from.id}-${port}`, from: from.id, port, to: to.id };
    });
    return { version: FLOW_VERSION, nodes, edges: normalizedEdges };
  };

  const normalizeFlow = (raw) => {
    try {
      return { flow: parseFlow(raw) };
    } catch (error) {
      if (error instanceof FlowError) return { error: error.message };
      throw error;
    }
  };

  const nextMap = (flow) => new Map(flow.edges.map((edge) => [`${edge.from}:${edge.port}`, edge.to]));

  // Steps reachable from Input, in the order they are first reached.
  const reachable = (flow) => {
    const next = nextMap(flow);
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));
    const input = flow.nodes.find((node) => node.type === 'input');
    const seen = new Set([input.id]);
    const queue = [input];
    while (queue.length) {
      const node = queue.shift();
      for (const port of PORTS[node.type]) {
        const target = byId.get(next.get(`${node.id}:${port}`));
        if (target && !seen.has(target.id)) {
          seen.add(target.id);
          queue.push(target);
        }
      }
    }
    return seen;
  };

  // What keeps a flow from being deployed ('error') or is probably a mistake ('warning').
  // Each problem: { level, nodeId, message }.
  const flowProblems = (flow, { connectionIds = null } = {}) => {
    const problems = [];
    const add = (level, node, message) => problems.push({ level, nodeId: node ? node.id : null, message });
    const next = nextMap(flow);
    const live = reachable(flow);
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));

    for (const node of flow.nodes) {
      if (!live.has(node.id)) {
        if (node.type === 'output') add('error', node, 'Output is not connected. Draw a line from the last step to Output.');
        else add('warning', node, `"${node.name}" is not connected to Input, so it never runs.`);
        continue;
      }
      for (const port of PORTS[node.type]) {
        if (next.has(`${node.id}:${port}`)) continue;
        if (node.type === 'input') add('error', node, 'Input is not connected. Draw a line from Input to the first step.');
        else if (node.type === 'if') add('error', node, `The "${PORT_LABELS[port]}" line of "${node.name}" is not connected.`);
        else add('error', node, `"${node.name}" has no next step. Draw a line from it to the next step or to Output.`);
      }
      if (node.type === 'script' && !node.config.code.trim()) add('error', node, `"${node.name}" has no code. Upload a .js file or write the script.`);
      if (node.type === 'if' && !node.config.conditions.length) add('error', node, `"${node.name}" has no condition.`);
      if (node.type === 'invoke' && node.config.target === 'url' && !node.config.url) add('error', node, `"${node.name}" has no URL.`);
      if (node.type === 'invoke' && node.config.connectionId && connectionIds && !connectionIds.has(node.config.connectionId)) {
        add('error', node, `"${node.name}" uses a connection that no longer exists. Choose another one.`);
      }
      if (node.type === 'validateRequest' && !node.config.headers && !node.config.query) {
        add('warning', node, `"${node.name}" checks neither headers nor the query string.`);
      }
      if (node.type === 'security') {
        const { config } = node;
        const scans = (config.scanPath || config.scanQuery || config.scanHeaders || config.scanBody) && Object.keys(SECURITY_CHECKS).some((key) => config[key]);
        if (!scans && !config.bruteForce && !config.ipAllow.length && !config.ipDeny.length && !config.maxBodyKb && !config.maxJsonDepth && !config.maxJsonEntries) {
          add('warning', node, `"${node.name}" has every check turned off.`);
        }
        if (config.bruteForce && (config.bruteKey === 'header' || config.bruteKey === 'body') && !config.bruteKeyName) {
          add('error', node, `"${node.name}" counts failed attempts per ${config.bruteKey === 'header' ? 'header' : 'body field'}. Name the ${config.bruteKey === 'header' ? 'header' : 'field'}.`);
        }
        if (config.bruteForce && !config.bruteStatuses.length) {
          add('error', node, `"${node.name}" needs the statuses that count as a failed attempt, such as 401.`);
        }
      }
    }

    // Steps run at most once per request: a line back to an earlier step is a loop.
    const state = new Map();
    const visit = (node) => {
      state.set(node.id, 'active');
      for (const port of PORTS[node.type]) {
        const target = byId.get(next.get(`${node.id}:${port}`));
        if (!target) continue;
        if (state.get(target.id) === 'active') {
          add('error', node, `The line from "${node.name}" leads back to "${target.name}", which makes a loop. Steps can't repeat.`);
        } else if (!state.has(target.id)) {
          visit(target);
        }
      }
      state.set(node.id, 'done');
    };
    visit(flow.nodes.find((node) => node.type === 'input'));
    return problems;
  };

  const flowErrors = (flow, options) => flowProblems(flow, options).filter((problem) => problem.level === 'error');

  const liveSteps = (flow, type) => {
    const live = reachable(flow);
    return flow.nodes.filter((node) => node.type === type && live.has(node.id));
  };
  // True when an Invoke step calls the API's backend without a URL of its own, so the gateway
  // needs the server URL from the API's OpenAPI document.
  const usesBackend = (flow) => liveSteps(flow, 'invoke').some((node) => node.config.target === 'backend' && !node.config.url);
  const connectionIdsOf = (flow) => [...new Set(flow.nodes.filter((node) => node.type === 'invoke' && node.config.connectionId).map((node) => node.config.connectionId))];
  const scriptSteps = (flow) => flow.nodes.filter((node) => node.type === 'script');
  // True when a live step checks requests against the API's OpenAPI definition, so the gateway
  // needs the operations' parameters and request bodies.
  const usesContract = (flow) => liveSteps(flow, 'validateRequest').length > 0 || liveSteps(flow, 'validateBody').length > 0;

  // Reads a dotted path (a.b.0.c) from plain data.
  const resolvePath = (data, path) => {
    let value = data;
    for (const part of String(path).split('.')) {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(value, part)) {
        // Getters (lazy JSON bodies) are defined on the object itself, so this covers them too.
        return undefined;
      }
      value = value[part];
    }
    return value;
  };

  const asText = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return String(value);
  };

  // Replaces {{ request.headers.x-id }} style placeholders with values from `data`.
  const renderTemplate = (template, data) => String(template || '').replace(TEMPLATE, (match, path) => asText(resolvePath(data, path)));

  const conditionValue = (condition, data) => {
    const source = CONDITION_SOURCES[condition.source];
    if (source.json) {
      if (!condition.name) return resolvePath(data, `${source.path}.body`);
      return resolvePath(data, `${source.path}.json.${condition.name}`);
    }
    if (source.named) return resolvePath(data, `${source.path}.${condition.name}`);
    return resolvePath(data, source.path);
  };

  const testCondition = (condition, data) => {
    const actual = conditionValue(condition, data);
    const present = actual !== undefined && actual !== null;
    let left = asText(actual);
    let right = condition.value;
    if (condition.source === 'method') {
      left = left.toUpperCase();
      right = right.toUpperCase();
    }
    switch (condition.operator) {
      case 'exists': return present;
      case 'notExists': return !present;
      case 'equals': return present && left === right;
      case 'notEquals': return left !== right;
      case 'contains': return present && left.includes(right);
      case 'notContains': return !left.includes(right);
      case 'startsWith': return present && left.startsWith(right);
      case 'endsWith': return present && left.endsWith(right);
      case 'in': return present && right.split(',').map((item) => item.trim()).includes(left);
      case 'greaterThan':
      case 'lessThan': {
        const a = Number(left);
        const b = Number(right);
        if (!present || left === '' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
        return condition.operator === 'greaterThan' ? a > b : a < b;
      }
      default: return false;
    }
  };

  const evaluateConditions = (config, data) => {
    if (!config.conditions.length) return false;
    return config.match === 'any'
      ? config.conditions.some((condition) => testCondition(condition, data))
      : config.conditions.every((condition) => testCondition(condition, data));
  };

  return {
    FLOW_VERSION,
    LIMITS,
    TYPES,
    STEP_TYPES,
    SECURITY_CHECKS,
    SECURITY_LIMITS,
    BRUTE_KEYS,
    PORTS,
    TYPE_LABELS,
    PORT_LABELS,
    SCRIPT_TIMEOUT,
    INVOKE_TIMEOUT,
    METHODS,
    CONDITION_SOURCES,
    OPERATORS,
    UNARY,
    FlowError,
    defaultConfig,
    defaultFlow,
    normalizeFlow,
    parseFlow,
    flowProblems,
    flowErrors,
    reachable,
    usesBackend,
    usesContract,
    connectionIdsOf,
    scriptSteps,
    resolvePath,
    renderTemplate,
    evaluateConditions,
    testCondition,
  };
}));
