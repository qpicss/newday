const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  models,
  resetDatabase,
  createUser,
  createCatalog,
  api,
  browser,
  VALID_APP,
} = require('./helpers');

const { Api, ApiProduct, Subscription } = models;

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Orders API
  version: 2.1.0
  description: Manage orders
servers:
  - url: https://api.acme.test/v2
paths:
  /orders:
    get:
      summary: List orders
    post:
      summary: Create order
  /orders/{id}:
    get:
      summary: Get order
    delete:
      summary: Cancel order
      deprecated: true
`;

const OPENAPI_31_JSON = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Users API', version: '1' },
  paths: { '/users': { get: { summary: 'List users' } } },
});

// APIs and products live in a catalog: each user gets one on first use.
const catalogIds = new Map();
const catalogOf = async (user) => {
  if (!catalogIds.has(user.id)) catalogIds.set(user.id, (await createCatalog(user)).id);
  return catalogIds.get(user.id);
};
const importApi = async (user, content = OPENAPI_YAML) => api('post', '/api/org/apis/import', user).send({ content, catalogId: await catalogOf(user) });
const createApi = async (user, body) => api('post', '/api/org/apis', user).send({ catalogId: await catalogOf(user), ...body });

describe('APIs', () => {
  let admin;
  let member;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser();
    member = await createUser({ organization: { id: admin.organizationId } });
  });

  it('imports an OpenAPI 3.0 YAML file', async () => {
    const res = await importApi(admin);

    assert.equal(res.status, 201);
    const { api: imported } = res.body;
    assert.equal(imported.name, 'Orders API');
    assert.equal(imported.version, '2.1.0');
    assert.equal(imported.baseUrl, 'https://api.acme.test/v2');
    assert.equal(imported.source, 'import');
    assert.equal(imported.operationCount, 4);
    assert.deepEqual(imported.operations.map((op) => `${op.method} ${op.path}`), [
      'get /orders', 'post /orders', 'get /orders/{id}', 'delete /orders/{id}',
    ]);
    assert.equal(imported.operations[3].deprecated, true);
    assert.equal(imported.catalogId, await catalogOf(admin));
  });

  it('needs a catalog of the organization for new APIs', async () => {
    const otherAdmin = await createUser();
    const foreignCatalog = await catalogOf(otherAdmin);

    const none = await api('post', '/api/org/apis/import', admin).send({ content: OPENAPI_YAML });
    const foreign = await api('post', '/api/org/apis/import', admin).send({ content: OPENAPI_YAML, catalogId: foreignCatalog });
    const manual = await api('post', '/api/org/apis', admin).send({ name: 'X', version: '1' });

    [none, foreign, manual].forEach((res) => {
      assert.equal(res.status, 400);
      assert.match(res.body.error, /catalog/);
    });
    assert.equal(await Api.count(), 0);
  });

  it('imports an OpenAPI 3.1 JSON document', async () => {
    const res = await importApi(admin, OPENAPI_31_JSON);

    assert.equal(res.status, 201);
    assert.equal(res.body.api.openapi, '3.1.0');
    assert.equal(res.body.api.version, '1');
  });

  for (const [label, content, message] of [
    ['Swagger 2.0', JSON.stringify({ swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} }), /Swagger 2.0/],
    ['an unsupported version', JSON.stringify({ openapi: '4.0.0', info: { title: 'X', version: '1' }, paths: {} }), /3\.0 or later/],
    ['a missing title', JSON.stringify({ openapi: '3.0.0', info: { version: '1' }, paths: {} }), /info\.title/],
    ['invalid YAML', 'openapi: [unclosed', /could not be parsed/],
    ['an empty file', '   ', /empty/],
    ['a path without a leading slash', JSON.stringify({ openapi: '3.0.0', info: { title: 'X', version: '1' }, paths: { users: {} } }), /must start with/],
  ]) {
    it(`rejects ${label}`, async () => {
      const res = await importApi(admin, content);

      assert.equal(res.status, 400);
      assert.match(res.body.error, message);
      assert.equal(await Api.count(), 0);
    });
  }

  it('accepts imports larger than the normal JSON limit', async () => {
    const paths = {};
    for (let i = 0; i < 2000; i += 1) {
      paths[`/resource-${i}`] = { get: { summary: `Get resource number ${i} with a reasonably long summary` } };
    }
    const content = JSON.stringify({ openapi: '3.0.3', info: { title: 'Big', version: '1' }, paths });
    assert.ok(content.length > 100 * 1024);

    const res = await importApi(admin, content);
    assert.equal(res.status, 201);
    assert.equal(res.body.api.operationCount, 2000);
  });

  it('creates an API from scratch with endpoints and a generated OpenAPI document', async () => {
    const res = await createApi(admin, {
      name: 'Billing API',
      version: '1.0.0',
      baseUrl: 'https://billing.acme.test',
      description: 'Invoices and payments',
      endpoints: [
        { method: 'GET', path: '/invoices', summary: 'List invoices' },
        { method: 'post', path: '/invoices' },
      ],
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.api.operationCount, 2);
    const stored = await Api.findByPk(res.body.api.id);
    assert.equal(stored.spec.openapi, '3.0.3');
    assert.equal(stored.spec.info.title, 'Billing API');
    assert.equal(stored.spec.servers[0].url, 'https://billing.acme.test');
    assert.equal(stored.spec.paths['/invoices'].get.summary, 'List invoices');
  });

  it('validates new APIs', async () => {
    const noName = await createApi(admin, { version: '1' });
    const badUrl = await createApi(admin, { name: 'X', version: '1', baseUrl: 'ftp://nope' });
    const badPath = await createApi(admin, { name: 'X', version: '1', endpoints: [{ method: 'get', path: 'no-slash' }] });
    const badMethod = await createApi(admin, { name: 'X', version: '1', endpoints: [{ method: 'fetch', path: '/x' }] });

    [noName, badUrl, badPath, badMethod].forEach((res) => assert.equal(res.status, 400));
  });

  it('adds and removes endpoints', async () => {
    const { body } = await importApi(admin);
    const url = `/api/org/apis/${body.api.id}`;

    const added = await api('post', `${url}/operations`, admin).send({ method: 'patch', path: '/orders/{id}', summary: 'Update order' });
    const duplicate = await api('post', `${url}/operations`, admin).send({ method: 'patch', path: '/orders/{id}' });
    const removed = await api('delete', `${url}/operations?method=get&path=${encodeURIComponent('/orders')}`, admin);
    const missing = await api('delete', `${url}/operations?method=put&path=${encodeURIComponent('/orders')}`, admin);

    assert.equal(added.status, 201);
    assert.equal(added.body.api.operationCount, 5);
    assert.equal(duplicate.status, 409);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.api.operationCount, 4);
    assert.ok(!removed.body.api.operations.some((op) => op.method === 'get' && op.path === '/orders'));
    assert.equal(missing.status, 404);
  });

  it('updates details and keeps the OpenAPI info in sync', async () => {
    const { body } = await importApi(admin);
    const res = await api('put', `/api/org/apis/${body.api.id}`, admin).send({ name: 'Orders API v3', version: '3.0.0', baseUrl: '' });

    assert.equal(res.status, 200);
    const stored = await Api.findByPk(body.api.id);
    assert.equal(stored.spec.info.title, 'Orders API v3');
    assert.equal(stored.spec.info.version, '3.0.0');
    assert.equal(stored.spec.servers, undefined);
  });

  it('downloads the OpenAPI document', async () => {
    const { body } = await importApi(admin);
    const res = await api('get', `/api/org/apis/${body.api.id}/spec`, admin);

    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'], /attachment; filename="orders-api-2.1.0.json"/);
    assert.equal(JSON.parse(res.text).info.title, 'Orders API');
  });

  it('keeps APIs private to the organization and to org admins', async () => {
    const { body } = await importApi(admin);
    const otherAdmin = await createUser();

    const otherList = await api('get', '/api/org/apis', otherAdmin);
    const otherRead = await api('get', `/api/org/apis/${body.api.id}`, otherAdmin);
    const otherDelete = await api('delete', `/api/org/apis/${body.api.id}`, otherAdmin);
    const memberList = await api('get', '/api/org/apis', member);

    assert.deepEqual(otherList.body.apis, []);
    assert.equal(otherRead.status, 404);
    assert.equal(otherDelete.status, 404);
    assert.equal(memberList.status, 403);
  });
});

describe('API products', () => {
  let admin;
  let apiId;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser();
    const { body } = await importApi(admin);
    apiId = body.api.id;
  });

  const createProduct = async (body = { name: 'Orders Starter' }) => api('post', '/api/org/products', admin).send({ catalogId: await catalogOf(admin), ...body });

  it('needs a catalog of the organization for new products', async () => {
    const none = await api('post', '/api/org/products', admin).send({ name: 'No catalog' });
    const foreign = await api('post', '/api/org/products', admin).send({ name: 'Foreign', catalogId: await catalogOf(await createUser()) });

    assert.equal(none.status, 400);
    assert.equal(foreign.status, 400);
    assert.equal(await ApiProduct.count(), 0);
  });

  it("only adds APIs from the product's own catalog", async () => {
    const second = await createCatalog(admin, 'Second catalog');
    const { body: elsewhere } = await api('post', '/api/org/apis/import', admin).send({ content: OPENAPI_31_JSON, catalogId: second.id });
    const { body } = await createProduct();

    const res = await api('post', `/api/org/products/${body.product.id}/apis`, admin).send({ apiId: elsewhere.api.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /another catalog/);

    const listed = await api('get', `/api/org/apis?catalogId=${second.id}`, admin);
    assert.deepEqual(listed.body.apis.map((item) => item.name), ['Users API']);
  });

  it("deletes a catalog only once it's empty", async () => {
    const catalogId = await catalogOf(admin);
    const busy = await api('delete', `/api/org/catalogs/${catalogId}`, admin);
    assert.equal(busy.status, 409);

    const empty = await createCatalog(admin, 'Empty');
    assert.equal((await api('delete', `/api/org/catalogs/${empty.id}`, admin)).status, 200);
  });

  it('creates a draft product and publishes it once it has an API', async () => {
    const { body } = await createProduct({ name: 'Orders Starter', description: 'Read and write orders' });
    const url = `/api/org/products/${body.product.id}`;
    assert.equal(body.product.status, 'draft');

    const tooEarly = await api('put', url, admin).send({ status: 'published' });
    assert.equal(tooEarly.status, 400);

    const added = await api('post', `${url}/apis`, admin).send({ apiId });
    assert.equal(added.status, 201);
    assert.deepEqual(added.body.product.apis.map((a) => a.name), ['Orders API']);

    const published = await api('put', url, admin).send({ status: 'published' });
    assert.equal(published.status, 200);
    assert.equal(published.body.product.status, 'published');
  });

  it('saves rate limit and billing settings', async () => {
    const { body } = await createProduct();
    const url = `/api/org/products/${body.product.id}`;

    const rate = await api('put', url, admin).send({ rateLimitEnabled: true, rateLimitRequests: 500, rateLimitPeriod: 'minute' });
    const billing = await api('put', url, admin).send({ billingPlan: 'flat', billingPrice: 49.99, billingCurrency: 'EUR', billingInterval: 'year' });

    assert.deepEqual(rate.body.product.rateLimit, { enabled: true, requests: 500, period: 'minute' });
    assert.deepEqual(billing.body.product.billing, { plan: 'flat', priceCents: 4999, currency: 'EUR', interval: 'year' });

    const free = await api('put', url, admin).send({ billingPlan: 'free' });
    assert.equal(free.body.product.billing.priceCents, 0);
  });

  for (const [label, input] of [
    ['a zero rate limit', { rateLimitRequests: 0 }],
    ['a fractional rate limit', { rateLimitRequests: 1.5 }],
    ['an unknown period', { rateLimitPeriod: 'week' }],
    ['an unknown plan', { billingPlan: 'tiered' }],
    ['a negative price', { billingPrice: -1 }],
    ['an unknown currency', { billingCurrency: 'XYZ' }],
    ['a paid plan without a price', { billingPlan: 'usage', billingPrice: 0 }],
  ]) {
    it(`rejects ${label}`, async () => {
      const { body: created } = await createProduct();
      const res = await api('put', `/api/org/products/${created.product.id}`, admin).send(input);

      assert.equal(res.status, 400);
    });
  }

  it("only adds the organization's own APIs", async () => {
    const otherAdmin = await createUser();
    const { body: other } = await importApi(otherAdmin, OPENAPI_31_JSON);
    const { body } = await createProduct();

    const res = await api('post', `/api/org/products/${body.product.id}/apis`, admin).send({ apiId: other.api.id });
    assert.equal(res.status, 400);
  });

  it('unpublishes a product when its last API is removed or deleted', async () => {
    const { body } = await createProduct();
    const url = `/api/org/products/${body.product.id}`;
    await api('post', `${url}/apis`, admin).send({ apiId });
    await api('put', url, admin).send({ status: 'published' });

    const removed = await api('delete', `${url}/apis/${apiId}`, admin);
    assert.equal(removed.body.product.status, 'draft');

    await api('post', `${url}/apis`, admin).send({ apiId });
    await api('put', url, admin).send({ status: 'published' });
    const deleted = await api('delete', `/api/org/apis/${apiId}`, admin);
    assert.deepEqual(deleted.body.unpublishedProductIds, [body.product.id]);
    assert.equal((await ApiProduct.findByPk(body.product.id)).status, 'draft');
  });

  it("keeps products private to the organization's admins", async () => {
    const { body } = await createProduct();
    const otherAdmin = await createUser();
    const member = await createUser({ organization: { id: admin.organizationId } });

    const otherRead = await api('get', `/api/org/products/${body.product.id}`, otherAdmin);
    const otherUpdate = await api('put', `/api/org/products/${body.product.id}`, otherAdmin).send({ name: 'Hijacked' });
    const memberRead = await api('get', '/api/org/products', member);

    assert.equal(otherRead.status, 404);
    assert.equal(otherUpdate.status, 404);
    assert.equal(memberRead.status, 403);
  });
});

describe('catalog and access requests', () => {
  let publisher;
  let developer;
  let outsider;
  let productId;
  let catalogId;
  let applicationId;

  beforeEach(async () => {
    await resetDatabase();
    publisher = await createUser({ name: 'Publisher Admin' });
    // An invited member of the publishing organization.
    developer = await createUser({ name: 'Dev', organization: { id: publisher.organizationId } });
    outsider = await createUser({ name: 'Outsider' });

    catalogId = await catalogOf(publisher);
    const { body: imported } = await importApi(publisher);
    const { body: created } = await api('post', '/api/org/products', publisher).send({ name: 'Orders Starter', catalogId });
    productId = created.product.id;
    await api('post', `/api/org/products/${productId}/apis`, publisher).send({ apiId: imported.api.id });
    await api('put', `/api/org/products/${productId}`, publisher).send({ status: 'published' });
    await api('post', '/api/org/products', publisher).send({ name: 'Secret Draft', catalogId });

    const { body: app } = await api('post', '/api/applications', developer).send(VALID_APP);
    applicationId = app.application.id;
  });

  const requestAccess = (user = developer, appId = applicationId) => api('post', `/api/applications/${appId}/subscriptions`, user).send({ productId });

  it("lists only the organization's published products, by catalog", async () => {
    const res = await api('get', '/api/catalog', developer);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.products.map((product) => product.name), ['Orders Starter']);
    assert.equal(res.body.products[0].catalog.id, catalogId);
    assert.deepEqual(res.body.catalogs.map((catalog) => [catalog.name, catalog.productCount]), [['Main catalog', 1]]);

    // Other organizations see nothing of it.
    const elsewhere = await api('get', '/api/catalog', outsider);
    assert.deepEqual(elsewhere.body.products, []);
    assert.equal((await api('get', `/api/catalog/${productId}`, outsider)).status, 404);
  });

  it("only subscribes applications of the product's organization", async () => {
    const { body: own } = await api('post', '/api/applications', outsider).send(VALID_APP);
    const foreign = await api('post', `/api/applications/${own.application.id}/subscriptions`, outsider).send({ productId });
    assert.equal(foreign.status, 404);

    // A member with an application from another organization can't use it here.
    const { Membership } = models;
    await Membership.create({ userId: outsider.id, organizationId: publisher.organizationId, role: 'member' });
    await api('put', '/api/me/organization', outsider).send({ organizationId: publisher.organizationId });
    const crossed = await api('post', `/api/applications/${own.application.id}/subscriptions`, outsider).send({ productId });
    assert.equal(crossed.status, 400);
    assert.match(crossed.body.error, /another organization/);
    // Applications are listed per organization.
    assert.deepEqual((await api('get', '/api/applications', outsider)).body.applications, []);
  });

  it('shows endpoints when inspecting a product', async () => {
    const res = await api('get', `/api/catalog/${productId}`, developer);

    assert.equal(res.status, 200);
    assert.equal(res.body.product.apis[0].operations.length, 4);
    assert.ok(!JSON.stringify(res.body).includes('"spec"'));
  });

  it('runs the request, approve and revoke flow', async () => {
    const requested = await requestAccess();
    assert.equal(requested.status, 201);
    assert.equal(requested.body.subscription.status, 'pending');

    const again = await requestAccess();
    assert.equal(again.status, 409);

    const pending = await api('get', '/api/org/subscriptions?status=pending', publisher);
    assert.equal(pending.body.subscriptions.length, 1);
    assert.equal(pending.body.subscriptions[0].application.owner.name, 'Dev');

    const subscriptionId = requested.body.subscription.id;
    const approved = await api('put', `/api/org/subscriptions/${subscriptionId}`, publisher).send({ status: 'approved' });
    assert.equal(approved.body.subscription.status, 'approved');

    const rejectApproved = await api('put', `/api/org/subscriptions/${subscriptionId}`, publisher).send({ status: 'rejected' });
    assert.equal(rejectApproved.status, 400);

    const revoked = await api('put', `/api/org/subscriptions/${subscriptionId}`, publisher).send({ status: 'revoked' });
    assert.equal(revoked.body.subscription.status, 'revoked');

    // A revoked application can ask again.
    const reRequested = await requestAccess();
    assert.equal(reRequested.status, 201);
    assert.equal(reRequested.body.subscription.status, 'pending');
  });

  it('only lets the publishing organization admin decide', async () => {
    const { body } = await requestAccess();
    const otherAdmin = await createUser();
    const publisherMember = await createUser({ organization: { id: publisher.organizationId } });

    const byDeveloper = await api('put', `/api/org/subscriptions/${body.subscription.id}`, developer).send({ status: 'approved' });
    const byOtherAdmin = await api('put', `/api/org/subscriptions/${body.subscription.id}`, otherAdmin).send({ status: 'approved' });
    const byMember = await api('put', `/api/org/subscriptions/${body.subscription.id}`, publisherMember).send({ status: 'approved' });

    assert.equal(byDeveloper.status, 403);
    assert.equal(byOtherAdmin.status, 404);
    assert.equal(byMember.status, 403);
    assert.equal((await Subscription.findByPk(body.subscription.id)).status, 'pending');
  });

  it("only lets an app's owner request access for it", async () => {
    const stranger = await createUser();
    const res = await requestAccess(stranger);

    assert.equal(res.status, 404);
  });

  it("can't subscribe to draft products", async () => {
    await api('put', `/api/org/products/${productId}`, publisher).send({ status: 'draft' });
    const res = await requestAccess();

    assert.equal(res.status, 404);
  });

  it('lets the owner cancel a subscription', async () => {
    const { body } = await requestAccess();
    const res = await api('delete', `/api/applications/${applicationId}/subscriptions/${body.subscription.id}`, developer);

    assert.equal(res.status, 200);
    assert.equal(await Subscription.count(), 0);
  });

  it('removes subscriptions when the application is deleted', async () => {
    await requestAccess();
    await api('delete', `/api/applications/${applicationId}`, developer);

    assert.equal(await Subscription.count(), 0);
  });

  it('renders the catalog, product and approval pages', async () => {
    await requestAccess();

    const catalogs = await browser('get', '/developer/catalogs', developer);
    const catalog = await browser('get', `/developer/catalogs/${catalogId}`, developer);
    const product = await browser('get', `/developer/catalog/${productId}`, developer);
    const requests = await browser('get', '/developer/requests', publisher);
    const adminCatalog = await browser('get', `/developer/catalogs/${catalogId}`, publisher);
    const dashboard = await browser('get', '/developer/dashboard', publisher);
    const appPage = await browser('get', `/developer/applications/${applicationId}`, developer);

    assert.ok(catalogs.text.includes('Main catalog'));
    assert.ok(catalog.text.includes('Orders Starter'));
    assert.ok(!catalog.text.includes('Secret Draft'));
    assert.ok(product.text.includes('/orders/{id}'));
    assert.ok(product.text.includes('Pending approval'));
    assert.ok(requests.text.includes('Waiting for a decision'));
    assert.ok(requests.text.includes('Storefront') || requests.text.includes(VALID_APP.name));
    assert.ok(adminCatalog.text.includes('Secret Draft'));
    assert.ok(adminCatalog.text.includes('Create API'));
    assert.ok(dashboard.text.includes('1 access request is waiting'));
    assert.ok(appPage.text.includes('Orders Starter'));
  });

  it('hides API and product management from members', async () => {
    const member = developer;
    const { body: apis } = await api('get', '/api/org/apis', publisher);

    for (const path of [`/developer/apis/${apis.apis[0].id}`, `/developer/products/${productId}`, '/developer/requests', `/developer/catalogs/${catalogId}/apis/new`, '/developer/gateways']) {
      const res = await browser('get', path, member);
      assert.equal(res.status, 403, path);
    }
    const catalog = await browser('get', `/developer/catalogs/${catalogId}`, member);
    assert.equal(catalog.status, 200);
    assert.ok(!catalog.text.includes('Create API'));
    assert.ok(!catalog.text.includes('href="/developer/gateways"'));
    // The old organization-wide pages lead to the catalogs.
    const old = await browser('get', '/developer/products', member);
    assert.equal(old.status, 302);
    assert.equal(old.headers.location, '/developer/catalogs');
  });
});
