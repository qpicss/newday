// The data dictionary: reusable fields (the schema of one value) and objects (named sets of
// properties, each a field or another object), and how they become OpenAPI schemas.
//
// Field schemas are kept in one form, OpenAPI 3.0 style (`nullable: true`, boolean
// `exclusiveMinimum` next to `minimum`), and rendered for the document they go into: a 3.1 document
// gets `type: [x, 'null']` and numeric exclusive bounds instead.
const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'];
const ITEM_TYPES = ['string', 'number', 'integer', 'boolean'];
// Field names are also used as parameter and property names: no spaces, quotes, slashes or braces.
const FIELD_NAME = /^[A-Za-z0-9_$@][A-Za-z0-9_.$@:-]{0,99}$/;
// Object names become components.schemas keys, which OpenAPI limits to these characters.
const OBJECT_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,99}$/;
const FORMAT = /^[A-Za-z0-9_.-]{1,50}$/;
const MAX_ENUM = 200;
const MAX_PROPERTIES = 200;
const MAX_VALUE_JSON = 2000;
const COMPONENT_PREFIX = '#/components/schemas/';
// Marks what the dictionary wrote into a document, so it can be recognised and updated later.
const OBJECT_MARK = 'x-dictionary-id';
const FIELD_MARK = 'x-dictionary-field';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isEmpty = (value) => value === undefined || value === null || value === '';

const COMMON_KEYS = ['enum', 'default', 'example', 'nullable', 'readOnly', 'writeOnly', 'deprecated'];
const TYPE_KEYS = {
  string: ['format', 'pattern', 'minLength', 'maxLength'],
  number: ['format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  integer: ['format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  boolean: [],
  array: ['items', 'minItems', 'maxItems', 'uniqueItems'],
  object: ['additionalProperties', 'properties', 'required', 'minProperties', 'maxProperties'],
};
const ITEM_KEYS = ['enum', 'nullable'];
// Output order, so rendered schemas read the same way every time.
const KEY_ORDER = ['type', 'format', 'description', 'properties', 'required', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'exclusiveMinimum',
  'maximum', 'exclusiveMaximum', 'multipleOf', 'items', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties',
  'minProperties', 'maxProperties',
  'nullable', 'readOnly', 'writeOnly', 'deprecated', 'default', 'example'];

const ordered = (schema) => {
  const result = {};
  for (const key of KEY_ORDER) if (schema[key] !== undefined) result[key] = schema[key];
  for (const [key, value] of Object.entries(schema)) if (result[key] === undefined) result[key] = value;
  return result;
};

const valueMatches = (value, type) => {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return isNumber(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    default: return false;
  }
};

const validateName = (value, kind = 'field') => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (kind === 'object') {
    if (!OBJECT_NAME.test(name)) {
      return { error: 'Object names start with a letter and use only letters, digits, ".", "-" and "_" (max 100 characters), for example CustomerAddress' };
    }
  } else if (!FIELD_NAME.test(name)) {
    return { error: 'Field names use letters, digits and _ . - $ @ : with no spaces (max 100 characters), for example customerId or X-Request-Id' };
  }
  return { name };
};

// Checks a field schema and returns it in the dictionary's form, with false and empty values left out.
const validateFieldSchema = (input, { item = false } = {}) => {
  const prefix = item ? 'List items: ' : '';
  const fail = (message) => ({ error: `${prefix}${message}` });
  if (!isPlainObject(input)) return fail('Describe the value with a schema object');
  const types = item ? ITEM_TYPES : FIELD_TYPES;
  const { type } = input;
  if (!types.includes(type)) return fail(`Choose a type: ${types.join(', ')}`);

  const allowed = new Set(['type', ...(item ? ITEM_KEYS : COMMON_KEYS), ...(item ? TYPE_KEYS[type].filter((key) => key !== 'items') : TYPE_KEYS[type])]);
  if (['boolean', 'array', 'object'].includes(type)) allowed.delete('enum');
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key) || isEmpty(value) || value === false) continue;
    return fail(`"${key}" doesn't apply to ${type} values`);
  }

  const schema = { type };
  const flag = (key) => {
    if (isEmpty(input[key]) || input[key] === false) return null;
    if (input[key] !== true) return `"${key}" must be true or false`;
    schema[key] = true;
    return null;
  };
  const count = (key) => {
    if (isEmpty(input[key])) return null;
    if (!isCount(input[key])) return `"${key}" must be a whole number of 0 or more`;
    schema[key] = input[key];
    return null;
  };
  const number = (key) => {
    if (isEmpty(input[key])) return null;
    if (!isNumber(input[key])) return `"${key}" must be a number`;
    schema[key] = input[key];
    return null;
  };

  const checks = [];
  if (allowed.has('format') && !isEmpty(input.format)) {
    if (typeof input.format !== 'string' || !FORMAT.test(input.format)) return fail('Formats are short names such as email, uuid, date-time or int64');
    schema.format = input.format;
  }
  if (type === 'string') {
    if (!isEmpty(input.pattern)) {
      if (typeof input.pattern !== 'string' || input.pattern.length > 500) return fail('Patterns are at most 500 characters');
      try {
        new RegExp(input.pattern, 'u'); // eslint-disable-line no-new
      } catch {
        return fail("The pattern isn't a valid regular expression");
      }
      schema.pattern = input.pattern;
    }
    checks.push(count('minLength'), count('maxLength'));
  }
  if (type === 'number' || type === 'integer') {
    checks.push(number('minimum'), number('maximum'), number('multipleOf'), flag('exclusiveMinimum'), flag('exclusiveMaximum'));
  }
  if (type === 'array') {
    if (!item) {
      const items = validateFieldSchema(input.items, { item: true });
      if (items.error) return { error: input.items ? items.error : 'Lists need the type of their items' };
      schema.items = items.schema;
    }
    checks.push(count('minItems'), count('maxItems'), flag('uniqueItems'));
  }
  if (type === 'object' && !isEmpty(input.additionalProperties)) {
    if (typeof input.additionalProperties !== 'boolean') return fail('"additionalProperties" must be true or false');
    schema.additionalProperties = input.additionalProperties;
  }
  if (type === 'object') {
    const structure = checkStructure(input);
    if (structure.error) return fail(structure.error);
    Object.assign(schema, structure.values);
    checks.push(count('minProperties'), count('maxProperties'));
  }
  for (const key of ['nullable', ...(item ? [] : ['readOnly', 'writeOnly', 'deprecated'])]) checks.push(flag(key));
  const firstError = checks.find(Boolean);
  if (firstError) return fail(firstError);

  if (allowed.has('enum') && !isEmpty(input.enum)) {
    const values = input.enum;
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ENUM) return fail(`Allowed values are a list of 1 to ${MAX_ENUM} values`);
    for (const value of values) {
      if (!valueMatches(value, type)) return fail(`Every allowed value must be ${type === 'string' ? 'text' : `a ${type}`}`);
      if (typeof value === 'string' && value.length > 500) return fail('Allowed values are at most 500 characters');
    }
    if (new Set(values.map((value) => JSON.stringify(value))).size !== values.length) return fail('Allowed values must be different from each other');
    schema.enum = values;
  }
  if (!item) {
    for (const key of ['default', 'example']) {
      if (input[key] === undefined || input[key] === '') continue;
      if (input[key] === null && !schema.nullable) return fail(`The ${key === 'default' ? 'default' : 'example'} can only be empty (null) when the value may be null`);
      if (input[key] !== null && !valueMatches(input[key], type)) return fail(`The ${key === 'default' ? 'default' : 'example'} must be ${type === 'string' ? 'text' : `a ${type}`}`);
      if (JSON.stringify(input[key]).length > MAX_VALUE_JSON) return fail(`The ${key === 'default' ? 'default' : 'example'} is too long`);
      schema[key] = input[key];
    }
    if (schema.default !== undefined && schema.default !== null && schema.enum && !schema.enum.some((value) => JSON.stringify(value) === JSON.stringify(schema.default))) {
      return fail('The default must be one of the allowed values');
    }
  }

  const pairs = [['minLength', 'maxLength', 'Minimum length'], ['minimum', 'maximum', 'Minimum'], ['minItems', 'maxItems', 'Minimum number of items']];
  for (const [low, high, label] of pairs) {
    if (schema[low] !== undefined && schema[high] !== undefined && schema[low] > schema[high]) return fail(`${label} can't be above the maximum`);
  }
  if (schema.multipleOf !== undefined && schema.multipleOf <= 0) return fail('"multipleOf" must be above 0');
  if (schema.exclusiveMinimum && schema.minimum === undefined) return fail('An exclusive minimum needs a minimum');
  if (schema.exclusiveMaximum && schema.maximum === undefined) return fail('An exclusive maximum needs a maximum');
  if (schema.readOnly && schema.writeOnly) return fail("A value can't be both read-only and write-only");
  return { schema: ordered(schema) };
};

// The named properties an object field may describe (its structure). Nested schemas are free-form
// JSON schemas, but self-contained: a field belongs to no document, so it can't use $ref.
const MAX_STRUCTURE_NODES = 5000;
const MAX_STRUCTURE_JSON = 200 * 1024;
const STRUCTURE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
const checkStructure = (input) => {
  const values = {};
  if (isEmpty(input.properties) && isEmpty(input.required)) return { values };
  if (!isPlainObject(input.properties)) return { error: '"properties" must be an object of property schemas' };
  if (Object.keys(input.properties).length > MAX_PROPERTIES) return { error: `Objects have at most ${MAX_PROPERTIES} properties` };
  if (JSON.stringify(input.properties).length > MAX_STRUCTURE_JSON) return { error: 'The structure is larger than 200 KB' };
  let nodes = 0;
  const visit = (node, path, depth) => {
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES || depth > 32) return `${path} is nested too deeply`;
    if (typeof node === 'boolean') return null;
    if (!isPlainObject(node)) return `${path} must be a schema object`;
    if (node.$ref !== undefined) return `${path} uses $ref: a dictionary field has no document to point into. Use an object of the dictionary instead.`;
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || types.some((type) => !STRUCTURE_TYPES.has(type))) return `${path}: type must be string, number, integer, boolean, array or object`;
    }
    if (node.properties !== undefined) {
      if (!isPlainObject(node.properties)) return `${path}: properties must be an object`;
      for (const [key, value] of Object.entries(node.properties)) {
        const problem = visit(value, `${path}.${key}`, depth + 1);
        if (problem) return problem;
      }
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string'))) {
      return `${path}: required must be a list of property names`;
    }
    if (node.enum !== undefined && !Array.isArray(node.enum)) return `${path}: enum must be a list`;
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
      if (node[key] === undefined) continue;
      if (!Array.isArray(node[key])) return `${path}: ${key} must be a list of schemas`;
      for (const [index, item] of node[key].entries()) {
        const problem = visit(item, `${path}.${key}[${index}]`, depth + 1);
        if (problem) return problem;
      }
    }
    for (const key of ['items', 'not', 'additionalProperties']) {
      if (node[key] === undefined) continue;
      const problem = visit(node[key], `${path}.${key}`, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  for (const [key, value] of Object.entries(input.properties)) {
    if (!key) return { error: 'A property has an empty name' };
    const problem = visit(value, key, 1);
    if (problem) return { error: problem };
  }
  values.properties = input.properties;
  if (!isEmpty(input.required)) {
    if (!Array.isArray(input.required) || input.required.some((name) => typeof name !== 'string')) return { error: '"required" must be a list of property names' };
    const unknown = input.required.find((name) => !(name in input.properties));
    if (unknown) return { error: `${unknown} is required but isn't a property` };
    if (input.required.length) values.required = [...new Set(input.required)];
  }
  return { values };
};

const optionalDescription = (value) => {
  if (isEmpty(value)) return { value: null };
  if (typeof value !== 'string' || value.length > 5000) return { error: 'Descriptions are at most 5000 characters' };
  return { value: value.trim() || null };
};

const isOpenApi31 = (spec) => typeof spec?.openapi === 'string' && /^3\.(1|[2-9])/.test(spec.openapi);
const componentRef = (name) => `${COMPONENT_PREFIX}${String(name).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const componentName = (ref) => (typeof ref === 'string' && ref.startsWith(COMPONENT_PREFIX)
  ? ref.slice(COMPONENT_PREFIX.length).replace(/~1/g, '/').replace(/~0/g, '~')
  : null);

// The field's schema as it goes into a document of that OpenAPI version.
const forVersion = (canonical, openapi31) => {
  const schema = JSON.parse(JSON.stringify(canonical));
  if (!isPlainObject(schema)) return schema;
  if (isPlainObject(schema.items)) schema.items = forVersion(schema.items, openapi31);
  // An object field's structure is written the same way, all the way down.
  if (isPlainObject(schema.properties)) {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, forVersion(value, openapi31)]));
  }
  for (const key of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(schema[key])) schema[key] = schema[key].map((value) => forVersion(value, openapi31));
  if (!openapi31) return schema;
  if (schema.nullable) {
    schema.type = [schema.type, 'null'];
    if (schema.enum && !schema.enum.includes(null)) schema.enum = [...schema.enum, null];
    delete schema.nullable;
  }
  for (const [flagKey, boundKey] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    if (schema[flagKey] === true) {
      schema[flagKey] = schema[boundKey];
      delete schema[boundKey];
    }
  }
  return schema;
};

const renderField = (field, { openapi31 = false, withDescription = true } = {}) => {
  const schema = forVersion(field.schema, openapi31);
  if (withDescription && field.description) schema.description = field.description;
  return ordered(schema);
};

// dictionary: { fields: Map(id -> field), objects: Map(id -> object with sorted properties) }
const propertySchema = (property, dictionary, options) => {
  let schema;
  if (property.fieldId) {
    const field = dictionary.fields.get(property.fieldId);
    if (!field) return null;
    schema = renderField(field, options);
  } else {
    const target = dictionary.objects.get(property.refObjectId);
    if (!target) return null;
    schema = { $ref: componentRef(target.name) };
  }
  return property.isArray ? { type: 'array', items: schema } : schema;
};

const renderObject = (object, dictionary, options = {}) => {
  const properties = {};
  const required = [];
  for (const property of object.properties || []) {
    const schema = propertySchema(property, dictionary, options);
    if (!schema) continue;
    properties[property.name] = schema;
    if (property.required) required.push(property.name);
  }
  return {
    type: 'object',
    ...(object.description && { description: object.description }),
    properties,
    ...(required.length && { required }),
    ...(object.additionalProperties === false && { additionalProperties: false }),
    [OBJECT_MARK]: object.id,
  };
};

// The object and every object it uses, directly or through others (each once, the object first).
const objectClosure = (rootIds, dictionary) => {
  const seen = new Set();
  const queue = [...rootIds];
  const result = [];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const object = dictionary.objects.get(id);
    if (!object) continue;
    result.push(object);
    for (const property of object.properties || []) if (property.refObjectId) queue.push(property.refObjectId);
  }
  return result;
};

// components.schemas entries for these objects and everything they use.
const renderComponents = (rootIds, dictionary, options = {}) => {
  const schemas = {};
  for (const object of objectClosure(rootIds, dictionary)) schemas[object.name] = renderObject(object, dictionary, options);
  return schemas;
};

// Short text for a schema, for lists: "string · email", "list of Address", "object · 3 properties".
const describeSchema = (schema, depth = 0) => {
  if (!isPlainObject(schema) || depth > 4) return 'any value';
  if (schema.$ref) return componentName(schema.$ref) || schema.$ref.split('/').pop();
  const types = Array.isArray(schema.type) ? schema.type.filter((type) => type !== 'null') : [schema.type].filter(Boolean);
  const type = types[0] || (schema.properties ? 'object' : schema.items ? 'array' : null);
  if (schema.oneOf || schema.anyOf) return `one of ${(schema.oneOf || schema.anyOf).length} schemas`;
  if (schema.allOf) return `combination of ${schema.allOf.length} schemas`;
  if (!type) return 'any value';
  if (type === 'array') return `list of ${describeSchema(schema.items, depth + 1)}`;
  if (type === 'object') {
    const count = Object.keys(schema.properties || {}).length;
    return count ? `object · ${count} propert${count === 1 ? 'y' : 'ies'}` : 'object';
  }
  return [type, schema.format, schema.enum && `${schema.enum.filter((value) => value !== null).length} values`].filter(Boolean).join(' · ');
};

// Keeps the property list valid: names unique, each pointing at exactly one existing field or object.
const validateProperties = (input, { fieldIds, objectIds }) => {
  if (input === undefined) return { properties: undefined };
  if (!Array.isArray(input)) return { error: 'Properties must be a list' };
  if (input.length > MAX_PROPERTIES) return { error: `Objects have at most ${MAX_PROPERTIES} properties` };
  const names = new Set();
  const properties = [];
  for (const [position, raw] of input.entries()) {
    if (!isPlainObject(raw)) return { error: 'Each property needs a name and a field or object' };
    const { name, error } = validateName(raw.name, 'field');
    if (error) return { error: `Property ${position + 1}: ${error}` };
    if (names.has(name)) return { error: `There are two properties named ${name}` };
    names.add(name);
    const fieldId = isEmpty(raw.fieldId) ? null : raw.fieldId;
    const refObjectId = isEmpty(raw.objectId) ? null : raw.objectId;
    if (Boolean(fieldId) === Boolean(refObjectId)) return { error: `Property ${name} needs either a field or an object` };
    if (fieldId && !fieldIds.has(fieldId)) return { error: `The field of property ${name} isn't in your dictionary` };
    if (refObjectId && !objectIds.has(refObjectId)) return { error: `The object of property ${name} isn't in your dictionary` };
    properties.push({ name, fieldId, refObjectId, isArray: raw.isArray === true, required: raw.required === true, position });
  }
  return { properties };
};

module.exports = {
  FIELD_TYPES,
  ITEM_TYPES,
  MAX_PROPERTIES,
  OBJECT_MARK,
  FIELD_MARK,
  isPlainObject,
  validateName,
  validateFieldSchema,
  validateProperties,
  optionalDescription,
  isOpenApi31,
  componentRef,
  componentName,
  renderField,
  renderObject,
  renderComponents,
  objectClosure,
  describeSchema,
};
