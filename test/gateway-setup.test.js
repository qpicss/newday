// The setup checklist on a gateway's page: port, credentials, running node, catalog.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { models, resetDatabase, createUser, api, browser } = require('./helpers');

const { GatewayNode } = models;

describe('gateway setup', () => {
  let admin;
  let gatewayUrl;
  let catalogId;

  const setupOf = async () => (await api('get', gatewayUrl, admin)).body.gateway.setup;

  before(async () => {
    await resetDatabase();
    admin = await createUser({ name: 'Admin' });
    catalogId = (await api('post', '/api/org/catalogs', admin).send({ name: 'Public' })).body.catalog.id;
    const created = await api('post', '/api/org/gateways', admin).send({ name: 'Edge', publicUrl: 'https://localhost:8443' });
    gatewayUrl = `/api/org/gateways/${created.body.gateway.id}`;
  });

  it('walks a new gateway through its four steps', async () => {
    let setup = await setupOf();
    assert.deepEqual(setup.steps.map((step) => step.key), ['port', 'credentials', 'node', 'catalog']);
    assert.equal(setup.next.key, 'port');
    assert.equal(setup.running, false);

    await api('post', `${gatewayUrl}/handlers`, admin).send({ name: 'Public HTTPS', port: 8443, protocol: 'https', tlsMode: 'generated' });
    assert.equal((await setupOf()).next.key, 'credentials');

    await api('get', `${gatewayUrl}/credentials`, admin);
    assert.equal((await setupOf()).next.key, 'node');

    // Starting a node offers the console connecting to it first, with commands that publish the
    // management port and don't name the console, and warns that a localhost link only works locally.
    const page = await browser('get', `/developer/gateways/${gatewayUrl.split('/').pop()}`, admin);
    assert.match(page.text, /name="setupMode" value="push" checked/);
    assert.ok(page.text.includes('id="setupPushForm"'));
    const pushPanel = page.text.slice(page.text.indexOf('data-setup-panel="push"'), page.text.indexOf('data-setup-panel="pull"'));
    assert.match(pushPanel, /-p 9443:9443/);
    assert.doesNotMatch(pushPanel, /GATEWAY_MANAGEMENT_URL/);
    assert.match(pushPanel, /Copy these to the server first/);
    assert.match(page.text, /Only nodes on this computer can reach/);

    // A pull node that just sent a heartbeat counts as running.
    await GatewayNode.create({ gatewayId: gatewayUrl.split('/').pop(), name: 'node-1', mode: 'pull', lastSeenAt: new Date() });
    setup = await setupOf();
    assert.equal(setup.running, true);
    assert.equal(setup.next.key, 'catalog');
    assert.equal(setup.doneCount, 3);
  });

  it('shows the checklist on the page until the gateway is attached', async () => {
    const id = gatewayUrl.split('/').pop();
    let page = await browser('get', `/developer/gateways/${id}`, admin);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('id="setup"'));
    assert.ok(page.text.includes('id="quickAttachForm"'));
    assert.ok(page.text.includes('docker run'));

    // Running gateways are offered on the catalog page.
    const catalogPage = await browser('get', `/developer/catalogs/${catalogId}`, admin);
    assert.ok(catalogPage.text.includes('id="attachForm"'));

    const attached = await api('put', gatewayUrl, admin).send({ catalogId });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    assert.equal((await setupOf()).next, null);

    page = await browser('get', `/developer/gateways/${id}`, admin);
    assert.ok(!page.text.includes('id="setup"'));
    assert.ok(page.text.includes('id="run"'));
  });
});
