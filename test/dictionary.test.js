// Data dictionary and API designer: importing an OpenAPI document fills the dictionary, fields and
// objects are kept per organization, and the designer writes them into an API's document.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, resetDatabase, createUser, createCatalog, api, browser } = require('./helpers');
const { operationContract } = require('../utils/openapiContract');
const { renderField } = require('../utils/dictionary');
const { planImport } = require('../utils/dictionaryImport');

const { Api, DictionaryField, DictionaryObject, DictionaryProperty } = models;

const ORDERS_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Orders', version: '1.0.0' },
  paths: {
    '/orders/{orderId}': {
      parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        operationId: 'getOrder',
        parameters: [{ name: 'X-Request-Id', in: 'header', schema: { type: 'string', maxLength: 64 } }],
        responses: { 200: { description: 'The order', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
      },
    },
    '/orders': {
      post: {
        operationId: 'createOrder',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['customerId'], properties: { customerId: { type: 'string', format: 'uuid' }, note: { type: 'string', nullable: true } } } } } },
        responses: { 201: { description: 'Created' } },
      },
      get: { responses: { 200: { description: 'Orders' } } },
    },
  },
  components: {
    schemas: {
      Status: { type: 'string', enum: ['open', 'paid'] },
      Base: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
      Order: {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { type: 'object', properties: { status: { $ref: '#/components/schemas/Status' }, lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } }, shipping: { type: 'object', properties: { city: { type: 'string' } } } } },
        ],
      },
      Line: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, parent: { $ref: '#/components/schemas/Line' } } },
      Pet: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    },
  },
};

const importOrders = async (user, spec = ORDERS_SPEC) => {
  const catalog = await createCatalog(user);
  const res = await api('post', '/api/org/apis/import', user).send({ content: JSON.stringify(spec), catalogId: catalog.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const createField = async (user, body) => {
  const res = await api('post', '/api/org/dictionary/fields', user).send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.field;
};

const op = (method, path) => `method=${method}&path=${encodeURIComponent(path)}`;
const specOf = async (apiId) => (await Api.findByPk(apiId)).spec;

describe('data dictionary import', () => {
  let admin;
  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser();
  });

  it('turns schemas, parameters and inline bodies into fields and objects when an API is imported', async () => {
    const { dictionary } = await importOrders(admin);
    assert.ok(dictionary.fieldsAdded > 0 && dictionary.objectsAdded > 0, JSON.stringify(dictionary));
    assert.ok(dictionary.notes.some((note) => note.includes('Pet')), 'oneOf schemas are reported, not guessed');

    const fields = await DictionaryField.findAll();
    const names = fields.map((field) => field.name).sort();
    // Line.id clashes with Base.id (integer vs uuid string), so it is named after its object.
    for (const name of ['Line.id', 'Status', 'X-Request-Id', 'city', 'customerId', 'id', 'note', 'orderId']) assert.ok(names.includes(name), `${name} in ${names}`);
    assert.deepEqual(fields.find((field) => field.name === 'note').schema, { type: 'string', nullable: true });

    const objects = await DictionaryObject.findAll();
    assert.deepEqual(objects.map((object) => object.name).sort(), ['Base', 'CreateOrderRequest', 'Line', 'Order', 'Shipping']);
    const order = objects.find((object) => object.name === 'Order');
    const properties = await DictionaryProperty.findAll({ where: { objectId: order.id }, order: [['position', 'ASC']] });
    assert.deepEqual(properties.map((property) => property.name), ['id', 'status', 'lines', 'shipping'], 'allOf members first, in order');
    const lines = properties.find((property) => property.name === 'lines');
    assert.equal(lines.isArray, true);
    assert.equal(lines.refObjectId, objects.find((object) => object.name === 'Line').id);
    assert.equal(properties.find((property) => property.name === 'id').required, true);

    // A second import of the same document reuses everything.
    const again = await api('post', `/api/org/apis/${(await Api.findOne()).id}/dictionary`, admin);
    assert.equal(again.status, 200);
    assert.equal(again.body.dictionary.fieldsAdded, 0);
    assert.equal(again.body.dictionary.objectsAdded, 0);
  });

  it('reads OpenAPI 3.1 forms back into the dictionary form', () => {
    const plan = planImport({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {},
      components: { schemas: { Price: { type: 'object', properties: { amount: { type: ['number', 'null'], exclusiveMinimum: 0 } } } } },
    });
    assert.deepEqual(plan.fields[0].schema, { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true });
    assert.deepEqual(renderField({ schema: plan.fields[0].schema }, { openapi31: true }), { type: ['number', 'null'], exclusiveMinimum: 0 });
  });
});

describe('data dictionary fields and objects', () => {
  let admin;
  let member;
  let outsider;
  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser();
    member = await createUser({ organization: await models.Organization.findByPk(admin.organizationId) });
    outsider = await createUser();
  });

  it('validates fields and keeps names unique per organization', async () => {
    const bad = [
      [{ name: 'has space', schema: { type: 'string' } }, /Field names/],
      [{ name: 'code', schema: { type: 'text' } }, /Choose a type/],
      [{ name: 'code', schema: { type: 'string', pattern: '[' } }, /regular expression/],
      [{ name: 'code', schema: { type: 'string', minLength: 5, maxLength: 2 } }, /Minimum length/],
      [{ name: 'code', schema: { type: 'integer', enum: [1, 'two'] } }, /allowed value/],
      [{ name: 'code', schema: { type: 'string', minimum: 1 } }, /doesn't apply/],
      [{ name: 'tags', schema: { type: 'array' } }, /item/],
    ];
    for (const [body, message] of bad) {
      const res = await api('post', '/api/org/dictionary/fields', admin).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, message);
    }

    const field = await createField(admin, { name: 'currency', description: 'ISO 4217 code', schema: { type: 'string', pattern: '^[A-Z]{3}$', example: 'EUR', readOnly: false } });
    assert.deepEqual(field.schema, { type: 'string', pattern: '^[A-Z]{3}$', example: 'EUR' });
    assert.equal((await api('post', '/api/org/dictionary/fields', admin).send({ name: 'Currency', schema: { type: 'string' } })).status, 409);
    // Another organization has its own names and can't see this field.
    await createField(outsider, { name: 'currency', schema: { type: 'string' } });
    assert.equal((await api('get', `/api/org/dictionary/fields/${field.id}`, outsider)).status, 404);
    assert.equal((await api('put', `/api/org/dictionary/fields/${field.id}`, outsider).send({ name: 'x' })).status, 404);
    // Members of the organization don't manage its dictionary.
    assert.equal((await api('get', '/api/org/dictionary', member)).status, 403);
  });

  it('gives object fields a structure of their own, without references', async () => {
    const field = await createField(admin, { name: 'customer', schema: { type: 'object' } });
    const structure = {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 80 },
        phone: { type: 'string', nullable: true },
        address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        tags: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
      },
      required: ['name'],
      additionalProperties: false,
    };
    const saved = await api('put', `/api/org/dictionary/fields/${field.id}`, admin).send({ schema: structure });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.field.schema, { type: 'object', properties: structure.properties, required: ['name'], additionalProperties: false });
    assert.equal(saved.body.field.summary, 'object · 4 properties');

    const page = await browser('get', `/developer/dictionary/fields/${field.id}`, admin);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-structure-editor/);
    assert.match(page.text, /data-schema-editor/);

    const bad = [
      [{ type: 'object', properties: { owner: { $ref: '#/components/schemas/User' } } }, /\$ref/],
      [{ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, /b is required/],
      [{ type: 'object', properties: { a: { type: 'text' } } }, /type must be/],
      [{ type: 'string', properties: { a: { type: 'string' } } }, /doesn't apply/],
    ];
    for (const [schema, message] of bad) {
      const res = await api('put', `/api/org/dictionary/fields/${field.id}`, admin).send({ schema });
      assert.equal(res.status, 400, JSON.stringify(schema));
      assert.match(res.body.error, message);
    }

    // Written into a 3.1 document, nested values use 3.1 forms too.
    assert.deepEqual(renderField({ schema: { type: 'object', properties: { phone: { type: 'string', nullable: true } } } }, { openapi31: true }).properties.phone, { type: ['string', 'null'] });
  });

  it('builds objects from fields and objects, and refuses deletes that would break them', async () => {
    const id = await createField(admin, { name: 'id', schema: { type: 'string', format: 'uuid' } });
    const city = await createField(admin, { name: 'city', description: 'City name', schema: { type: 'string', maxLength: 80 } });
    const address = (await api('post', '/api/org/dictionary/objects', admin).send({ name: 'Address', properties: [{ name: 'city', fieldId: city.id, required: true }] })).body.object;
    const created = await api('post', '/api/org/dictionary/objects', admin).send({
      name: 'Customer',
      description: 'A buyer',
      properties: [{ name: 'id', fieldId: id.id, required: true }, { name: 'addresses', objectId: address.id, isArray: true }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const customer = created.body.object;
    assert.deepEqual(Object.keys(customer.preview), ['Customer', 'Address']);
    assert.deepEqual(customer.preview.Customer.properties.addresses, { type: 'array', items: { $ref: '#/components/schemas/Address' } });
    assert.deepEqual(customer.preview.Address.properties.city, { type: 'string', description: 'City name', maxLength: 80 });

    const objectDelete = await api('delete', `/api/org/dictionary/objects/${address.id}`, admin);
    assert.equal(objectDelete.status, 409, 'Customer uses Address');
    assert.match(objectDelete.body.error, /Customer/);

    // Trees: an object may contain itself.
    const tree = await api('put', `/api/org/dictionary/objects/${customer.id}`, admin).send({
      properties: [{ name: 'id', fieldId: id.id }, { name: 'referredBy', objectId: customer.id }],
    });
    assert.equal(tree.status, 200, JSON.stringify(tree.body));

    const invalid = [
      [{ name: 'Bad name!' }, /Object names/],
      [{ name: 'Twice', properties: [{ name: 'a', fieldId: id.id }, { name: 'a', fieldId: city.id }] }, /two properties/],
      [{ name: 'Both', properties: [{ name: 'a', fieldId: id.id, objectId: address.id }] }, /either a field or an object/],
      [{ name: 'Foreign', properties: [{ name: 'a', fieldId: (await createField(outsider, { name: 'secret', schema: { type: 'string' } })).id }] }, /isn't in your dictionary/],
    ];
    for (const [body, message] of invalid) {
      const res = await api('post', '/api/org/dictionary/objects', admin).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, message);
    }

    const fieldDelete = await api('delete', `/api/org/dictionary/fields/${city.id}`, admin);
    assert.equal(fieldDelete.status, 409);
    assert.match(fieldDelete.body.error, /Address/);
    assert.equal((await api('delete', `/api/org/dictionary/objects/${address.id}`, admin)).status, 200);
    assert.equal(await DictionaryProperty.count({ where: { objectId: address.id } }), 0);
    assert.equal((await api('delete', `/api/org/dictionary/fields/${city.id}`, admin)).status, 200);
  });
});

describe('API designer', () => {
  let admin;
  let apiId;
  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser();
    apiId = (await importOrders(admin)).api.id;
  });

  it('opens and edits a body or response schema written inline, keeping the field link while it matches', async () => {
    const cust = await createField(admin, { name: 'cust', description: 'cust obj', schema: { type: 'object', properties: { name: { type: 'string' } } } });
    const set = await api('put', `/api/org/apis/${apiId}/operations/body?${op('post', '/orders')}`, admin).send({ source: { type: 'field', id: cust.id }, required: true });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    const design = await browser('get', `/developer/apis/${apiId}/design?${op('post', '/orders')}`, admin);
    assert.match(design.text, new RegExp(`/developer/apis/${apiId}/design/schema\\?method=post&path=%2Forders&contentType=application%2Fjson`));
    const page = await browser('get', `/developer/apis/${apiId}/design/schema?${op('post', '/orders')}&contentType=application%2Fjson`, admin);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-schema-editor/);
    assert.match(page.text, /id="updateField"/);
    assert.equal((await browser('get', `/developer/apis/${apiId}/design/schema?${op('post', '/orders')}&contentType=text%2Fplain`, admin)).status, 404);

    const url = `/api/org/apis/${apiId}/operations/content-schema?${op('post', '/orders')}&contentType=application%2Fjson`;
    const media = async () => (await specOf(apiId)).paths['/orders'].post.requestBody.content['application/json'];
    // Saved as the field says: still linked.
    const same = await api('put', url, admin).send({ schema: (await media()).schema });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal((await media())['x-dictionary-field'], cust.id);

    // Changed here only: the document's own schema now, the field is untouched.
    const changed = { type: 'object', description: 'cust obj', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name'] };
    assert.equal((await api('put', url, admin).send({ schema: changed })).status, 200);
    assert.deepEqual((await media()).schema, changed);
    assert.equal((await media())['x-dictionary-field'], undefined);
    assert.equal((await DictionaryField.findByPk(cust.id)).schema.properties.age, undefined);

    // References must exist; a 201 response is edited the same way.
    const missing = await api('put', url, admin).send({ schema: { type: 'object', properties: { owner: { $ref: '#/components/schemas/Nope' } } } });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Nope/);
    const noBody = await api('put', `/api/org/apis/${apiId}/operations/content-schema?${op('post', '/orders')}&status=201&contentType=application%2Fjson`, admin).send({ schema: { type: 'string' } });
    assert.equal(noBody.status, 404);
    const response = await api('put', `/api/org/apis/${apiId}/operations/content-schema?${op('get', '/orders/{orderId}')}&status=200&contentType=application%2Fjson`, admin)
      .send({ schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((await specOf(apiId)).paths['/orders/{orderId}'].get.responses['200'].content['application/json'].schema.items, { $ref: '#/components/schemas/Order' });

    // Updating the field as well: linked again, and the field holds the structure.
    await api('put', `/api/org/apis/${apiId}/operations/body?${op('post', '/orders')}`, admin).send({ source: { type: 'field', id: cust.id }, required: true });
    const both = await api('put', url, admin).send({ schema: changed, updateField: true });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    const field = await DictionaryField.findByPk(cust.id);
    assert.deepEqual(field.schema.properties, changed.properties);
    assert.deepEqual(field.schema.required, ['name']);
    assert.equal((await media())['x-dictionary-field'], cust.id);
    const withRef = await api('put', url, admin).send({ schema: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } }, updateField: true });
    assert.equal(withRef.status, 400);

    // Another organization's API is not found.
    const other = await createUser();
    assert.equal((await api('put', url, other).send({ schema: changed })).status, 404);
  });

  it('moves a body written in the endpoint into components.schemas', async () => {
    const cust = await createField(admin, { name: 'cust', description: 'cust obj', schema: { type: 'object', properties: { name: { type: 'string' } } } });
    await api('put', `/api/org/apis/${apiId}/operations/body?${op('post', '/orders')}`, admin).send({ source: { type: 'field', id: cust.id }, required: true });
    const design = await browser('get', `/developer/apis/${apiId}/design?${op('post', '/orders')}`, admin);
    assert.match(design.text, /content-schema\/move\?method=post/);

    const url = `/api/org/apis/${apiId}/operations/content-schema/move?${op('post', '/orders')}&contentType=application%2Fjson`;
    const moved = await api('post', url, admin).send({});
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.name, 'cust');
    const spec = await specOf(apiId);
    assert.deepEqual(spec.components.schemas.cust, { type: 'object', description: 'cust obj', properties: { name: { type: 'string' } } });
    assert.deepEqual(spec.paths['/orders'].post.requestBody.content['application/json'], { schema: { $ref: '#/components/schemas/cust' } });
    assert.equal(spec.paths['/orders'].post.requestBody.required, true);
    assert.equal((await api('post', url, admin).send({})).status, 409, 'already a schema');

    // Named on request; a taken name is refused, and the default is numbered.
    await api('put', `/api/org/apis/${apiId}/operations/body?${op('post', '/orders')}`, admin).send({ source: { type: 'field', id: cust.id } });
    assert.equal((await api('post', url, admin).send({ name: 'Order' })).status, 409);
    assert.equal((await api('post', url, admin).send({ name: 'bad name!' })).status, 400);
    assert.equal((await api('post', url, admin).send({})).body.name, 'cust2');
  });

  it('adds parameters from dictionary fields and removes them', async () => {
    const limit = await createField(admin, { name: 'limit', description: 'Page size', schema: { type: 'integer', minimum: 1, maximum: 100 } });
    const add = await api('post', `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders')}`, admin).send({ fieldId: limit.id, in: 'query' });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const [param] = (await specOf(apiId)).paths['/orders'].get.parameters;
    assert.deepEqual(param, { name: 'limit', in: 'query', description: 'Page size', schema: { type: 'integer', minimum: 1, maximum: 100 }, 'x-dictionary-field': limit.id });

    // The gateway's Validate request step sees it.
    const contract = operationContract(await specOf(apiId), '/orders', 'get');
    assert.deepEqual(contract.parameters.map((item) => item.name), ['limit']);

    const pathParam = await api('post', `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders')}`, admin).send({ fieldId: limit.id, in: 'path' });
    assert.equal(pathParam.status, 400);
    assert.match(pathParam.body.error, /\{limit\}/);
    const shared = await api('delete', `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders/{orderId}')}&in=path&name=orderId`, admin);
    assert.equal(shared.status, 409, 'path-level parameters are edited in the source');

    const removed = await api('delete', `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders')}&in=query&name=limit`, admin);
    assert.equal(removed.status, 200);
    assert.equal((await specOf(apiId)).paths['/orders'].get.parameters, undefined);
  });

  it('edits an existing parameter: its schema, flags and the link to its dictionary field', async () => {
    const limit = await createField(admin, { name: 'limit', schema: { type: 'integer', minimum: 1 } });
    const base = `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders')}`;
    await api('post', base, admin).send({ fieldId: limit.id, in: 'query' });
    const edit = (query, body) => api('put', `${base}&${query}`, admin).send(body);

    // The page offers the parameter in the form's terms, since it is a plain field schema.
    const page = await browser('get', `/developer/apis/${apiId}/design?${op('get', '/orders')}`, admin);
    assert.match(page.text, /data-edit-parameter/);
    assert.match(page.text, /&#34;formSchema&#34;:\{&#34;type&#34;:&#34;integer&#34;/);

    // Updating the dictionary field too keeps the link.
    let res = await edit('in=query&name=limit', { schema: { type: 'integer', minimum: 1, maximum: 50 }, updateField: true, required: true, description: 'Page size' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let [param] = (await specOf(apiId)).paths['/orders'].get.parameters;
    assert.deepEqual(param, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 }, 'x-dictionary-field': limit.id, description: 'Page size', required: true });
    assert.equal((await DictionaryField.findByPk(limit.id)).schema.maximum, 50);

    // A schema of its own unlinks it; the field stays as it was.
    res = await edit('in=query&name=limit', { schema: { type: 'integer', maximum: 10 } });
    assert.equal(res.status, 200);
    [param] = (await specOf(apiId)).paths['/orders'].get.parameters;
    assert.deepEqual(param.schema, { type: 'integer', maximum: 10 });
    assert.equal(param['x-dictionary-field'], undefined);
    assert.equal((await DictionaryField.findByPk(limit.id)).schema.maximum, 50);

    // JSON for what the form doesn't cover.
    res = await edit('in=query&name=limit', { rawSchema: { oneOf: [{ type: 'integer' }, { type: 'string', enum: ['all'] }] } });
    assert.equal(res.status, 200);
    assert.equal((await specOf(apiId)).paths['/orders'].get.parameters[0].schema.oneOf.length, 2);

    assert.equal((await edit('in=query&name=limit', { schema: { type: 'integer', minimum: 5, maximum: 1 } })).status, 400);
    assert.equal((await edit('in=query&name=limit', { rawSchema: 'string' })).status, 400);
    assert.equal((await edit('in=query&name=missing', { required: true })).status, 404);

    // A path-level parameter is edited where it is defined, and stays required.
    res = await api('put', `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders/{orderId}')}&in=path&name=orderId`, admin)
      .send({ schema: { type: 'string', pattern: '^[0-9a-f-]{36}$' }, required: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.scope, 'path');
    const [orderId] = (await specOf(apiId)).paths['/orders/{orderId}'].parameters;
    assert.deepEqual(orderId, { name: 'orderId', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f-]{36}$' } });
    const header = await api('put', `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders/{orderId}')}&in=header&name=X-Request-Id`, admin)
      .send({ schema: { type: 'object' } });
    assert.equal(header.status, 400, 'only query parameters hold objects');
  });

  it('uses dictionary objects as bodies, writing them into components.schemas', async () => {
    const sku = await createField(admin, { name: 'sku', schema: { type: 'string', maxLength: 20 } });
    const qty = await createField(admin, { name: 'qty', schema: { type: 'integer', minimum: 1 } });
    const item = (await api('post', '/api/org/dictionary/objects', admin).send({ name: 'CartItem', properties: [{ name: 'sku', fieldId: sku.id, required: true }, { name: 'qty', fieldId: qty.id }] })).body.object;
    const cart = (await api('post', '/api/org/dictionary/objects', admin).send({ name: 'Cart', additionalProperties: false, properties: [{ name: 'items', objectId: item.id, isArray: true, required: true }] })).body.object;

    const res = await api('put', `/api/org/apis/${apiId}/operations/body?${op('post', '/orders')}`, admin)
      .send({ source: { type: 'object', id: cart.id }, required: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const spec = await specOf(apiId);
    assert.deepEqual(spec.paths['/orders'].post.requestBody, { content: { 'application/json': { schema: { $ref: '#/components/schemas/Cart' } } }, required: true });
    assert.equal(spec.components.schemas.Cart['x-dictionary-id'], cart.id);
    assert.equal(spec.components.schemas.CartItem['x-dictionary-id'], item.id, 'objects it uses come along');
    assert.equal(spec.components.schemas.Cart.additionalProperties, false);

    // The gateway's Validate body step gets the resolved schema.
    const contract = operationContract(spec, '/orders', 'post');
    assert.deepEqual(contract.body.content['application/json'].schema.properties.items.items.required, ['sku']);

    assert.equal((await api('put', `/api/org/apis/${apiId}/operations/body?${op('get', '/orders')}`, admin).send({ source: { type: 'object', id: cart.id } })).status, 400, 'GET has no body');

    const response = await api('put', `/api/org/apis/${apiId}/operations/responses?${op('get', '/orders')}`, admin)
      .send({ status: '200', description: 'Orders', source: { type: 'schema', name: 'Order' }, isArray: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((await specOf(apiId)).paths['/orders'].get.responses['200'].content['application/json'].schema, { type: 'array', items: { $ref: '#/components/schemas/Order' } });
    const last = await api('delete', `/api/org/apis/${apiId}/operations/responses?${op('get', '/orders')}&status=200`, admin);
    assert.equal(last.status, 409, 'an endpoint keeps one response');
  });

  it('asks before replacing a schema the dictionary did not write', async () => {
    const total = await createField(admin, { name: 'total', schema: { type: 'number' } });
    // "Order" exists in the imported document without the dictionary mark.
    const order = (await DictionaryObject.findOne({ where: { name: 'Order' } }));
    await api('put', `/api/org/dictionary/objects/${order.id}`, admin).send({ properties: [{ name: 'total', fieldId: total.id }] });
    const body = { source: { type: 'object', id: order.id } };
    const conflict = await api('put', `/api/org/apis/${apiId}/operations/body?${op('post', '/orders')}`, admin).send(body);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body.conflicts, ['Order']);
    const replaced = await api('put', `/api/org/apis/${apiId}/operations/body?${op('post', '/orders')}`, admin).send({ ...body, replace: true });
    assert.equal(replaced.status, 200);
    assert.deepEqual(Object.keys((await specOf(apiId)).components.schemas.Order.properties), ['total']);
  });

  it('takes over a schema that says the same as the dictionary object, without asking', async () => {
    // Line was imported from this document into the dictionary, so both describe it the same way.
    const line = await DictionaryObject.findOne({ where: { name: 'Line' } });
    const res = await api('put', `/api/org/apis/${apiId}/operations/responses?${op('get', '/orders')}`, admin)
      .send({ status: '200', description: 'Lines', source: { type: 'object', id: line.id }, isArray: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await specOf(apiId)).components.schemas.Line['x-dictionary-id'], line.id);
  });

  it('updates what came from the dictionary after it changes, including renamed objects', async () => {
    const code = await createField(admin, { name: 'code', schema: { type: 'string' } });
    const coupon = (await api('post', '/api/org/dictionary/objects', admin).send({ name: 'Coupon', properties: [{ name: 'code', fieldId: code.id }] })).body.object;
    await api('put', `/api/org/apis/${apiId}/operations/body?${op('post', '/orders')}`, admin).send({ source: { type: 'object', id: coupon.id } });
    await api('post', `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders')}`, admin).send({ fieldId: code.id, in: 'query' });

    await api('put', `/api/org/dictionary/fields/${code.id}`, admin).send({ schema: { type: 'string', maxLength: 12 } });
    await api('put', `/api/org/dictionary/objects/${coupon.id}`, admin).send({ name: 'Voucher' });
    // Nothing changes in the API until it is updated on purpose.
    assert.ok((await specOf(apiId)).components.schemas.Coupon);

    const page = await browser('get', `/developer/apis/${apiId}/design?${op('post', '/orders')}`, admin);
    assert.equal(page.status, 200);
    assert.match(page.text, /Out of date/);

    const refresh = await api('post', `/api/org/apis/${apiId}/components/refresh`, admin);
    assert.equal(refresh.status, 200, JSON.stringify(refresh.body));
    assert.deepEqual(refresh.body.refresh.renamed, [{ from: 'Coupon', to: 'Voucher' }]);
    const spec = await specOf(apiId);
    assert.equal(spec.components.schemas.Coupon, undefined);
    assert.deepEqual(spec.components.schemas.Voucher.properties.code, { type: 'string', maxLength: 12 });
    assert.equal(spec.paths['/orders'].post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/Voucher');
    assert.deepEqual(spec.paths['/orders'].get.parameters[0].schema, { type: 'string', maxLength: 12 });
  });

  it('edits operation details and refuses a duplicate operation ID', async () => {
    const res = await api('put', `/api/org/apis/${apiId}/operations?${op('get', '/orders')}`, admin).send({ summary: 'List orders', operationId: 'listOrders', deprecated: true });
    assert.equal(res.status, 200);
    const operation = (await specOf(apiId)).paths['/orders'].get;
    assert.equal(operation.summary, 'List orders');
    assert.equal(operation.deprecated, true);
    const duplicate = await api('put', `/api/org/apis/${apiId}/operations?${op('get', '/orders')}`, admin).send({ operationId: 'getOrder' });
    assert.equal(duplicate.status, 409);
  });

  it('saves the whole document from the source editor', async () => {
    const before = await Api.findByPk(apiId);
    const invalid = await api('put', `/api/org/apis/${apiId}/spec`, admin).send({ content: '{\n  "openapi": "3.0.3",\n  "info": {\n}' });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.line >= 3, JSON.stringify(invalid.body));

    const check = await api('post', `/api/org/apis/${apiId}/spec/validate`, admin).send({ content: 'openapi: 3.0.3\ninfo:\n  title: Renamed\n  version: "2.0"\npaths: {}\n' });
    assert.deepEqual(check.body, { valid: true, name: 'Renamed', version: '2.0', openapi: '3.0.3', operationCount: 0 });

    const yaml = 'openapi: 3.0.3\ninfo:\n  title: Renamed\n  version: "2.0"\nservers:\n  - url: https://orders.example.com\npaths:\n  /ping:\n    get:\n      responses:\n        "200":\n          description: ok\n';
    const saved = await api('put', `/api/org/apis/${apiId}/spec`, admin).send({ content: yaml, updatedAt: before.updatedAt.toISOString() });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const after = await Api.findByPk(apiId);
    assert.equal(after.name, 'Renamed');
    assert.equal(after.version, '2.0');
    assert.equal(after.baseUrl, 'https://orders.example.com');
    assert.deepEqual(Object.keys(after.spec.paths), ['/ping']);

    // The editor that opened before that save can't overwrite it.
    const stale = await api('put', `/api/org/apis/${apiId}/spec`, admin).send({ content: yaml, updatedAt: before.updatedAt.toISOString() });
    assert.equal(stale.status, 409);
  });

  it('keeps APIs and dictionaries of other organizations out of reach', async () => {
    const outsider = await createUser();
    const foreign = await createField(outsider, { name: 'foreign', schema: { type: 'string' } });
    assert.equal((await api('put', `/api/org/apis/${apiId}/spec`, outsider).send({ content: '{}' })).status, 404);
    assert.equal((await api('post', `/api/org/apis/${apiId}/dictionary`, outsider)).status, 404);
    const res = await api('post', `/api/org/apis/${apiId}/operations/parameters?${op('get', '/orders')}`, admin).send({ fieldId: foreign.id, in: 'query' });
    assert.equal(res.status, 400);
    assert.equal((await browser('get', `/developer/apis/${apiId}/design`, outsider)).status, 404);
  });

  it('renders the dictionary, field, object, designer and source pages', async () => {
    const field = await DictionaryField.findOne({ where: { name: 'customerId' } });
    const object = await DictionaryObject.findOne({ where: { name: 'Order' } });
    const pages = [
      ['/developer/dictionary', /customerId/],
      ['/developer/dictionary?view=objects', /CreateOrderRequest/],
      [`/developer/dictionary/fields/${field.id}`, /CreateOrderRequest/],
      [`/developer/dictionary/objects/${object.id}`, /data-builder-state/],
      [`/developer/apis/${apiId}/design?${op('get', '/orders/{orderId}')}`, /X-Request-Id/],
      [`/developer/apis/${apiId}/source?format=yaml`, /openapi: 3\.0\.3/],
    ];
    for (const [path, content] of pages) {
      const page = await browser('get', path, admin);
      assert.equal(page.status, 200, path);
      assert.match(page.text, content, path);
    }
  });
});
