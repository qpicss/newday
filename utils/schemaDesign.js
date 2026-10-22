// The schema designer: checks and writes the components.schemas entries of an OpenAPI document,
// and finds what uses each of them. Every change function returns { spec } or { error, status }.
const { HTTP_METHODS } = require('./openapi');
const { isPlainObject, componentName, OBJECT_MARK } = require('./dictionary');
const { renameSchemaRefs, sameContent } = require('./openapiDesign');

const SCHEMA_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
const MAX_NODES = 20000;
const MAX_DEPTH = 64;
const MAX_SCHEMA_JSON = 512 * 1024;
const SUBSCHEMA_LISTS = ['allOf', 'oneOf', 'anyOf', 'prefixItems'];
const SUBSCHEMA_KEYS = ['items', 'not', 'additionalProperties', 'contains', 'if', 'then', 'else'];

const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = (error, status = 400) => ({ error, status });

const validateSchemaName = (value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  return SCHEMA_NAME.test(name)
    ? { name }
    : { error: 'Schema names use letters, digits, ".", "-" and "_" (max 100 characters), for example OrderLine' };
};

// The structure the gateway and every OpenAPI tool rely on: known types, objects where schemas go,
// properties as an object, required as a list of names. Returns the first problem with its path.
const checkSchemaShape = (schema) => {
  let nodes = 0;
  const refs = [];
  const visit = (node, path, depth) => {
    nodes += 1;
    if (nodes > MAX_NODES) return 'The schema is too large';
    if (depth > MAX_DEPTH) return `${path} is nested too deeply`;
    if (typeof node === 'boolean') return null;
    if (!isPlainObject(node)) return `${path} must be a schema object`;
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#/')) return `${path}.$ref must point inside the document, like #/components/schemas/Order`;
      if (node.$ref.startsWith('#/components/schemas/')) refs.push({ name: componentName(node.$ref), path });
    }
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || types.some((type) => !TYPES.has(type))) return `${path}.type must be string, number, integer, boolean, array or object`;
    }
    if (node.properties !== undefined) {
      if (!isPlainObject(node.properties)) return `${path}.properties must be an object of schemas`;
      for (const [key, value] of Object.entries(node.properties)) {
        if (!key) return `${path}.properties has an empty name`;
        const problem = visit(value, `${path}.${key}`, depth + 1);
        if (problem) return problem;
      }
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string'))) {
      return `${path}.required must be a list of property names`;
    }
    if (node.enum !== undefined && !Array.isArray(node.enum)) return `${path}.enum must be a list`;
    for (const key of SUBSCHEMA_LISTS) {
      if (node[key] === undefined) continue;
      if (!Array.isArray(node[key])) return `${path}.${key} must be a list of schemas`;
      for (const [index, item] of node[key].entries()) {
        const problem = visit(item, `${path}.${key}[${index}]`, depth + 1);
        if (problem) return problem;
      }
    }
    for (const key of SUBSCHEMA_KEYS) {
      if (node[key] === undefined) continue;
      const problem = visit(node[key], `${path}.${key}`, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  if (!isPlainObject(schema)) return { error: 'The schema must be a JSON object' };
  if (JSON.stringify(schema).length > MAX_SCHEMA_JSON) return { error: 'The schema is larger than 512 KB' };
  const problem = visit(schema, 'schema', 0);
  return problem ? { error: problem } : { refs };
};

// Where the document uses components.schemas[name]: operations (bodies, responses, parameters)
// and other schemas.
const schemaUsage = (spec, name) => {
  const target = `#/components/schemas/${name}`;
  const contains = (value, depth = 0) => {
    if (depth > MAX_DEPTH) return false;
    if (Array.isArray(value)) return value.some((item) => contains(item, depth + 1));
    if (!isPlainObject(value)) return false;
    if (value.$ref === target) return true;
    return Object.values(value).some((item) => contains(item, depth + 1));
  };
  const uses = [];
  for (const [path, item] of Object.entries(isPlainObject(spec?.paths) ? spec.paths : {})) {
    if (!isPlainObject(item)) continue;
    if (contains(item.parameters)) uses.push({ kind: 'operation', method: null, path, where: 'parameters of every operation' });
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isPlainObject(operation)) continue;
      const where = [];
      if (contains(operation.parameters)) where.push('parameters');
      if (contains(operation.requestBody)) where.push('request body');
      for (const [status, response] of Object.entries(isPlainObject(operation.responses) ? operation.responses : {})) {
        if (contains(response)) where.push(`${status} response`);
      }
      if (where.length) uses.push({ kind: 'operation', method, path, where: where.join(', ') });
    }
  }
  for (const [section, entries] of Object.entries(isPlainObject(spec?.components) ? spec.components : {})) {
    for (const [other, value] of Object.entries(isPlainObject(entries) ? entries : {})) {
      if (section === 'schemas' && other === name) continue;
      if (contains(value)) uses.push({ kind: section === 'schemas' ? 'schema' : 'component', section, name: other });
    }
  }
  return uses;
};

// Writes components.schemas[name] (renaming it, and every reference to it, to newName if given).
// An entry the dictionary wrote keeps its mark only while it still says the same thing.
const withSchema = (spec, name, schema, { create = false, newName = null } = {}) => {
  const copy = clone(spec);
  copy.components = isPlainObject(copy.components) ? copy.components : {};
  const schemas = isPlainObject(copy.components.schemas) ? { ...copy.components.schemas } : {};
  const exists = Object.prototype.hasOwnProperty.call(schemas, name);
  if (create && exists) return fail(`The document already has a schema named ${name}`, 409);
  if (!create && !exists) return fail('That schema does not exist', 404);

  let next = clone(schema);
  const previous = schemas[name];
  if (isPlainObject(next) && next[OBJECT_MARK] && !(isPlainObject(previous) && previous[OBJECT_MARK] === next[OBJECT_MARK] && sameContent(previous, next))) {
    delete next[OBJECT_MARK];
  }
  let result = copy;
  let finalName = name;
  if (newName && newName !== name) {
    if (Object.prototype.hasOwnProperty.call(schemas, newName)) return fail(`The document already has a schema named ${newName}`, 409);
    // The dictionary object keeps its name, so a renamed copy is the document's own.
    if (isPlainObject(next)) delete next[OBJECT_MARK];
    const renamed = {};
    for (const [key, value] of Object.entries(schemas)) renamed[key === name ? newName : key] = value;
    copy.components.schemas = renamed;
    result = renameSchemaRefs(copy, name, newName);
    // The schema itself may refer to its old name (a tree), so rename inside it too.
    next = renameSchemaRefs(next, name, newName);
    finalName = newName;
  } else {
    copy.components.schemas = schemas;
  }
  result.components.schemas[finalName] = next;
  return { spec: result, name: finalName };
};

const withoutSchema = (spec, name) => {
  const copy = clone(spec);
  if (!isPlainObject(copy.components?.schemas) || !Object.prototype.hasOwnProperty.call(copy.components.schemas, name)) {
    return fail('That schema does not exist', 404);
  }
  const uses = schemaUsage(copy, name);
  if (uses.length) {
    const first = uses.slice(0, 3).map((use) => (use.kind === 'operation' ? `${use.method ? use.method.toUpperCase() + ' ' : ''}${use.path}` : use.name)).join(', ');
    return { ...fail(`${name} is still used by ${first}${uses.length > 3 ? ` and ${uses.length - 3} more` : ''}. Remove those uses first.`, 409), uses };
  }
  delete copy.components.schemas[name];
  return { spec: copy };
};

// References to components.schemas that point at nothing.
const missingRefs = (spec, refs) => {
  const schemas = isPlainObject(spec?.components?.schemas) ? spec.components.schemas : {};
  return refs.filter((ref) => !Object.prototype.hasOwnProperty.call(schemas, ref.name));
};

module.exports = {
  validateSchemaName,
  checkSchemaShape,
  schemaUsage,
  withSchema,
  withoutSchema,
  missingRefs,
};
