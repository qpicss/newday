// Nodes of a gateway: added ahead of time with their own start command, placed on a shared Docker
// host (port offsets) or on their own server, handlers for the cluster or one node, and the
// addresses of every node.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, resetDatabase, createUser, api, browser } = require('./helpers');
const { buildGatewayConfig } = require('../services/gatewayConfig');
const { loadGateway } = require('../services/gatewayQueries');

const { GatewayNode, GatewayHandler } = models;

describe('gateway nodes', () => {
  let admin;
  let gatewayId;
  let gatewayUrl;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ name: 'Admin' });
    const created = await api('post', '/api/org/gateways', admin).send({ name: 'Edge', publicUrl: 'https://localhost:8443' });
    gatewayId = created.body.gateway.id;
    gatewayUrl = `/api/org/gateways/${gatewayId}`;
    await api('post', `${gatewayUrl}/handlers`, admin).send({ name: 'Public HTTPS', port: 8443, protocol: 'https', tlsMode: 'generated' });
    // The first node is running on this Docker host with the usual ports.
    await GatewayNode.create({ gatewayId, name: 'edge-node-1', mode: 'pull', lastSeenAt: new Date() });
  });

  it('adds a second node on the same Docker host with free host ports and its own command', async () => {
    const res = await api('post', `${gatewayUrl}/nodes`, admin).send({ name: 'edge-node-2' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.node.mode, 'pull');
    assert.equal(res.body.node.portOffset, 1);
    assert.deepEqual(res.body.addresses.traffic.map((entry) => entry.url), ['https://localhost:8444']);
    assert.equal(res.body.addresses.admin, 'https://localhost:9446');

    const page = await browser('get', `/developer/gateways/${gatewayId}`, admin);
    assert.equal(page.status, 200);
    // The new node's command: its own name, container, volume and shifted host ports.
    assert.match(page.text, /docker run -d --name edge-node-2 --restart unless-stopped/);
    assert.match(page.text, /-p 9446:9445 -p 8444:8443/);
    assert.match(page.text, /-e GATEWAY_NODE_NAME=edge-node-2/);
    assert.match(page.text, /-v edge-node-2-data:\/data/);
    assert.match(page.text, /-p 9445:9445 -p 8443:8443/);
    assert.match(page.text, /Not started yet/);
    // Every address of the cluster and of each node.
    assert.match(page.text, /id="addresses"/);
    assert.match(page.text, /https:\/\/localhost:9446/);
    assert.match(page.text, /value="edge-node-3"/);

    // A third one goes on the next free offset; names and explicit clashes are refused.
    const third = await api('post', `${gatewayUrl}/nodes`, admin).send({ name: 'edge-node-3' });
    assert.equal(third.body.node.portOffset, 2);
    assert.equal((await api('post', `${gatewayUrl}/nodes`, admin).send({ name: 'edge-node-2' })).status, 409);
    assert.equal((await api('post', `${gatewayUrl}/nodes`, admin).send({ name: 'has space' })).status, 400);
    const clash = await api('post', `${gatewayUrl}/nodes`, admin).send({ name: 'edge-node-4', portOffset: 1 });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /would both use port/);
  });

  it('places a node on another server on the usual ports and moves nodes', async () => {
    const res = await api('post', `${gatewayUrl}/nodes`, admin).send({ name: 'edge-node-2', host: '10.0.0.6', portOffset: 0 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.node.host, '10.0.0.6');
    assert.equal(res.body.addresses.traffic[0].url, 'https://10.0.0.6:8443');
    assert.equal((await api('post', `${gatewayUrl}/nodes`, admin).send({ name: 'bad', host: 'https://x' })).status, 400);

    // Moving it to the first node's host on the same ports collides; with an offset it fits.
    const nodeUrl = `${gatewayUrl}/nodes/${res.body.node.id}`;
    assert.equal((await api('put', nodeUrl, admin).send({ host: 'localhost' })).status, 409);
    const moved = await api('put', nodeUrl, admin).send({ host: 'localhost', portOffset: 5 });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.addresses.traffic[0].url, 'https://localhost:8448');
  });

  it('runs a handler on every node or on one node only', async () => {
    const second = (await api('post', `${gatewayUrl}/nodes`, admin).send({ name: 'edge-node-2', host: '10.0.0.6', portOffset: 0 })).body.node;
    const internal = await api('post', `${gatewayUrl}/handlers`, admin).send({ name: 'Internal', port: 8080, protocol: 'http', nodeId: second.id });
    assert.equal(internal.status, 201, JSON.stringify(internal.body));
    assert.equal(internal.body.handler.nodeId, second.id);
    // The port is free on the other nodes, but not on the same node or for the whole cluster.
    const first = await GatewayNode.findOne({ where: { name: 'edge-node-1' } });
    assert.equal((await api('post', `${gatewayUrl}/handlers`, admin).send({ name: 'Other', port: 8080, protocol: 'http', nodeId: first.id })).status, 201);
    assert.equal((await api('post', `${gatewayUrl}/handlers`, admin).send({ name: 'Again', port: 8080, protocol: 'http', nodeId: second.id })).status, 409);
    assert.equal((await api('post', `${gatewayUrl}/handlers`, admin).send({ name: 'Cluster', port: 8080, protocol: 'http' })).status, 409);
    assert.equal((await api('post', `${gatewayUrl}/handlers`, admin).send({ name: 'Nowhere', port: 9000, protocol: 'http', nodeId: 'not-a-node' })).status, 400);

    // Each node's configuration names the node; the gateway skips handlers for other nodes.
    const { config } = await buildGatewayConfig(await loadGateway({ id: gatewayId }));
    const byPort = config.handlers.filter((handler) => handler.port === 8080).map((handler) => handler.nodes);
    assert.deepEqual(byPort.sort(), [['edge-node-1'], ['edge-node-2']]);
    assert.equal(config.handlers.find((handler) => handler.port === 8443).nodes, undefined);

    const gateway = (await api('get', gatewayUrl, admin)).body.gateway;
    assert.deepEqual(gateway.addresses.nodes[second.id].traffic.map((entry) => entry.url), ['http://10.0.0.6:8080', 'https://10.0.0.6:8443']);
    assert.deepEqual(gateway.addresses.nodes[first.id].traffic.map((entry) => entry.url), ['http://localhost:8080', 'https://localhost:8443']);

    // Moving the cluster-wide handler to one node, then removing that node, removes its handlers.
    const cluster = await GatewayHandler.findOne({ where: { port: 8443 } });
    const moved = await api('put', `${gatewayUrl}/handlers/${cluster.id}`, admin).send({ nodeId: second.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((await api('delete', `${gatewayUrl}/nodes/${second.id}`, admin)).status, 200);
    assert.deepEqual((await GatewayHandler.findAll({ where: { gatewayId } })).map((handler) => handler.name), ['Other']);
  });
});
