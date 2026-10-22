// The schema designer: an API document's components.schemas, created, saved, renamed and deleted
// one schema at a time (/api/org/apis/:id/schemas/:name).
const { Api } = require('../models');
const { sendServerError } = require('../utils/http');
const { serializeApi } = require('./apiController');
const { isOpenApi31, renderComponents } = require('../utils/dictionary');
const { withComponentSchemas } = require('../utils/openapiDesign');
const {
  validateSchemaName,
  checkSchemaShape,
  withSchema,
  withoutSchema,
  missingRefs,
} = require('../utils/schemaDesign');
const { loadDictionary, importIntoDictionary } = require('../services/dictionary');

const MAX_SPEC_JSON = 4 * 1024 * 1024;

const findOrgApi = (req) => Api.findOne({ where: { id: req.params.id, organizationId: req.user.organizationId } });

const handle = (handler) => async (req, res) => {
  try {
    const api = await findOrgApi(req);
    if (!api) return res.status(404).json({ error: 'API not found' });
    return await handler(req, res, api);
  } catch (error) {
    return sendServerError(res, error, 'Failed to save the schema');
  }
};

const answer = (res, result) => res.status(result.status || 400).json({
  error: result.error,
  ...(result.conflicts && { conflicts: result.conflicts }),
  ...(result.uses && { uses: result.uses }),
});

// Dictionary objects the schema now refers to are written into the document first (asking before
// replacing a different schema of the same name), then the schema itself.
const write = async (req, res, api, { name, schema, create, newName }) => {
  const shape = checkSchemaShape(schema);
  if (shape.error) return res.status(400).json({ error: shape.error });

  let spec = api.spec;
  const objectIds = Array.isArray(req.body?.addObjects) ? req.body.addObjects.filter((id) => typeof id === 'string').slice(0, 50) : [];
  if (objectIds.length) {
    const dictionary = await loadDictionary(req.user.organizationId);
    const unknown = objectIds.find((id) => !dictionary.objects.has(id));
    if (unknown) return res.status(400).json({ error: 'One of the objects is not in your dictionary' });
    const written = withComponentSchemas(spec, renderComponents(objectIds, dictionary, { openapi31: isOpenApi31(spec) }), { replace: req.body.replace === true });
    if (written.error) return answer(res, written);
    spec = written.spec;
  }

  const result = withSchema(spec, name, schema, { create, newName });
  if (result.error) return answer(res, result);
  const missing = missingRefs(result.spec, checkSchemaShape(result.spec.components.schemas[result.name]).refs || []);
  if (missing.length) {
    return res.status(400).json({ error: `${missing[0].path} points at ${missing[0].name}, which isn't a schema of this document` });
  }
  if (JSON.stringify(result.spec).length > MAX_SPEC_JSON) {
    return res.status(400).json({ error: 'The OpenAPI document would be larger than 4 MB' });
  }
  await api.update({ spec: result.spec });
  return res.status(create ? 201 : 200).json({
    api: serializeApi(api),
    name: result.name,
    schema: result.spec.components.schemas[result.name],
  });
};

// { name, schema? } (a new schema is an empty object unless one is given)
const createSchema = handle(async (req, res, api) => {
  const { name, error } = validateSchemaName(req.body?.name);
  if (error) return res.status(400).json({ error });
  const schema = req.body?.schema === undefined
    ? { type: 'object', properties: {} }
    : req.body.schema;
  return write(req, res, api, { name, schema, create: true });
});

// { schema, name? (to rename), addObjects?: [dictionary object ids], replace? }
const updateSchema = handle(async (req, res, api) => {
  let newName = null;
  if (req.body?.name !== undefined && req.body.name !== req.params.name) {
    const checked = validateSchemaName(req.body.name);
    if (checked.error) return res.status(400).json({ error: checked.error });
    newName = checked.name;
  }
  const current = api.spec.components?.schemas?.[req.params.name];
  if (current === undefined) return res.status(404).json({ error: 'That schema does not exist' });
  const schema = req.body?.schema === undefined ? current : req.body.schema;
  return write(req, res, api, { name: req.params.name, schema, create: false, newName });
});

const deleteSchema = handle(async (req, res, api) => {
  const result = withoutSchema(api.spec, req.params.name);
  if (result.error) return answer(res, result);
  await api.update({ spec: result.spec });
  return res.json({ api: serializeApi(api), message: 'Schema deleted' });
});

// Adds the schema (and the schemas it uses) to the data dictionary.
const addToDictionary = handle(async (req, res, api) => {
  const schemas = api.spec.components?.schemas || {};
  if (!Object.prototype.hasOwnProperty.call(schemas, req.params.name)) return res.status(404).json({ error: 'That schema does not exist' });
  // Only this schema and what it refers to, directly or not.
  const keep = new Set();
  const queue = [req.params.name];
  while (queue.length) {
    const name = queue.shift();
    if (keep.has(name) || !Object.prototype.hasOwnProperty.call(schemas, name)) continue;
    keep.add(name);
    for (const ref of checkSchemaShape(schemas[name]).refs || []) queue.push(ref.name);
  }
  const spec = {
    openapi: api.spec.openapi,
    info: api.spec.info,
    paths: {},
    components: { schemas: Object.fromEntries([...keep].map((name) => [name, schemas[name]])) },
  };
  const dictionary = await importIntoDictionary({ spec, organizationId: req.user.organizationId, apiId: api.id, userId: req.user.id });
  return res.json({ dictionary });
});

module.exports = { createSchema, updateSchema, deleteSchema, addToDictionary };
