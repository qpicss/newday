// The API designer: edits an API's OpenAPI document as a whole (the source editor) or one operation
// at a time (parameters, request body, responses), using the organization's data dictionary.
// Operations are identified by ?method=get&path=/orders/{id}, like removeOperation.
const { Api, DictionaryField } = require('../models');
const { sendServerError } = require('../utils/http');
const { serializeApi } = require('./apiController');
const { parseSpecText, summarizeSpec, validateOperation, listOperations } = require('../utils/openapi');
const {
  validateName,
  validateFieldSchema,
  optionalDescription,
  isOpenApi31,
  componentRef,
  renderField,
  renderComponents,
  isPlainObject,
} = require('../utils/dictionary');
const {
  validateOperationInfo,
  validateStatus,
  validateContentType,
  withOperationInfo,
  describeOperation,
  withParameter,
  withParameterChanges,
  withoutParameter,
  withRequestBody,
  withoutRequestBody,
  withResponse,
  withoutResponse,
  withComponentSchemas,
  contentAt,
  withContentSchema,
  sameContent,
} = require('../utils/openapiDesign');
const { checkSchemaShape, missingRefs, validateSchemaName, withSchema } = require('../utils/schemaDesign');
const { normalizeValue } = require('../utils/dictionaryImport');
const { refreshFromDictionary } = require('../utils/dictionarySync');
const { loadDictionary } = require('../services/dictionary');

const MAX_SPEC_JSON = 4 * 1024 * 1024;

const findOrgApi = (req) => Api.findOne({ where: { id: req.params.id, organizationId: req.user.organizationId } });

const operationOf = (req) => {
  const { operation, error } = validateOperation({ method: req.query.method, path: req.query.path });
  return error ? { error } : { operationRef: { method: operation.method, path: operation.path } };
};

// Loads the API and the operation named in the query, or answers with the error.
const withApi = (handler, { needsOperation = true } = {}) => async (req, res) => {
  try {
    const api = await findOrgApi(req);
    if (!api) return res.status(404).json({ error: 'API not found' });
    let operationRef = null;
    if (needsOperation) {
      const result = operationOf(req);
      if (result.error) return res.status(400).json({ error: result.error });
      operationRef = result.operationRef;
    }
    return await handler(req, res, api, operationRef);
  } catch (error) {
    return sendServerError(res, error, 'Failed to update the OpenAPI document');
  }
};

const save = async (res, api, spec, extra = {}, status = 200) => {
  if (JSON.stringify(spec).length > MAX_SPEC_JSON) {
    return res.status(400).json({ error: 'The OpenAPI document would be larger than 4 MB' });
  }
  await api.update({ spec });
  return res.status(status).json({ api: serializeApi(api, { withOperations: true }), ...extra });
};

const answer = (res, result) => res.status(result.status || 400).json({ error: result.error, ...(result.conflicts && { conflicts: result.conflicts }) });

// What a body, response or parameter is described by:
//   { type: 'object', id } a dictionary object, written to components.schemas and referenced;
//   { type: 'schema', name } a schema the document already has;
//   { type: 'field', id } a dictionary field, written inline.
const schemaFromSource = async (req, api, source, { isArray = false } = {}) => {
  if (!isPlainObject(source)) return { error: 'Choose what describes it: a dictionary object, a schema of this document or a dictionary field' };
  const openapi31 = isOpenApi31(api.spec);
  let schema;
  let components = null;
  let fieldId = null;
  if (source.type === 'object') {
    const dictionary = await loadDictionary(req.user.organizationId);
    const object = typeof source.id === 'string' ? dictionary.objects.get(source.id) : null;
    if (!object) return { error: 'Choose an object from your dictionary' };
    components = renderComponents([object.id], dictionary, { openapi31 });
    schema = { $ref: componentRef(object.name) };
  } else if (source.type === 'schema') {
    const schemas = isPlainObject(api.spec.components?.schemas) ? api.spec.components.schemas : {};
    if (typeof source.name !== 'string' || !Object.prototype.hasOwnProperty.call(schemas, source.name)) {
      return { error: "Choose one of this document's schemas" };
    }
    schema = { $ref: componentRef(source.name) };
  } else if (source.type === 'field') {
    const field = typeof source.id === 'string'
      ? await DictionaryField.findOne({ where: { id: source.id, organizationId: req.user.organizationId } })
      : null;
    if (!field) return { error: 'Choose a field from your dictionary' };
    schema = renderField(field, { openapi31 });
    fieldId = field.id;
  } else {
    return { error: 'Choose a dictionary object, a schema of this document or a dictionary field' };
  }
  return { schema: isArray ? { type: 'array', items: schema } : schema, components, fieldId };
};

// Writes the dictionary objects first (asking before replacing other schemas), then the change.
const applyWithComponents = (spec, components, replace, change) => {
  let current = spec;
  if (components) {
    const written = withComponentSchemas(current, components, { replace });
    if (written.error) return written;
    current = written.spec;
  }
  return change(current);
};

// ------------------------------------------------------------------ Source editor

const readSpecContent = (req) => {
  const content = req.body?.content;
  if (typeof content !== 'string') return { error: 'Send the OpenAPI document as text (JSON or YAML)' };
  return parseSpecText(content);
};

const validateSource = withApi(async (req, res) => {
  const { spec, error, line } = readSpecContent(req);
  if (error) return res.json({ valid: false, error, line: line || null });
  const summary = summarizeSpec(spec);
  return res.json({ valid: true, name: summary.name, version: summary.version, openapi: spec.openapi, operationCount: listOperations(spec).length });
}, { needsOperation: false });

// Replaces the whole document. updatedAt (from when the editor opened) guards against overwriting
// a change saved meanwhile, in another tab or by someone else.
const saveSource = withApi(async (req, res, api) => {
  if (req.body?.updatedAt !== undefined) {
    const expected = new Date(req.body.updatedAt).getTime();
    if (Number.isNaN(expected) || expected !== new Date(api.updatedAt).getTime()) {
      return res.status(409).json({ error: 'This API was changed since you opened the editor. Copy your changes, reload the page and apply them again.' });
    }
  }
  const { spec, error, line } = readSpecContent(req);
  if (error) return res.status(400).json({ error, line: line || null });
  // The API's name, version, description and base URL follow the document's info and servers.
  await api.update({ ...summarizeSpec(spec), spec });
  return res.json({ api: serializeApi(api, { withOperations: true }) });
}, { needsOperation: false });

// ------------------------------------------------------------------ One operation

const updateOperationInfo = withApi(async (req, res, api, operationRef) => {
  const { info, error, status } = validateOperationInfo(req.body, api.spec, operationRef);
  if (error) return res.status(status || 400).json({ error });
  const result = withOperationInfo(api.spec, operationRef, info);
  return result.error ? answer(res, result) : save(res, api, result.spec);
});

// { fieldId, in, name? (defaults to the field's), required, description? (defaults to the field's) }
const addParameter = withApi(async (req, res, api, operationRef) => {
  const body = req.body || {};
  const field = typeof body.fieldId === 'string'
    ? await DictionaryField.findOne({ where: { id: body.fieldId, organizationId: req.user.organizationId } })
    : null;
  if (!field) return res.status(400).json({ error: 'Choose a field from your dictionary' });
  let { name } = field;
  if (typeof body.name === 'string' && body.name.trim()) {
    const checked = validateName(body.name, 'field');
    if (checked.error) return res.status(400).json({ error: checked.error.replace('Field names', 'Parameter names') });
    name = checked.name;
  }
  const description = optionalDescription(body.description);
  if (description.error) return res.status(400).json({ error: description.error });
  if (field.schema.type === 'object' && body.in !== 'query') {
    return res.status(400).json({ error: 'Only query parameters can hold an object' });
  }
  const result = withParameter(api.spec, operationRef, {
    in: body.in,
    name,
    required: body.required === true,
    description: description.value ?? field.description,
    schema: renderField(field, { openapi31: isOpenApi31(api.spec), withDescription: false }),
    fieldId: field.id,
  });
  if (result.error) return answer(res, result);
  return save(res, api, result.spec, { replaced: result.replaced }, result.replaced ? 200 : 201);
});

// Edits an existing parameter (?in=&name=). Body: { description, required, deprecated } and either
// schema (the field form's terms, checked like a dictionary field) or rawSchema (any JSON schema).
// A parameter made from a dictionary field stays linked to it only while it matches the field;
// updateField: true changes the field itself instead (form schemas only).
const MAX_RAW_SCHEMA = 100 * 1024;
const updateParameter = withApi(async (req, res, api, operationRef) => {
  if (typeof req.query.in !== 'string' || typeof req.query.name !== 'string') {
    return res.status(400).json({ error: 'Say which parameter to change (in and name)' });
  }
  const body = req.body || {};
  const openapi31 = isOpenApi31(api.spec);
  const description = optionalDescription(body.description);
  if (description.error) return res.status(400).json({ error: description.error });

  let schema;
  let canonical = null;
  if (body.schema !== undefined) {
    const checked = validateFieldSchema(body.schema);
    if (checked.error) return res.status(400).json({ error: checked.error });
    canonical = checked.schema;
    schema = renderField({ schema: canonical }, { openapi31, withDescription: false });
  } else if (body.rawSchema !== undefined) {
    if (!isPlainObject(body.rawSchema)) return res.status(400).json({ error: 'The schema must be a JSON object, for example {"type": "string"}' });
    if (JSON.stringify(body.rawSchema).length > MAX_RAW_SCHEMA) return res.status(400).json({ error: 'The schema is larger than 100 KB' });
    schema = body.rawSchema;
  }
  const type = canonical?.type || (typeof schema?.type === 'string' ? schema.type : null);
  if (type === 'object' && req.query.in !== 'query') {
    return res.status(400).json({ error: 'Only query parameters can hold an object' });
  }

  // The dictionary field the parameter came from, if it is still in the organization's dictionary.
  const current = describeOperation(api.spec, operationRef)?.parameters
    .find((param) => param.in === req.query.in && param.name === req.query.name);
  if (!current) return res.status(404).json({ error: 'That parameter does not exist' });
  const field = current.fieldId
    ? await DictionaryField.findOne({ where: { id: current.fieldId, organizationId: req.user.organizationId } })
    : null;

  let fieldId;
  if (schema && body.updateField === true) {
    if (!field) return res.status(400).json({ error: "This parameter isn't linked to a field of your dictionary" });
    if (!canonical) return res.status(400).json({ error: 'Only a schema from the form can update the dictionary field' });
    await field.update({ schema: canonical });
    fieldId = field.id;
  } else if (schema && current.fieldId) {
    // Still the field's schema: keep the link; otherwise the parameter now has a schema of its own.
    const matches = field && JSON.stringify(renderField(field, { openapi31, withDescription: false })) === JSON.stringify(schema);
    fieldId = matches ? field.id : null;
  }

  const result = withParameterChanges(api.spec, operationRef, { in: req.query.in, name: req.query.name }, {
    description: body.description === undefined ? undefined : description.value,
    required: body.required === undefined ? undefined : body.required === true,
    deprecated: body.deprecated === undefined ? undefined : body.deprecated === true,
    schema,
    fieldId,
  });
  if (result.error) return answer(res, result);
  return save(res, api, result.spec, { scope: result.scope, linkedFieldId: fieldId === undefined ? current.fieldId : fieldId });
});

const removeParameter = withApi(async (req, res, api, operationRef) => {
  if (typeof req.query.in !== 'string' || typeof req.query.name !== 'string') {
    return res.status(400).json({ error: 'Say which parameter to remove (in and name)' });
  }
  const result = withoutParameter(api.spec, operationRef, { in: req.query.in, name: req.query.name });
  return result.error ? answer(res, result) : save(res, api, result.spec);
});

// { contentType, source, isArray, required, description, replace }
const setRequestBody = withApi(async (req, res, api, operationRef) => {
  const body = req.body || {};
  const contentType = validateContentType(body.contentType ?? 'application/json');
  if (contentType.error) return res.status(400).json({ error: contentType.error });
  const description = optionalDescription(body.description);
  if (description.error) return res.status(400).json({ error: description.error });
  const source = await schemaFromSource(req, api, body.source, { isArray: body.isArray === true });
  if (source.error) return res.status(400).json({ error: source.error });
  const result = applyWithComponents(api.spec, source.components, body.replace === true, (spec) => withRequestBody(spec, operationRef, {
    contentType: contentType.type,
    schema: source.schema,
    fieldId: source.fieldId,
    required: body.required === true,
    description: body.description === undefined ? undefined : description.value || '',
  }));
  return result.error ? answer(res, result) : save(res, api, result.spec);
});

const removeRequestBody = withApi(async (req, res, api, operationRef) => {
  const result = withoutRequestBody(api.spec, operationRef, { contentType: typeof req.query.contentType === 'string' ? req.query.contentType : undefined });
  return result.error ? answer(res, result) : save(res, api, result.spec);
});

// { status, description, contentType, source (null: no body), isArray, replace }
const setResponse = withApi(async (req, res, api, operationRef) => {
  const body = req.body || {};
  const status = validateStatus(body.status);
  if (status.error) return res.status(400).json({ error: status.error });
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > 5000) return res.status(400).json({ error: 'Descriptions are at most 5000 characters' });
  let source = { schema: null, components: null, fieldId: null };
  let contentType = { type: null };
  if (body.source) {
    contentType = validateContentType(body.contentType ?? 'application/json');
    if (contentType.error) return res.status(400).json({ error: contentType.error });
    source = await schemaFromSource(req, api, body.source, { isArray: body.isArray === true });
    if (source.error) return res.status(400).json({ error: source.error });
  } else if (body.contentType) {
    contentType = validateContentType(body.contentType);
    if (contentType.error) return res.status(400).json({ error: contentType.error });
  }
  const result = applyWithComponents(api.spec, source.components, body.replace === true, (spec) => withResponse(spec, operationRef, {
    status: status.status,
    description,
    contentType: contentType.type,
    schema: source.schema,
    fieldId: source.fieldId,
  }));
  return result.error ? answer(res, result) : save(res, api, result.spec);
});

const removeResponse = withApi(async (req, res, api, operationRef) => {
  const status = validateStatus(req.query.status);
  if (status.error) return res.status(400).json({ error: status.error });
  const result = withoutResponse(api.spec, operationRef, status.status);
  return result.error ? answer(res, result) : save(res, api, result.spec);
});

// The schema of one body or response content entry, edited in the schema editor:
// ?method&path&contentType (&status for a response), { schema, addObjects?, replace?, updateField? }.
// A schema copied from a dictionary field keeps its link while it still says what the field says;
// updateField: true saves the change to the field too.
const updateContentSchema = withApi(async (req, res, api, operationRef) => {
  const target = { status: null, contentType: req.query.contentType };
  if (typeof target.contentType !== 'string' || !target.contentType) return res.status(400).json({ error: 'Say which content type to change' });
  if (req.query.status !== undefined) {
    const status = validateStatus(req.query.status);
    if (status.error) return res.status(400).json({ error: status.error });
    target.status = status.status;
  }
  const current = contentAt(api.spec, operationRef, target);
  if (current.error) return answer(res, current);

  const body = req.body || {};
  let schema = body.schema;
  const shape = checkSchemaShape(schema);
  if (shape.error) return res.status(400).json({ error: shape.error });
  const openapi31 = isOpenApi31(api.spec);

  let spec = api.spec;
  const objectIds = Array.isArray(body.addObjects) ? body.addObjects.filter((id) => typeof id === 'string').slice(0, 50) : [];
  if (objectIds.length) {
    const dictionary = await loadDictionary(req.user.organizationId);
    if (objectIds.some((id) => !dictionary.objects.has(id))) return res.status(400).json({ error: 'One of the objects is not in your dictionary' });
    const written = withComponentSchemas(spec, renderComponents(objectIds, dictionary, { openapi31 }), { replace: body.replace === true });
    if (written.error) return answer(res, written);
    spec = written.spec;
  }
  const missing = missingRefs(spec, shape.refs || []);
  if (missing.length) {
    return res.status(400).json({ error: `${missing[0].path} points at ${missing[0].name}, which isn't a schema of this document` });
  }

  const field = current.fieldId
    ? await DictionaryField.findOne({ where: { id: current.fieldId, organizationId: req.user.organizationId } })
    : null;
  let fieldId = null;
  if (body.updateField === true) {
    if (!field) return res.status(400).json({ error: "This schema isn't linked to a field of your dictionary" });
    if (shape.refs?.length) return res.status(400).json({ error: "A dictionary field can't point at the document's schemas. Remove the references, or save without updating the field." });
    const { description, properties, required, minProperties, maxProperties, ...rules } = schema;
    if (openapi31 && properties && Object.keys(properties).length) {
      return res.status(400).json({ error: 'In a 3.1 document, change the structure on the field\'s own page, or save without updating the field.' });
    }
    const normalized = normalizeValue(rules, { openapi31 });
    if (normalized.error) return res.status(400).json({ error: `The field can't hold this schema: it ${normalized.error}` });
    const checked = validateFieldSchema({
      ...normalized.schema,
      ...(normalized.schema.type === 'object' && { properties, required, minProperties, maxProperties }),
    });
    if (checked.error) return res.status(400).json({ error: checked.error });
    const fieldDescription = optionalDescription(description);
    if (fieldDescription.error) return res.status(400).json({ error: fieldDescription.error });
    await field.update({ schema: checked.schema, description: fieldDescription.value || '' });
    schema = renderField(field, { openapi31 });
    fieldId = field.id;
  } else if (field && sameContent(renderField(field, { openapi31 }), schema)) {
    fieldId = field.id;
  }

  const result = withContentSchema(spec, operationRef, target, { schema, fieldId });
  if (result.error) return answer(res, result);
  return save(res, api, result.spec, { schema, linkedFieldId: fieldId });
});

// Moves a body or response schema written in the endpoint into components.schemas, and points the
// content at it: ?method&path&contentType (&status), { name? }. Without a name it takes the dictionary
// field's name (or "<operationId>Body"), numbered when the document already has that name.
const moveContentToSchemas = withApi(async (req, res, api, operationRef) => {
  const target = { status: null, contentType: req.query.contentType };
  if (typeof target.contentType !== 'string' || !target.contentType) return res.status(400).json({ error: 'Say which content type to move' });
  if (req.query.status !== undefined) {
    const status = validateStatus(req.query.status);
    if (status.error) return res.status(400).json({ error: status.error });
    target.status = status.status;
  }
  const current = contentAt(api.spec, operationRef, target);
  if (current.error) return answer(res, current);
  if (current.schema.$ref) return res.status(409).json({ error: 'It already is one of the document\'s schemas' });
  if (!Object.keys(current.schema).length) return res.status(400).json({ error: 'There is no schema to move' });

  const existing = isPlainObject(api.spec.components?.schemas) ? api.spec.components.schemas : {};
  let name;
  if (req.body?.name !== undefined && req.body.name !== '') {
    const checked = validateSchemaName(req.body.name);
    if (checked.error) return res.status(400).json({ error: checked.error });
    if (Object.prototype.hasOwnProperty.call(existing, checked.name)) return res.status(409).json({ error: `The document already has a schema named ${checked.name}` });
    name = checked.name;
  } else {
    const field = current.fieldId
      ? await DictionaryField.findOne({ where: { id: current.fieldId, organizationId: req.user.organizationId } })
      : null;
    const operationId = api.spec.paths[operationRef.path][operationRef.method].operationId;
    const base = [field?.name, typeof operationId === 'string' ? `${operationId}${target.status ? `Response${target.status}` : 'Body'}` : null, target.status ? 'Response' : 'RequestBody']
      .find((candidate) => candidate && !validateSchemaName(candidate).error);
    name = base;
    for (let n = 2; Object.prototype.hasOwnProperty.call(existing, name); n += 1) name = `${base}${n}`;
  }

  const created = withSchema(api.spec, name, current.schema, { create: true });
  if (created.error) return answer(res, created);
  const result = withContentSchema(created.spec, operationRef, target, { schema: { $ref: componentRef(name) }, fieldId: null });
  if (result.error) return answer(res, result);
  return save(res, api, result.spec, { name });
});

// Rewrites what the dictionary wrote into the document with the dictionary's current version.
const refreshComponents = withApi(async (req, res, api) => {
  const dictionary = await loadDictionary(req.user.organizationId);
  const { spec, result } = refreshFromDictionary(api.spec, dictionary);
  return save(res, api, spec, { refresh: result });
}, { needsOperation: false });

module.exports = {
  validateSource,
  saveSource,
  updateOperationInfo,
  addParameter,
  updateParameter,
  removeParameter,
  setRequestBody,
  removeRequestBody,
  setResponse,
  removeResponse,
  updateContentSchema,
  moveContentToSchemas,
  refreshComponents,
};
