// Policies are flows: every API gets one of its own, flows are validated when saved, their
// problems block a push, and they go away with their API when nothing else uses them.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, resetDatabase, createUser, createCatalog, api, browser, request, app } = require('./helpers');
const { buildGatewayConfig } = require('../services/gatewayConfig');
const { loadGateway } = require('../services/gatewayQueries');

const { Api, Gateway, GatewayHandler, Policy } = models;

const chain = (steps) => {
  const nodes = [
    { id: 'input', type: 'input' },
    ...steps.map((step, index) => ({ id: `step${index + 1}`, ...step })),
    { id: 'output', type: 'output' },
  ];
  return { nodes, edges: nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id })) };
};
const backend = { type: 'invoke', name: 'Call the backend', config: { target: 'backend' } };

describe('policies', () => {
  let admin;
  let catalog;
  let apiId;
  let policyId;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ name: 'Admin' });
    catalog = await createCatalog(admin);
    const created = await api('post', '/api/org/apis', admin).send({ name: 'Orders', version: '1', catalogId: catalog.id });
    apiId = created.body.api.id;
    policyId = created.body.api.policyId;
  });

  it('gives every new API a policy of its own that returns the request', async () => {
    assert.ok(policyId);
    const res = await api('get', `/api/org/policies/${policyId}`, admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.policy.name, 'Orders policy');
    assert.equal(res.body.policy.ownerApiId, apiId);
    assert.deepEqual(res.body.policy.flow.nodes.map((node) => node.type), ['input', 'output']);
    assert.deepEqual(res.body.policy.flow.edges.map((edge) => [edge.from, edge.to]), [['input', 'output']]);
    assert.deepEqual(res.body.policy.problems, []);

    const imported = await api('post', '/api/org/apis/import', admin).send({
      catalogId: catalog.id,
      content: JSON.stringify({ openapi: '3.0.3', info: { title: 'Users', version: '1' }, paths: { '/users': { get: {} } } }),
    });
    const own = await Policy.findByPk(imported.body.api.policyId);
    assert.equal(own.name, 'Users policy');
  });

  it('saves incomplete flows with their problems and refuses broken ones', async () => {
    const url = `/api/org/policies/${policyId}`;
    const incomplete = chain([backend]);
    incomplete.edges.pop();
    const saved = await api('put', url, admin).send({ flow: incomplete });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.policy.problems.map((problem) => problem.message), [
      '"Call the backend" has no next step. Draw a line from it to the next step or to Output.',
      'Output is not connected. Draw a line from the last step to Output.',
    ]);

    const syntax = await api('put', url, admin).send({ flow: chain([{ type: 'script', name: 'Sign', config: { code: 'module.exports = (' } }]) });
    assert.equal(syntax.status, 400);
    assert.match(syntax.body.error, /Script "Sign" has a syntax error/);

    const shape = await api('put', url, admin).send({ flow: { nodes: [{ id: 'input', type: 'input' }], edges: [] } });
    assert.equal(shape.status, 400);
    assert.match(shape.body.error, /exactly one Output/);

    const badUrl = await api('put', url, admin).send({ flow: chain([{ type: 'invoke', config: { target: 'url', url: 'file:///etc/passwd' } }]) });
    assert.equal(badUrl.status, 400);

    const outsider = await createUser();
    assert.equal((await api('get', url, outsider)).status, 404);
    assert.equal((await api('put', url, outsider).send({ flow: chain([]) })).status, 404);
    const member = await createUser({ organization: { id: admin.organizationId } });
    assert.equal((await api('get', url, member)).status, 403);
  });

  it('accepts flow documents larger than the usual request limit', async () => {
    // Two scripts of 60 000 characters: well over the 100 KB limit of other JSON requests.
    const code = `module.exports = () => {};
// ${'x'.repeat(60000)}`;
    const big = chain([{ type: 'script', name: 'One', config: { code } }, { type: 'script', name: 'Two', config: { code } }]);
    const res = await api('put', `/api/org/policies/${policyId}`, admin).send({ flow: big });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  });

  it("blocks a push on flow problems, and asks for a backend URL only when the flow calls it", async () => {
    const created = await api('post', '/api/org/gateways', admin).send({ name: 'Edge', publicUrl: 'https://localhost:8443' });
    const gatewayId = created.body.gateway.id;
    await GatewayHandler.create({ gatewayId, name: 'HTTP', port: 8080, protocol: 'http' });
    await Gateway.update({ catalogId: catalog.id }, { where: { id: gatewayId } });
    const product = await api('post', '/api/org/products', admin).send({ name: 'Orders', catalogId: catalog.id });
    await api('post', `/api/org/products/${product.body.product.id}/apis`, admin).send({ apiId });
    await api('put', `/api/org/products/${product.body.product.id}`, admin).send({ status: 'published' });
    const problems = async () => (await buildGatewayConfig(await loadGateway({ id: gatewayId }))).problems;

    // The default flow returns the request: no backend URL needed.
    assert.ok(!(await problems()).some((problem) => /backend URL/.test(problem)), JSON.stringify(await problems()));

    await api('put', `/api/org/policies/${policyId}`, admin).send({ flow: chain([backend]) });
    assert.ok((await problems()).some((problem) => /has no backend URL/.test(problem)));

    // The Backend URL set in the step is enough.
    await api('put', `/api/org/policies/${policyId}`, admin).send({ flow: chain([{ ...backend, config: { target: 'backend', url: 'https://orders.internal.example.com/v1' } }]) });
    assert.ok(!(await problems()).some((problem) => /backend URL/.test(problem)), JSON.stringify(await problems()));
    const built = (await buildGatewayConfig(await loadGateway({ id: gatewayId }))).config;
    assert.equal(built.apis[0].flow.flow.nodes[1].config.url, 'https://orders.internal.example.com/v1');

    const incomplete = chain([backend]);
    incomplete.edges.pop();
    await api('put', `/api/org/policies/${policyId}`, admin).send({ flow: incomplete });
    assert.ok((await problems()).some((problem) => problem.startsWith('Policy "Orders policy" (used by Orders): Output is not connected')));

    const { config } = await buildGatewayConfig(await loadGateway({ id: gatewayId }));
    assert.equal(config.schema, 2);
    assert.equal(config.apis[0].flow.id, policyId);
  });

  it('removes an API\'s own policy with the API unless something else uses it', async () => {
    await api('delete', `/api/org/apis/${apiId}`, admin);
    assert.equal(await Policy.findByPk(policyId), null);

    const first = await api('post', '/api/org/apis', admin).send({ name: 'Shared', version: '1', catalogId: catalog.id });
    const second = await api('post', '/api/org/apis', admin).send({ name: 'Other', version: '1', catalogId: catalog.id });
    await api('put', `/api/org/apis/${second.body.api.id}`, admin).send({ policyId: first.body.api.policyId });
    await api('delete', `/api/org/apis/${first.body.api.id}`, admin);
    const kept = await Policy.findByPk(first.body.api.policyId);
    assert.ok(kept);
    assert.equal(kept.ownerApiId, null);
  });

  it('deleting a policy leaves its APIs with the default flow and its ports without one', async () => {
    const created = await api('post', '/api/org/gateways', admin).send({ name: 'Edge', publicUrl: 'https://localhost:8443' });
    const handler = await GatewayHandler.create({ gatewayId: created.body.gateway.id, name: 'HTTP', port: 8080, protocol: 'http', policyId });
    const res = await api('delete', `/api/org/policies/${policyId}`, admin);
    assert.equal(res.status, 200);
    assert.equal((await Api.findByPk(apiId)).policyId, null);
    assert.equal((await GatewayHandler.findByPk(handler.id)).policyId, null);
  });

  it('renders the policy list and the flow editor', async () => {
    const list = await browser('get', '/developer/policies', admin);
    assert.equal(list.status, 200);
    assert.match(list.text, /Orders policy/);
    assert.match(list.text, /returns the request/);

    const editor = await browser('get', `/developer/policies/${policyId}`, admin);
    assert.equal(editor.status, 200);
    assert.match(editor.text, /id="flowCanvas"/);
    assert.match(editor.text, /data-add-step="script"/);
    assert.match(editor.text, /data-add-step="if"/);
    assert.match(editor.text, /data-add-step="invoke"/);
    assert.match(editor.text, /data-flow="\{&#34;version&#34;:1/);
    assert.match(editor.text, /<script src="\/js\/flow.js"><\/script>/);

    const apiPage = await browser('get', `/developer/apis/${apiId}`, admin);
    assert.match(apiPage.text, new RegExp(`href="/developer/policies/${policyId}">Edit the flow`));
    assert.doesNotMatch(apiPage.text, /id="base-url-warning"/);
    // The backend URL is set in the Invoke step, not on the API's page.
    assert.doesNotMatch(apiPage.text, /id="baseUrl"/);
    await api('put', `/api/org/policies/${policyId}`, admin).send({ flow: chain([backend]) });
    const warned = await browser('get', `/developer/apis/${apiId}`, admin);
    assert.match(warned.text, /id="base-url-warning"/);
    assert.match(warned.text, /Set the Backend URL in the step/);

    // New Invoke steps start with the API's backend URL.
    await Api.update({ baseUrl: 'https://orders.internal.example.com/v1' }, { where: { id: apiId } });
    const prefilled = await browser('get', `/developer/policies/${policyId}`, admin);
    assert.match(prefilled.text, /data-backend-url="https:\/\/orders.internal.example.com\/v1"/);
    assert.match(prefilled.text, /<label for="invokeUrl"><span data-show-target="backend">Backend URL<\/span>/);

    const script = await request(app).get('/js/flow.js');
    assert.equal(script.status, 200);
    assert.match(script.headers['content-type'], /javascript/);
    assert.match(script.text, /root\.PolicyFlow = factory\(\)/);
  });
});
