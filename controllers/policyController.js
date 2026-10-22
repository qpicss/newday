const { Api, Gateway, GatewayHandler, Policy, Connection } = require('../models');
const { gatewayIncludes } = require('../services/gatewayQueries');
const { testFlowOnGateway } = require('../services/gatewayPush');
const { connectionConfig } = require('../services/gatewayConfig');
const { sendServerError } = require('../utils/http');
const { optionalText } = require('../utils/validation');
const { listOperations } = require('../utils/openapi');
const { operationContract } = require('../utils/openapiContract');
const { defaultFlow, normalizeFlow, flowProblems, scriptSteps, connectionIdsOf, usesContract } = require('../gateway/src/flow');
// Same syntax check the gateway runs, so errors show up before a push.
const { checkScriptSyntax } = require('../gateway/src/policy');

// What a new Gateway script step starts with in the editor (public/js/policy-detail.js has a copy).
const DEFAULT_SCRIPT = `// Runs on the gateway. Read and change callcontext; the next step sees your changes.
module.exports = async function (callcontext) {
  callcontext.headers['x-request-source'] = 'gateway';
};
`;

const serializePolicy = (policy, { problems } = {}) => ({
  id: policy.id,
  name: policy.name,
  description: policy.description,
  flow: policy.flow,
  ownerApiId: policy.ownerApiId,
  ...(policy.apis && { apis: policy.apis.map((api) => ({ id: api.id, name: api.name, basePath: api.basePath })) }),
  ...(problems && { problems }),
  createdAt: policy.createdAt,
  updatedAt: policy.updatedAt,
});

// Validates the flow's shape and the syntax of its scripts. Returns { flow } or { error }.
const validateFlow = (raw) => {
  const { flow, error } = normalizeFlow(raw);
  if (error) return { error };
  for (const node of scriptSteps(flow)) {
    if (!node.config.code.trim()) continue;
    try {
      checkScriptSyntax({ name: node.name, code: node.config.code });
    } catch (problem) {
      return { error: problem.message };
    }
  }
  return { flow };
};

const validatePolicyInput = (body = {}, { partial = false } = {}) => {
  const fields = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) return { error: 'Policy name is required (max 255 characters)' };
    fields.name = name;
  }
  if (body.description !== undefined) {
    const { value, error } = optionalText(body.description, 'Description', 2000);
    if (error) return { error };
    fields.description = value;
  }
  if (!partial || body.flow !== undefined) {
    const { flow, error } = validateFlow(body.flow === undefined ? defaultFlow() : body.flow);
    if (error) return { error };
    fields.flow = flow;
  }
  return { fields };
};

const orgConnectionIds = async (req) => new Set((await Connection.findAll({
  where: { organizationId: req.user.organizationId },
  attributes: ['id'],
})).map((connection) => connection.id));

// Problems the editor shows next to the flow (errors block a push).
const problemsOf = async (req, flow) => flowProblems(flow, { connectionIds: await orgConnectionIds(req) });

const findOrgPolicy = (req, options = {}) => Policy.findOne({
  where: { id: req.params.id, organizationId: req.user.organizationId },
  ...options,
});

const apisInclude = { association: 'apis', attributes: ['id', 'name', 'basePath'] };

const listPolicies = async (req, res) => {
  try {
    const policies = await Policy.findAll({
      where: { organizationId: req.user.organizationId },
      include: [apisInclude],
      order: [['name', 'ASC']],
    });
    res.json({ policies: policies.map((policy) => serializePolicy(policy)) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load policies');
  }
};

const createPolicy = async (req, res) => {
  try {
    const { fields, error } = validatePolicyInput(req.body);
    if (error) return res.status(400).json({ error });
    const policy = await Policy.create({ ...fields, organizationId: req.user.organizationId });
    policy.apis = [];
    res.status(201).json({ policy: serializePolicy(policy, { problems: await problemsOf(req, policy.flow) }) });
  } catch (error) {
    sendServerError(res, error, 'Failed to create policy');
  }
};

const getPolicy = async (req, res) => {
  try {
    const policy = await findOrgPolicy(req, { include: [apisInclude] });
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    res.json({ policy: serializePolicy(policy, { problems: await problemsOf(req, policy.flow) }) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load policy');
  }
};

// Incomplete flows can be saved; their problems come back with the policy and block a push.
const updatePolicy = async (req, res) => {
  try {
    const policy = await findOrgPolicy(req, { include: [apisInclude] });
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    const { fields, error } = validatePolicyInput({ name: policy.name, ...req.body }, { partial: true });
    if (error) return res.status(400).json({ error });
    await policy.update(fields);
    res.json({ policy: serializePolicy(policy, { problems: await problemsOf(req, policy.flow) }) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update policy');
  }
};

// APIs that used the policy fall back to the default flow (they return the request); ports run
// without a port policy.
const deletePolicy = async (req, res) => {
  try {
    const policy = await findOrgPolicy(req);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    await Api.update({ policyId: null }, { where: { policyId: policy.id, organizationId: req.user.organizationId } });
    const gatewayIds = (await Gateway.findAll({ where: { organizationId: req.user.organizationId }, attributes: ['id'] })).map((gateway) => gateway.id);
    if (gatewayIds.length) await GatewayHandler.update({ policyId: null }, { where: { policyId: policy.id, gatewayId: gatewayIds } });
    await policy.destroy();
    res.json({ message: 'Policy deleted' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete policy');
  }
};

const sampleObject = (value) => {
  if (value === undefined || value === null || value === '') return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(parsed).map(([name, item]) => [String(name), Array.isArray(item) ? item.map(String) : String(item)]));
};

// Runs the editor's (possibly unsaved) flow on one of the organization's gateway nodes, never on
// the console. `apiId` lets "the API's backend" steps call that API's backend, and Validate steps
// check the sample against its OpenAPI operations.
const testPolicy = async (req, res) => {
  try {
    const { name, flow: rawFlow, apiId, sample = {} } = req.body ?? {};
    const { flow, error } = validateFlow(rawFlow);
    if (error) return res.status(400).json({ error });

    let headers;
    let query;
    try {
      headers = Object.fromEntries(Object.entries(sampleObject(sample.headers)).map(([key, value]) => [key.toLowerCase(), value]));
      query = sampleObject(sample.query);
    } catch {
      return res.status(400).json({ error: 'Sample headers and query must be JSON objects, for example {"x-tenant": "acme"}' });
    }

    let api = null;
    const connectionIds = new Set(connectionIdsOf(flow));
    if (apiId) {
      const found = await Api.findOne({ where: { id: apiId, organizationId: req.user.organizationId } });
      if (!found) return res.status(400).json({ error: "Choose one of your organization's APIs" });
      api = { id: found.id, name: found.name, version: found.version, basePath: found.basePath || '/', upstreamUrl: null, connectionId: found.connectionId };
      // Validate steps check the sample against the operation its method and path match.
      if (usesContract(flow)) {
        api.operations = listOperations(found.spec).map(({ method, path }) => ({ method, path, contract: operationContract(found.spec, path, method) || { parameters: [], body: null } }));
      }
      try {
        if (['http:', 'https:'].includes(new URL(found.baseUrl).protocol)) api.upstreamUrl = found.baseUrl;
      } catch {
        // no usable backend URL; steps that call it report that
      }
      if (found.connectionId) connectionIds.add(found.connectionId);
    }
    const connections = connectionIds.size
      ? await Connection.findAll({ where: { id: [...connectionIds], organizationId: req.user.organizationId } })
      : [];

    const payload = {
      policy: { id: req.body?.id || 'test', name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 255) : 'Test', flow },
      api,
      connections: connections.map(connectionConfig),
      sample: {
        method: String(sample.method || 'GET').toUpperCase().slice(0, 10),
        path: typeof sample.path === 'string' && sample.path.startsWith('/') ? sample.path.slice(0, 2000) : '/',
        headers,
        query,
        body: typeof sample.body === 'string' ? sample.body : '',
      },
    };
    const gateways = await Gateway.findAll({ where: { organizationId: req.user.organizationId }, include: gatewayIncludes, order: [['name', 'ASC']] });
    const result = await testFlowOnGateway(gateways, payload);
    res.status(result.unavailable ? 409 : 200).json(result);
  } catch (error) {
    sendServerError(res, error, 'Failed to test the policy');
  }
};

module.exports = {
  testPolicy,
  DEFAULT_SCRIPT,
  serializePolicy,
  validateFlow,
  problemsOf,
  listPolicies,
  createPolicy,
  getPolicy,
  updatePolicy,
  deletePolicy,
};
