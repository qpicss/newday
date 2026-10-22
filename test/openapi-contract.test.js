// What the gateway's Validate steps receive for an operation: parameters and request body taken
// from the OpenAPI document, with $refs resolved.
require('./helpers');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { operationContract } = require('../utils/openapiContract');

const spec = {
  openapi: '3.0.3',
  info: { title: 'Orders', version: '1' },
  paths: {
    '/orders/{id}': {
      parameters: [
        { $ref: '#/components/parameters/Tenant' },
        { in: 'query', name: 'expand', schema: { type: 'string' } },
        { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
      ],
      put: {
        parameters: [
          { in: 'query', name: 'expand', required: true, schema: { type: 'boolean' } },
          { in: 'header', name: 'Content-Type', schema: { type: 'string' } },
          { in: 'query', name: 'filter', content: { 'application/json': { schema: { type: 'object' } } } },
        ],
        requestBody: { $ref: '#/components/requestBodies/Order' },
        responses: { 200: { description: 'ok' } },
      },
      get: { responses: { 200: { description: 'ok' } } },
    },
  },
  components: {
    parameters: { Tenant: { in: 'header', name: 'X-Tenant', required: true, schema: { $ref: '#/components/schemas/Slug' } } },
    requestBodies: {
      Order: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } }, 'text/plain': {} } },
    },
    schemas: {
      Slug: { type: 'string', pattern: '^[a-z]+$', example: 'acme' },
      Order: {
        type: 'object',
        properties: {
          quantity: { type: 'integer' },
          // Recursive: an order can contain orders.
          parts: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
          missing: { $ref: '#/components/schemas/Nowhere' },
        },
      },
    },
  },
};

describe('OpenAPI operation contracts', () => {
  it('merges path and operation parameters, resolving references, and skips what OpenAPI ignores', () => {
    const contract = operationContract(spec, '/orders/{id}', 'put');
    assert.deepEqual(contract.parameters, [
      { in: 'header', name: 'X-Tenant', required: true, schema: { type: 'string', pattern: '^[a-z]+$' } },
      { in: 'query', name: 'expand', required: true, schema: { type: 'boolean' } },
      { in: 'query', name: 'filter', required: false, contentType: 'application/json', schema: { type: 'object' } },
    ]);
  });

  it('resolves the request body, cutting recursive and broken references', () => {
    const { body } = operationContract(spec, '/orders/{id}', 'put');
    assert.equal(body.required, true);
    assert.deepEqual(Object.keys(body.content), ['application/json', 'text/plain']);
    const order = body.content['application/json'].schema;
    assert.deepEqual(order.properties.quantity, { type: 'integer' });
    assert.deepEqual(order.properties.parts.items, {}, 'where the schema refers back to itself, anything is accepted');
    assert.deepEqual(order.properties.missing, {});
    assert.deepEqual(body.content['text/plain'], {});
  });

  it('describes operations without parameters or body, and nothing for unknown ones', () => {
    assert.deepEqual(operationContract(spec, '/orders/{id}', 'get').body, null);
    assert.equal(operationContract(spec, '/orders/{id}', 'delete'), null);
    assert.equal(operationContract(spec, '/nope', 'get'), null);
  });
});
