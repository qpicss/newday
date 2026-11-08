// The API page lists endpoints as a tree of paths.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { listOperations, operationTree } = require('../utils/openapi');

describe('operation tree', () => {
  it('nests paths under their parents and joins segments without operations', () => {
    const spec = {
      paths: {
        '/': { get: {} },
        '/health': { get: {} },
        '/v1/orders': { get: {}, post: {} },
        '/v1/orders/{id}': { get: {}, delete: {} },
        '/v1/orders/{id}/items': { get: {} },
        '/v1/users': { get: {} },
        '/admin/tools/reindex': { post: {} },
      },
    };
    const rows = operationTree(listOperations(spec)).map(({ depth, label, path, operations }) => [depth, label, path, operations.map((operation) => operation.method).join(',')]);
    assert.deepEqual(rows, [
      [0, '/', '/', 'get'],
      [1, '/admin/tools/reindex', '/admin/tools/reindex', 'post'],
      [1, '/health', '/health', 'get'],
      [1, '/v1', '/v1', ''],
      [2, '/orders', '/v1/orders', 'get,post'],
      [3, '/{id}', '/v1/orders/{id}', 'get,delete'],
      [4, '/items', '/v1/orders/{id}/items', 'get'],
      [2, '/users', '/v1/users', 'get'],
    ]);
  });

  it('marks operations served without a token', () => {
    const [open, closed] = listOperations({ paths: { '/a': { get: { 'x-gateway-access': 'public' } }, '/b': { get: { 'x-gateway-access': 'anyone' } } } });
    assert.equal(open.public, true);
    assert.equal(closed.public, false);
  });
});
