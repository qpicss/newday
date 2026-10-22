// Schema designer: an API document's components.schemas created, saved, renamed and deleted.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, resetDatabase, createUser, createCatalog, api, browser } = require('./helpers');

const { Api, DictionaryObject } = models;

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Orders', version: '1.0.0' },
  paths: {
    '/orders': {
      get: { responses: { 200: { description: 'Orders', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } } },
    },
  },
  components: {
    schemas: {
      Order: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' }, lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } } } },
      Line: { type: 'object', properties: { sku: { type: 'string' }, parent: { $ref: '#/components/schemas/Line' } } },
      Unused: { type: 'string', enum: ['a', 'b'] },
    },
  },
};

describe('schema designer', () => {
  let admin;
  let apiId;
  const url = (name = '') => `/api/org/apis/${apiId}/schemas${name ? `/${encodeURIComponent(name)}` : ''}`;
  const specOf = async () => (await Api.findByPk(apiId)).spec;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser();
    const catalog = await createCatalog(admin);
    apiId = (await api('post', '/api/org/apis/import', admin).send({ content: JSON.stringify(SPEC), catalogId: catalog.id })).body.api.id;
  });

  it('creates schemas and refuses bad names, shapes and references', async () => {
    const created = await api('post', url(), admin).send({ name: 'Address' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual((await specOf()).components.schemas.Address, { type: 'object', properties: {} });
    assert.equal((await api('post', url(), admin).send({ name: 'Address' })).status, 409);
    assert.equal((await api('post', url(), admin).send({ name: 'Bad name' })).status, 400);

    const shapes = [
      [{ type: 'object', properties: [] }, /properties must be an object/],
      [{ type: 'text' }, /type must be/],
      [{ type: 'object', properties: { a: { type: 'string' } }, required: 'a' }, /required must be a list/],
      [{ type: 'object', properties: { owner: { $ref: '#/components/schemas/Nobody' } } }, /Nobody, which isn't a schema/],
    ];
    for (const [schema, message] of shapes) {
      const res = await api('put', url('Address'), admin).send({ schema });
      assert.equal(res.status, 400, JSON.stringify(schema));
      assert.match(res.body.error, message);
    }
  });

  it('saves nested changes and renames a schema with every reference to it', async () => {
    const schema = {
      type: 'object',
      required: ['id', 'total'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        total: { type: 'number', minimum: 0 },
        shipping: { type: 'object', properties: { city: { type: 'string', maxLength: 80 } } },
        lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } },
        replaces: { $ref: '#/components/schemas/Order' },
      },
    };
    const res = await api('put', url('Order'), admin).send({ schema, name: 'PurchaseOrder' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'PurchaseOrder');
    const spec = await specOf();
    assert.equal(spec.components.schemas.Order, undefined);
    assert.deepEqual(Object.keys(spec.components.schemas), ['PurchaseOrder', 'Line', 'Unused'], 'keeps its place');
    assert.equal(spec.components.schemas.PurchaseOrder.properties.replaces.$ref, '#/components/schemas/PurchaseOrder', 'its own reference follows');
    assert.equal(spec.paths['/orders'].get.responses['200'].content['application/json'].schema.items.$ref, '#/components/schemas/PurchaseOrder');
    assert.equal((await api('put', url('Line'), admin).send({ name: 'PurchaseOrder' })).status, 409);
  });

  it('refuses to delete a schema in use, and deletes it once unused', async () => {
    const used = await api('delete', url('Line'), admin);
    assert.equal(used.status, 409);
    assert.match(used.body.error, /Order/);
    assert.deepEqual(used.body.uses.map((use) => use.name), ['Order']);
    assert.equal((await api('delete', url('Unused'), admin)).status, 200);
    assert.equal((await specOf()).components.schemas.Unused, undefined);
    assert.equal((await api('delete', url('Unused'), admin)).status, 404);
  });

  it('writes dictionary objects it now refers to, and unlinks a dictionary schema once changed here', async () => {
    const sku = (await api('post', '/api/org/dictionary/fields', admin).send({ name: 'barcode', schema: { type: 'string' } })).body.field;
    const tag = (await api('post', '/api/org/dictionary/objects', admin).send({ name: 'Tag', properties: [{ name: 'barcode', fieldId: sku.id }] })).body.object;
    const res = await api('put', url('Line'), admin).send({
      schema: { type: 'object', properties: { sku: { type: 'string' }, tag: { $ref: '#/components/schemas/Tag' } } },
      addObjects: [tag.id],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let spec = await specOf();
    assert.equal(spec.components.schemas.Tag['x-dictionary-id'], tag.id);

    // Saved unchanged, it stays linked; changed here, it becomes the document's own.
    await api('put', url('Tag'), admin).send({ schema: spec.components.schemas.Tag });
    assert.equal((await specOf()).components.schemas.Tag['x-dictionary-id'], tag.id);
    await api('put', url('Tag'), admin).send({ schema: { ...spec.components.schemas.Tag, description: 'Changed here' } });
    spec = await specOf();
    assert.equal(spec.components.schemas.Tag['x-dictionary-id'], undefined);
    assert.equal(spec.components.schemas.Tag.description, 'Changed here');
  });

  it('adds a schema and the schemas it uses to the dictionary', async () => {
    await DictionaryObject.destroy({ where: {} });
    const res = await api('post', `${url('Order')}/dictionary`, admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await DictionaryObject.findAll()).map((object) => object.name).sort(), ['Line', 'Order']);
  });

  it('renders the designer for org admins of the API only', async () => {
    const page = await browser('get', `/developer/apis/${apiId}/schemas?name=Line`, admin);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-state=/);
    assert.match(page.text, /Used by/);
    assert.match(page.text, /href="\/developer\/apis\/[^"]+\/schemas\?name=Order"/);

    const outsider = await createUser();
    assert.equal((await browser('get', `/developer/apis/${apiId}/schemas`, outsider)).status, 404);
    assert.equal((await api('put', url('Line'), outsider).send({ schema: { type: 'object' } })).status, 404);
    const member = await createUser({ organization: await models.Organization.findByPk(admin.organizationId) });
    assert.equal((await api('put', url('Line'), member).send({ schema: { type: 'object' } })).status, 403);
  });
});
