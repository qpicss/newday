// Runs policy flows (see flow.js) for one request: from Input along the lines to Output.
//
// The request state passes from step to step: the request as it would be sent on (method, path,
// query, headers, body), the response once a step set one, and variables. Scripts get it as
// callcontext; If steps read it; Invoke steps send the request and store what comes back.
// At Output the client gets the response, or the request body itself when no step set one.
const { evaluateConditions } = require('./flow');
const { PolicyError } = require('./policy');
const { bodyForScript } = require('./invoke');
const { CHECK_TYPES, runCheck } = require('./checks');

const MAX_STEPS = 200;
const EMPTY = Buffer.alloc(0);

const scriptKey = (flowKey, nodeId) => `${flowKey}#${nodeId}`;

// `flow` is normalized (flow.js) and free of errors (flowErrors).
const compileFlow = (key, { id, name, flow }) => ({
  key,
  id,
  name,
  nodes: new Map(flow.nodes.map((node) => [node.id, node])),
  next: new Map(flow.edges.map((edge) => [`${edge.from}:${edge.port}`, edge.to])),
  inputId: flow.nodes.find((node) => node.type === 'input').id,
  scripts: flow.nodes.filter((node) => node.type === 'script').map((node) => ({
    key: scriptKey(key, node.id),
    name: `${name} / ${node.name}`,
    code: node.config.code,
    timeoutMs: node.config.timeoutMs,
  })),
});

const createState = ({ method, path, query, headers, body }) => ({
  method,
  path,
  query,
  headers,
  body: body || EMPTY,
  response: null, // { status, headers, body: Buffer | null while streaming }
  variables: {},
  request: null, // what the last Invoke step sent
  replied: false,
  repliedBy: null,
  stream: null, // upstream response piped to the client as it is
  watches: [], // Security steps counting this request's answer towards a brute-force lockout
});

const contentTypeOf = (headers) => (headers && headers['content-type']) || '';

// Plain data with `body` and `json` read only when a condition or template asks for them.
const withBody = (fields, buffer) => {
  const view = { ...fields };
  let text;
  let json;
  let parsed = false;
  Object.defineProperty(view, 'body', {
    enumerable: true,
    get: () => {
      if (text === undefined) text = buffer ? buffer.toString('utf8') : '';
      return text;
    },
  });
  Object.defineProperty(view, 'json', {
    enumerable: true,
    get: () => {
      if (!parsed) {
        parsed = true;
        try {
          json = JSON.parse(view.body);
        } catch {
          json = undefined;
        }
      }
      return json;
    },
  });
  return view;
};

// What If conditions and {{ }} templates can read.
const flowData = (state, shared) => ({
  request: withBody({ method: state.method, path: state.path, query: state.query, headers: state.headers }, state.body),
  response: state.response ? withBody({ status: state.response.status, headers: state.response.headers }, state.response.body) : null,
  variables: state.variables,
  original: shared.original,
  consumer: shared.consumer,
  api: shared.api,
  requestId: shared.requestId,
  traceId: shared.traceId,
});

const scriptInput = (state, shared) => {
  const body = bodyForScript(state.body, contentTypeOf(state.headers));
  return {
    ...shared,
    method: state.method,
    path: state.path,
    query: state.query,
    headers: state.headers,
    body: body.body,
    ...(body.bodyEncoding && { bodyEncoding: body.bodyEncoding }),
    response: state.response
      ? { status: state.response.status, headers: state.response.headers, ...bodyForScript(state.response.body, contentTypeOf(state.response.headers)) }
      : null,
    variables: state.variables,
    request: state.request,
  };
};

const decode = (text, encoding, wasObject) => Buffer.from(text, encoding === 'base64' && !wasObject ? 'base64' : 'utf8');

// Copies a script's changes into the state. Bodies it did not touch keep their exact bytes.
const applyScriptResult = (state, result, sent) => {
  state.method = result.method;
  state.path = result.path;
  state.query = result.query;
  state.headers = result.headers;
  if (result.body !== sent.body) {
    state.body = decode(result.body, sent.bodyEncoding, result.bodyWasObject);
    if (result.bodyWasObject && !state.headers['content-type']) state.headers['content-type'] = 'application/json';
  }
  if (result.response) {
    const unchanged = sent.response && state.response && state.response.body && result.response.body === sent.response.body;
    const headers = result.response.headers;
    if (result.response.bodyWasObject && !headers['content-type']) headers['content-type'] = 'application/json';
    state.response = {
      status: result.response.status,
      headers,
      body: unchanged ? state.response.body : decode(result.response.body, result.response.bodyEncoding, result.response.bodyWasObject),
    };
  } else {
    state.response = null;
  }
  state.variables = result.variables;
};

// deps: shared (original, api, consumer, requestId, traceId), runScript(flow, node, input),
// invoke(flow, node, state, { streamable }), canStream, trace (an array to record steps in, or null),
// checks (for the checking steps: contract, remoteAddress, clientId, tracker, onFindings).
// `final` is true for the flow whose Output answers the client.
const runFlow = async (flow, state, deps, { final = true } = {}) => {
  const trace = deps.trace || null;
  trace?.push({ nodeId: flow.inputId, type: 'input', name: flow.nodes.get(flow.inputId).name, flow: flow.name, outcome: 'Received the request' });
  let nodeId = flow.next.get(`${flow.inputId}:next`);
  for (let count = 0; ; count += 1) {
    const node = nodeId ? flow.nodes.get(nodeId) : null;
    if (!node || node.type === 'output') {
      trace?.push({
        nodeId: node ? node.id : null,
        type: 'output',
        name: node ? node.name : 'Output',
        flow: flow.name,
        outcome: !final ? 'Continues with the API policy' : state.response ? `Returns the response (status ${state.response.status})` : 'Returns the request as it was received',
      });
      return;
    }
    if (count >= MAX_STEPS) throw new PolicyError(`The flow "${flow.name}" ran more than ${MAX_STEPS} steps`);

    const step = { nodeId: node.id, type: node.type, name: node.name, flow: flow.name };
    const started = performance.now();
    let port = 'next';
    try {
      if (node.type === 'script') {
        const input = scriptInput(state, deps.shared);
        const result = await deps.runScript(flow, node, input);
        step.logs = result.logs;
        applyScriptResult(state, result, input);
        if (result.reply) {
          state.response = { status: result.reply.status, headers: result.reply.headers, body: Buffer.from(result.reply.body) };
          state.replied = true;
          state.repliedBy = node.name;
          step.outcome = `Answered the client with status ${result.reply.status}`;
        }
      } else if (node.type === 'if') {
        const passed = evaluateConditions(node.config, flowData(state, deps.shared));
        port = passed ? 'true' : 'false';
        step.branch = port;
        step.outcome = passed ? 'Yes: the conditions are met' : 'No: the conditions are not met';
      } else if (node.type === 'invoke') {
        const after = flow.nodes.get(flow.next.get(`${node.id}:next`));
        const streamable = Boolean(final && deps.canStream && node.config.responseTo === 'response' && after && after.type === 'output');
        const call = await deps.invoke(flow, node, state, { streamable });
        step.call = call;
        step.outcome = call.error
          ? `${call.method} ${call.url} failed (${call.error}); continued`
          : `${call.method} ${call.url} answered ${call.status}${node.config.responseTo === 'variable' ? ` (stored in variables.${node.config.variable})` : ''}`;
      } else if (CHECK_TYPES.has(node.type)) {
        const result = runCheck(node, state, { ...deps.checks, scope: scriptKey(flow.key, node.id), requestId: deps.shared.requestId, step: node.name });
        step.outcome = result.outcome;
        if (result.problems) step.problems = result.problems;
        if (result.reply) {
          state.response = { status: result.reply.status, headers: result.reply.headers, body: Buffer.from(JSON.stringify(result.reply.body)) };
          state.replied = true;
          state.repliedBy = node.name;
        }
      }
    } catch (error) {
      step.durationMs = Math.round((performance.now() - started) * 10) / 10;
      step.error = error.message;
      if (error.logs?.length) step.logs = error.logs;
      trace?.push(step);
      throw error;
    }
    step.durationMs = Math.round((performance.now() - started) * 10) / 10;
    trace?.push(step);
    if (state.replied || state.stream) return;
    nodeId = flow.next.get(`${node.id}:${port}`);
  }
};

// The answer for the client once the flows are done: the response a step set, or the request.
const finalResponse = (state) => {
  if (state.response) {
    return { status: state.response.status, headers: { ...state.response.headers }, body: state.response.body || EMPTY, echoed: false };
  }
  const headers = {};
  const contentType = contentTypeOf(state.headers);
  if (contentType) headers['content-type'] = contentType;
  return { status: 200, headers, body: state.body || EMPTY, echoed: true };
};

module.exports = {
  compileFlow,
  createState,
  runFlow,
  finalResponse,
  flowData,
  scriptInput,
  applyScriptResult,
  scriptKey,
};
