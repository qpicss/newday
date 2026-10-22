// Edits of one operation of an OpenAPI document made by the API designer: its summary, parameters,
// request body and responses, plus the components.schemas entries written from the data dictionary.
// Every function takes the document and returns { spec } (a changed copy) or { error, status }.
const { HTTP_METHODS } = require('./openapi');
const {
  isPlainObject,
  describeSchema,
  componentName,
  OBJECT_MARK,
  FIELD_MARK,
  isOpenApi31,
  renderField,
} = require('./dictionary');
const { normalizeValue } = require('./dictionaryImport');

const PARAMETER_LOCATIONS = ['query', 'header', 'path', 'cookie'];
const STATUS = /^([1-5]\d\d|[1-5]XX|default)$/;
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+*-]+(\s*;\s*[A-Za-z0-9_.-]+=[A-Za-z0-9_."-]+)*$/;
const OPERATION_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const NO_BODY_METHODS = ['get', 'head'];

const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = (error, status = 400) => ({ error, status });

const pointerGet = (spec, ref) => {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let value = spec;
  for (const raw of ref.slice(2).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
};
const resolved = (spec, value) => (isPlainObject(value) && typeof value.$ref === 'string' ? pointerGet(spec, value.$ref) : value);

const pathParamNames = (path) => [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);

// Finds the operation in a copy of the document, ready to be changed.
const editable = (spec, { method, path }) => {
  const copy = clone(spec);
  const operation = copy.paths?.[path]?.[method];
  if (!HTTP_METHODS.includes(method) || !isPlainObject(operation)) return { error: 'That endpoint does not exist', status: 404 };
  return { copy, operation, item: copy.paths[path] };
};

const parameterKey = (param) => `${param.in}:${param.in === 'header' ? param.name.toLowerCase() : param.name}`;

// ------------------------------------------------------------------ Reading

const describeContent = (spec, content) => Object.entries(isPlainObject(content) ? content : {}).map(([type, media]) => {
  const schema = isPlainObject(media) ? media.schema : undefined;
  const ref = isPlainObject(schema) && schema.$ref ? componentName(schema.$ref)
    : isPlainObject(schema?.items) && schema.items.$ref ? componentName(schema.items.$ref) : null;
  return {
    type,
    schema: schema ? describeSchema(schema) : 'no schema',
    componentName: ref,
    isArray: Boolean(schema?.items),
    fieldId: isPlainObject(media) ? media[FIELD_MARK] || null : null,
  };
});

// The schema in the dictionary's form, when converting it back gives the same schema.
const formSchemaOf = (schema, openapi31) => {
  if (!isPlainObject(schema) || schema.$ref) return null;
  const { schema: normalized, error } = normalizeValue(schema, { openapi31 });
  if (error) return null;
  const { description, ...rest } = schema;
  return sameContent(renderField({ schema: normalized }, { openapi31, withDescription: false }), rest) ? normalized : null;
};

// What the designer shows for one operation.
const describeOperation = (spec, { method, path }) => {
  const item = spec?.paths?.[path];
  const operation = isPlainObject(item) ? item[method] : null;
  if (!isPlainObject(operation)) return null;

  const parameters = [];
  const seen = new Set();
  // Operation parameters override the path's own with the same location and name.
  for (const [level, list] of [['operation', operation.parameters], ['path', item.parameters]]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const param = resolved(spec, raw);
      if (!isPlainObject(param) || typeof param.name !== 'string' || typeof param.in !== 'string') continue;
      const key = parameterKey(param);
      if (seen.has(key)) continue;
      seen.add(key);
      const schema = isPlainObject(param.schema) ? param.schema : isPlainObject(param.content) ? Object.values(param.content)[0]?.schema : undefined;
      parameters.push({
        in: param.in,
        name: param.name,
        required: param.required === true,
        description: typeof param.description === 'string' ? param.description : '',
        schema: schema ? describeSchema(schema) : 'any value',
        level,
        shared: isPlainObject(raw) && typeof raw.$ref === 'string' ? raw.$ref.split('/').pop() : null,
        fieldId: param[FIELD_MARK] || null,
        deprecated: param.deprecated === true,
        // For the edit dialog: the schema as written, and in the field form's terms when that
        // describes it fully (otherwise it is edited as JSON).
        rawSchema: isPlainObject(schema) ? schema : {},
        formSchema: formSchemaOf(schema, isOpenApi31(spec)),
      });
    }
  }
  const order = { path: 0, query: 1, header: 2, cookie: 3 };
  parameters.sort((a, b) => (order[a.in] ?? 9) - (order[b.in] ?? 9));
  const declared = new Set(parameters.filter((param) => param.in === 'path').map((param) => param.name));
  const missingPathParams = pathParamNames(path).filter((name) => !declared.has(name));

  const requestBody = resolved(spec, operation.requestBody);
  const responses = Object.entries(isPlainObject(operation.responses) ? operation.responses : {})
    .map(([status, raw]) => {
      const response = resolved(spec, raw);
      return {
        status,
        description: typeof response?.description === 'string' ? response.description : '',
        shared: isPlainObject(raw) && typeof raw.$ref === 'string' ? raw.$ref.split('/').pop() : null,
        content: describeContent(spec, response?.content),
      };
    })
    .sort((a, b) => (a.status === 'default' ? 1 : b.status === 'default' ? -1 : a.status.localeCompare(b.status)));

  return {
    method,
    path,
    summary: typeof operation.summary === 'string' ? operation.summary : '',
    description: typeof operation.description === 'string' ? operation.description : '',
    operationId: typeof operation.operationId === 'string' ? operation.operationId : '',
    deprecated: operation.deprecated === true,
    parameters,
    missingPathParams,
    allowsBody: !NO_BODY_METHODS.includes(method),
    requestBody: isPlainObject(requestBody) ? {
      required: requestBody.required === true,
      description: typeof requestBody.description === 'string' ? requestBody.description : '',
      shared: isPlainObject(operation.requestBody) && typeof operation.requestBody.$ref === 'string' ? operation.requestBody.$ref.split('/').pop() : null,
      content: describeContent(spec, requestBody.content),
    } : null,
    responses,
  };
};

// The document's components.schemas, with whether each came from the dictionary.
const describeComponents = (spec) => Object.entries(isPlainObject(spec?.components?.schemas) ? spec.components.schemas : {})
  .map(([name, schema]) => ({
    name,
    schema: describeSchema(schema),
    dictionaryId: isPlainObject(schema) ? schema[OBJECT_MARK] || null : null,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// ------------------------------------------------------------------ Validation of designer input

const validateOperationInfo = (body = {}, spec, { method, path }) => {
  const info = {};
  for (const [key, max] of [['summary', 255], ['description', 5000]]) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== 'string') return fail(`The ${key} must be text`);
    const value = (body[key] || '').trim();
    if (value.length > max) return fail(`The ${key} is at most ${max} characters`);
    info[key] = value;
  }
  if (body.operationId !== undefined) {
    const value = typeof body.operationId === 'string' ? body.operationId.trim() : '';
    if (value && !OPERATION_ID.test(value)) return fail('Operation IDs use letters, digits, ".", "-" and "_" (max 100 characters), for example getOrder');
    if (value) {
      for (const [otherPath, item] of Object.entries(spec.paths || {})) {
        for (const otherMethod of HTTP_METHODS) {
          if (otherPath === path && otherMethod === method) continue;
          if (item?.[otherMethod]?.operationId === value) return fail(`${otherMethod.toUpperCase()} ${otherPath} already uses the operation ID ${value}`, 409);
        }
      }
    }
    info.operationId = value;
  }
  if (body.deprecated !== undefined) info.deprecated = body.deprecated === true;
  return { info };
};

const validateStatus = (value) => {
  const status = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().toUpperCase().replace('DEFAULT', 'default') : '';
  return STATUS.test(status) ? { status } : fail('Status codes are 100 to 599, a range such as 4XX, or "default"');
};

const validateContentType = (value) => {
  const type = typeof value === 'string' ? value.trim() : '';
  return type && type.length <= 100 && CONTENT_TYPE.test(type) ? { type } : fail('Content types look like application/json');
};

// ------------------------------------------------------------------ Changes

const withOperationInfo = (spec, operationRef, info) => {
  const { copy, operation, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  for (const [key, value] of Object.entries(info)) {
    if (value === '' || value === false) delete operation[key];
    else operation[key] = value;
  }
  return { spec: copy };
};

// parameter: { in, name, required, description, schema, fieldId? }. Replaces one with the same
// location and name on the operation; one defined for the whole path is overridden for this operation.
const withParameter = (spec, operationRef, parameter) => {
  const { copy, operation, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  if (!PARAMETER_LOCATIONS.includes(parameter.in)) return fail('Choose where the parameter goes: query, header, path or cookie');
  if (parameter.in === 'path' && !pathParamNames(operationRef.path).includes(parameter.name)) {
    return fail(`Path parameters must appear in the path as {${parameter.name}}. ${operationRef.path} has ${pathParamNames(operationRef.path).map((name) => `{${name}}`).join(', ') || 'none'}.`);
  }
  if (parameter.in === 'header' && ['accept', 'content-type', 'authorization'].includes(parameter.name.toLowerCase())) {
    return fail(`OpenAPI ignores a ${parameter.name} header parameter: describe it with the request body, responses or security schemes instead`);
  }
  const entry = {
    name: parameter.name,
    in: parameter.in,
    ...(parameter.description && { description: parameter.description }),
    ...((parameter.required || parameter.in === 'path') && { required: true }),
    schema: parameter.schema,
    ...(parameter.fieldId && { [FIELD_MARK]: parameter.fieldId }),
  };
  const key = parameterKey(entry);
  const list = Array.isArray(operation.parameters) ? operation.parameters : [];
  const index = list.findIndex((raw) => {
    const param = resolved(copy, raw);
    return isPlainObject(param) && typeof param.name === 'string' && parameterKey(param) === key;
  });
  if (index >= 0) list[index] = entry;
  else list.push(entry);
  operation.parameters = list;
  return { spec: copy, replaced: index >= 0 };
};

// Changes a parameter in place: on the operation, on the path (every operation there) or, for a
// $ref, the shared components.parameters entry. changes: { required, description, deprecated,
// schema, fieldId } (fieldId: the dictionary field it still matches, or null to unlink it).
const withParameterChanges = (spec, operationRef, { in: location, name }, changes) => {
  const { copy, operation, item, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  const key = parameterKey({ in: location, name: String(name) });
  let target = null;
  let scope = null;
  for (const [level, list] of [['operation', operation.parameters], ['path', item.parameters]]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const param = resolved(copy, raw);
      if (!isPlainObject(param) || typeof param.name !== 'string' || parameterKey(param) !== key) continue;
      target = param;
      scope = isPlainObject(raw) && typeof raw.$ref === 'string' ? 'shared' : level;
      break;
    }
    if (target) break;
  }
  if (!target) return fail('That parameter does not exist', 404);

  if (changes.description !== undefined) {
    if (changes.description) target.description = changes.description;
    else delete target.description;
  }
  if (changes.required !== undefined || target.in === 'path') {
    if (changes.required || target.in === 'path') target.required = true;
    else delete target.required;
  }
  if (changes.deprecated !== undefined) {
    if (changes.deprecated) target.deprecated = true;
    else delete target.deprecated;
  }
  if (changes.schema) {
    if (isPlainObject(target.content) && !target.schema) {
      const [type] = Object.keys(target.content);
      target.content[type] = { ...target.content[type], schema: changes.schema };
    } else {
      target.schema = changes.schema;
    }
  }
  if (changes.fieldId) target[FIELD_MARK] = changes.fieldId;
  else if (changes.fieldId === null) delete target[FIELD_MARK];
  return { spec: copy, scope };
};

const withoutParameter = (spec, operationRef, { in: location, name }) => {
  const { copy, operation, item, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  const key = parameterKey({ in: location, name: String(name) });
  const matches = (raw) => {
    const param = resolved(copy, raw);
    return isPlainObject(param) && typeof param.name === 'string' && parameterKey(param) === key;
  };
  const list = Array.isArray(operation.parameters) ? operation.parameters : [];
  if (list.some(matches)) {
    operation.parameters = list.filter((raw) => !matches(raw));
    if (!operation.parameters.length) delete operation.parameters;
    return { spec: copy };
  }
  if (Array.isArray(item.parameters) && item.parameters.some(matches)) {
    return fail(`${name} is defined for every operation on ${operationRef.path}. Remove it in the source editor.`, 409);
  }
  return fail('That parameter does not exist', 404);
};

// body: { contentType, schema, fieldId?, required, description }. Sets that content type and keeps the others.
const withRequestBody = (spec, operationRef, body) => {
  const { copy, operation, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  if (NO_BODY_METHODS.includes(operationRef.method)) return fail(`${operationRef.method.toUpperCase()} requests have no body`);
  const current = isPlainObject(operation.requestBody) && !operation.requestBody.$ref ? operation.requestBody : {};
  const content = isPlainObject(current.content) ? current.content : {};
  content[body.contentType] = { schema: body.schema, ...(body.fieldId && { [FIELD_MARK]: body.fieldId }) };
  operation.requestBody = {
    ...(body.description ? { description: body.description } : current.description ? { description: current.description } : {}),
    content,
    ...(body.required && { required: true }),
  };
  if (body.description === '') delete operation.requestBody.description;
  return { spec: copy };
};

const withoutRequestBody = (spec, operationRef, { contentType } = {}) => {
  const { copy, operation, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  if (!operation.requestBody) return fail('This endpoint has no request body', 404);
  if (contentType && isPlainObject(operation.requestBody.content) && !operation.requestBody.$ref) {
    if (!operation.requestBody.content[contentType]) return fail(`The request body has no ${contentType} content`, 404);
    delete operation.requestBody.content[contentType];
    if (Object.keys(operation.requestBody.content).length) return { spec: copy };
  }
  delete operation.requestBody;
  return { spec: copy };
};

// response: { status, description, contentType?, schema?, fieldId? }. Without a schema the response
// has no body; with one, that content type is set and the others are kept.
const withResponse = (spec, operationRef, response) => {
  const { copy, operation, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  const responses = isPlainObject(operation.responses) ? operation.responses : {};
  const current = isPlainObject(responses[response.status]) && !responses[response.status].$ref ? responses[response.status] : {};
  const entry = { ...current, description: response.description || current.description || 'Response' };
  if (response.schema) {
    entry.content = isPlainObject(current.content) ? current.content : {};
    entry.content[response.contentType] = { schema: response.schema, ...(response.fieldId && { [FIELD_MARK]: response.fieldId }) };
  } else if (response.contentType && isPlainObject(entry.content)) {
    delete entry.content[response.contentType];
    if (!Object.keys(entry.content).length) delete entry.content;
  }
  responses[response.status] = entry;
  operation.responses = responses;
  return { spec: copy };
};

const withoutResponse = (spec, operationRef, statusCode) => {
  const { copy, operation, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  if (!isPlainObject(operation.responses) || !operation.responses[statusCode]) return fail('That response does not exist', 404);
  if (Object.keys(operation.responses).length === 1) return fail('Every endpoint keeps at least one response. Add another before removing this one.', 409);
  delete operation.responses[statusCode];
  return { spec: copy };
};

// One content entry of the request body (status: null) or of a response, written in the operation
// itself (not a shared components.requestBodies/responses entry, which the source editor changes).
const contentIn = (operation, { status, contentType }) => {
  const holder = status === null ? operation.requestBody : isPlainObject(operation.responses) ? operation.responses[status] : undefined;
  const where = status === null ? 'The request body' : `The ${status} response`;
  if (!isPlainObject(holder)) return fail(status === null ? 'This endpoint has no request body' : 'That response does not exist', 404);
  if (holder.$ref) return fail(`${where} is shared (${holder.$ref}). Change it in the source.`, 409);
  const media = isPlainObject(holder.content) ? holder.content[contentType] : undefined;
  if (!isPlainObject(media)) return fail(`${where} has no ${contentType} content`, 404);
  return { media };
};

const contentAt = (spec, { method, path }, target) => {
  const operation = spec?.paths?.[path]?.[method];
  if (!isPlainObject(operation)) return fail('That endpoint does not exist', 404);
  const found = contentIn(operation, target);
  if (found.error) return found;
  return { schema: isPlainObject(found.media.schema) ? found.media.schema : {}, fieldId: found.media[FIELD_MARK] || null };
};

// Replaces that entry's schema; fieldId keeps (or drops, when null) the dictionary field mark.
const withContentSchema = (spec, operationRef, target, { schema, fieldId }) => {
  const { copy, operation, error, status } = editable(spec, operationRef);
  if (error) return { error, status };
  const found = contentIn(operation, target);
  if (found.error) return found;
  found.media.schema = schema;
  if (fieldId) found.media[FIELD_MARK] = fieldId;
  else delete found.media[FIELD_MARK];
  return { spec: copy };
};

// The schema's content without the dictionary mark, with keys sorted, for comparison.
const contentOf = (value) => {
  if (Array.isArray(value)) return value.map(contentOf);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).filter((key) => key !== OBJECT_MARK).sort().map((key) => [key, contentOf(value[key])]));
};
const sameContent = (a, b) => JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));

// Writes dictionary objects into components.schemas. A schema of the same name that the dictionary
// didn't write (or wrote from another object) is only replaced with replace: true, unless it says
// the same thing (as after importing the document into the dictionary): then it is simply taken over.
const withComponentSchemas = (spec, schemas, { replace = false } = {}) => {
  const copy = clone(spec);
  const existing = isPlainObject(copy.components?.schemas) ? copy.components.schemas : {};
  const conflicts = Object.entries(schemas)
    .filter(([name, schema]) => isPlainObject(existing[name]) && existing[name][OBJECT_MARK] !== schema[OBJECT_MARK]
      && !sameContent(existing[name], schema))
    .map(([name]) => name);
  if (conflicts.length && !replace) {
    return {
      error: `The document already has ${conflicts.length === 1 ? 'a schema' : 'schemas'} named ${conflicts.join(', ')} that ${conflicts.length === 1 ? "isn't" : "aren't"} from this dictionary object. Replace ${conflicts.length === 1 ? 'it' : 'them'} with the dictionary version?`,
      status: 409,
      conflicts,
    };
  }
  copy.components = isPlainObject(copy.components) ? copy.components : {};
  copy.components.schemas = { ...existing, ...schemas };
  return { spec: copy };
};

// Every $ref to components/schemas/<from> pointed at <to> instead.
const renameSchemaRefs = (value, from, to) => {
  const fromRef = `#/components/schemas/${from}`;
  const toRef = `#/components/schemas/${to}`;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const result = {};
    for (const [key, item] of Object.entries(node)) result[key] = key === '$ref' && item === fromRef ? toRef : walk(item);
    return result;
  };
  return walk(value);
};

module.exports = {
  PARAMETER_LOCATIONS,
  pathParamNames,
  describeOperation,
  describeComponents,
  validateOperationInfo,
  validateStatus,
  validateContentType,
  withOperationInfo,
  withParameter,
  withParameterChanges,
  withoutParameter,
  withRequestBody,
  withoutRequestBody,
  withResponse,
  withoutResponse,
  contentAt,
  withContentSchema,
  withComponentSchemas,
  renameSchemaRefs,
  sameContent,
};
