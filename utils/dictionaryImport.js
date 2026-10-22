// Reads an OpenAPI document into data dictionary entries (planImport), without touching the database:
//   - components.schemas: object schemas become objects, single values (an enum, a date...) fields;
//   - object properties: single values become fields, nested objects become objects of their own;
//   - header, query, path and cookie parameters become fields;
//   - inline request and success response bodies become <Operation>Request / <Operation>Response objects.
// Names are unique ignoring case. When two values share a name but not a schema, the later one is
// named after where it was found (Order.id), so rendering an object gives back the same schema.
const { HTTP_METHODS } = require('./openapi');
const {
  isPlainObject,
  isOpenApi31,
  componentName,
  validateFieldSchema,
  MAX_PROPERTIES,
} = require('./dictionary');

const MAX_FIELDS = 2000;
const MAX_OBJECTS = 500;
const MAX_DEPTH = 12;
const MAX_NOTES = 50;
const SAFE_OBJECT_CHARS = /[^A-Za-z0-9._-]/g;
const SAFE_FIELD_CHARS = /[^A-Za-z0-9_.$@:-]/g;

const pascal = (text) => String(text)
  .replace(/\{([^}]*)\}/g, ' by $1 ')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((word) => word[0].toUpperCase() + word.slice(1))
  .join('');

const objectNameOf = (text) => {
  const name = String(text).replace(SAFE_OBJECT_CHARS, '').replace(/^[^A-Za-z_]+/, '').slice(0, 100);
  return name || 'Object';
};
const fieldNameOf = (text) => String(text).replace(SAFE_FIELD_CHARS, '_').replace(/^[^A-Za-z0-9_$@]+/, '').slice(0, 100) || 'value';

const typesOf = (schema) => (Array.isArray(schema?.type) ? schema.type : schema?.type ? [schema.type] : []);
const isObjectLike = (schema) => isPlainObject(schema) && (
  isPlainObject(schema.properties) || Array.isArray(schema.allOf) || (typesOf(schema).includes('object') && isPlainObject(schema.properties))
);
const isArraySchema = (schema) => isPlainObject(schema) && (typesOf(schema).includes('array') || (schema.items && !schema.type));

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One value's schema in the dictionary's form (3.0 style), or { error } when it can't be one.
const normalizeValue = (raw, { item = false, openapi31 = false } = {}) => {
  if (!isPlainObject(raw)) return { error: 'has no schema' };
  if (raw.oneOf || raw.anyOf || raw.not) return { error: 'combines several schemas (oneOf/anyOf), which the dictionary does not describe' };
  let types = typesOf(raw);
  let nullable = raw.nullable === true || types.includes('null');
  types = types.filter((type) => type !== 'null');
  if (types.length > 1) return { error: 'allows several types' };
  let [type] = types;
  let enumValues = Array.isArray(raw.enum) ? raw.enum : raw.const !== undefined ? [raw.const] : undefined;
  if (enumValues && enumValues.includes(null)) {
    nullable = true;
    enumValues = enumValues.filter((value) => value !== null);
  }
  if (!type) {
    const sample = enumValues?.[0];
    if (typeof sample === 'string') type = 'string';
    else if (typeof sample === 'number') type = enumValues.every(Number.isInteger) ? 'integer' : 'number';
    else if (typeof sample === 'boolean') type = 'boolean';
    else if (raw.format || raw.pattern || raw.minLength !== undefined || raw.maxLength !== undefined) type = 'string';
    else if (raw.minimum !== undefined || raw.maximum !== undefined) type = 'number';
    else if (raw.items) type = 'array';
    else return { error: 'has no type' };
  }
  if (item && !['string', 'number', 'integer', 'boolean'].includes(type)) return { error: 'is a list of lists or objects' };

  const schema = { type };
  const copy = (key, test) => {
    if (raw[key] !== undefined && test(raw[key])) schema[key] = raw[key];
  };
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  const isCount = (value) => Number.isInteger(value) && value >= 0;
  copy('format', (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,50}$/.test(value) && type !== 'boolean' && type !== 'array' && type !== 'object');
  if (enumValues && ['string', 'number', 'integer'].includes(type) && enumValues.length) {
    const unique = [...new Map(enumValues.map((value) => [JSON.stringify(value), value])).values()];
    schema.enum = unique.slice(0, 200);
  }
  if (nullable) schema.nullable = true;
  if (type === 'string') {
    copy('pattern', (value) => typeof value === 'string');
    copy('minLength', isCount);
    copy('maxLength', isCount);
  }
  if (type === 'number' || type === 'integer') {
    copy('minimum', isNum);
    copy('maximum', isNum);
    copy('multipleOf', (value) => isNum(value) && value > 0);
    for (const [flagKey, boundKey] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
      const value = raw[flagKey];
      if (value === true && isNum(raw[boundKey])) schema[flagKey] = true;
      else if (isNum(value)) {
        // 3.1 form: the bound itself. Keep the tighter of the two when both are given.
        const bound = schema[boundKey];
        schema[boundKey] = bound === undefined ? value : (flagKey === 'exclusiveMinimum' ? Math.max(bound, value) : Math.min(bound, value));
        schema[flagKey] = true;
      }
    }
  }
  if (type === 'array' && !item) {
    if (!isPlainObject(raw.items)) return { error: 'is a list without an item type' };
    const items = normalizeValue(raw.items, { item: true, openapi31 });
    if (items.error) return { error: `is a list whose items ${items.error}` };
    schema.items = items.schema;
    copy('minItems', isCount);
    copy('maxItems', isCount);
    if (raw.uniqueItems === true) schema.uniqueItems = true;
  }
  if (type === 'object') {
    if (raw.additionalProperties === false) schema.additionalProperties = false;
    else if (raw.additionalProperties !== undefined) schema.additionalProperties = true;
  }
  if (!item) {
    for (const key of ['readOnly', 'writeOnly', 'deprecated']) if (raw[key] === true) schema[key] = true;
    if (schema.readOnly && schema.writeOnly) delete schema.writeOnly;
    const example = raw.example !== undefined ? raw.example : Array.isArray(raw.examples) ? raw.examples[0] : undefined;
    for (const [key, value] of [['default', raw.default], ['example', example]]) {
      if (value === undefined) continue;
      schema[key] = value;
      if (validateFieldSchema(schema).error) delete schema[key];
    }
  }
  const checked = validateFieldSchema(schema, { item });
  if (checked.error) {
    // Drop what doesn't check out (an odd pattern, min above max...) rather than the whole value.
    for (const key of ['pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'default', 'example']) {
      delete schema[key];
    }
    const retry = validateFieldSchema(schema, { item });
    return retry.error ? { error: retry.error.toLowerCase() } : retry;
  }
  return checked;
};

const planImport = (spec) => {
  const openapi31 = isOpenApi31(spec);
  const schemas = isPlainObject(spec?.components?.schemas) ? spec.components.schemas : {};
  const fields = new Map(); // lower name -> { name, schema, description }
  const objects = new Map(); // lower name -> { name, description, additionalProperties, properties }
  const notes = [];
  const note = (text) => {
    if (notes.length < MAX_NOTES) notes.push(text);
  };

  const componentOf = (ref) => {
    let name = componentName(ref);
    let schema = name !== null ? schemas[name] : undefined;
    for (let hops = 0; isPlainObject(schema) && typeof schema.$ref === 'string' && hops < 20; hops += 1) {
      name = componentName(schema.$ref);
      schema = name !== null ? schemas[name] : undefined;
    }
    return isPlainObject(schema) ? { name, schema } : null;
  };

  // Field names: the same name with the same schema is the same field; otherwise qualified.
  const addField = (preferred, schema, description, qualifier) => {
    const base = fieldNameOf(preferred);
    const candidates = [base, ...(qualifier ? [fieldNameOf(`${qualifier}.${base}`)] : [])];
    for (const candidate of candidates) {
      const existing = fields.get(candidate.toLowerCase());
      if (!existing) {
        if (fields.size >= MAX_FIELDS) return null;
        fields.set(candidate.toLowerCase(), { name: candidate, schema, description: description || null, qualifier: qualifier || null });
        return candidate;
      }
      if (sameJson(existing.schema, schema)) {
        if (!existing.description && description) existing.description = description;
        return existing.name;
      }
    }
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${candidates[candidates.length - 1].slice(0, 95)}_${suffix}`;
      const existing = fields.get(candidate.toLowerCase());
      if (existing && sameJson(existing.schema, schema)) return existing.name;
      if (!existing) {
        if (fields.size >= MAX_FIELDS) return null;
        fields.set(candidate.toLowerCase(), { name: candidate, schema, description: description || null, qualifier: qualifier || null });
        return candidate;
      }
    }
    return null;
  };

  const reserveObjectName = (preferred) => {
    const base = objectNameOf(preferred);
    if (!objects.has(base.toLowerCase())) return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base.slice(0, 95)}_${suffix}`;
      if (!objects.has(candidate.toLowerCase())) return candidate;
    }
    return null;
  };

  // allOf members are merged into one set of properties; returns null for oneOf/anyOf.
  const mergeAllOf = (schema, seen = new Set(), depth = 0) => {
    if (!isPlainObject(schema) || depth > MAX_DEPTH) return null;
    if (schema.oneOf || schema.anyOf) return null;
    // Members in their order, then the schema's own properties (which win on the same name).
    const merged = {
      properties: {},
      required: Array.isArray(schema.required) ? [...schema.required] : [],
      description: typeof schema.description === 'string' ? schema.description : null,
      additionalProperties: schema.additionalProperties === false ? false : null,
    };
    for (const member of Array.isArray(schema.allOf) ? schema.allOf : []) {
      let target = member;
      if (isPlainObject(member) && typeof member.$ref === 'string') {
        if (seen.has(member.$ref)) continue;
        seen.add(member.$ref);
        target = componentOf(member.$ref)?.schema;
      }
      const part = mergeAllOf(target, seen, depth + 1);
      if (!part) return null;
      merged.properties = { ...merged.properties, ...part.properties };
      merged.required = [...new Set([...part.required, ...merged.required])];
      merged.description = merged.description || part.description;
      if (part.additionalProperties === false) merged.additionalProperties = false;
    }
    if (isPlainObject(schema.properties)) merged.properties = { ...merged.properties, ...schema.properties };
    return merged;
  };

  const componentObjects = new Map(); // component name -> object name
  const componentFields = new Map(); // component name -> field name

  let objectFrom; // defined below; objects and properties refer to each other

  // A property, parameter or item: what the dictionary entry is, or null when it can't be one.
  const describeValue = (propName, raw, { parent, depth }) => {
    let schema = raw;
    if (isPlainObject(schema) && typeof schema.$ref === 'string') {
      const target = componentOf(schema.$ref);
      if (!target) return { skip: `${parent}.${propName} points at ${schema.$ref}, which isn't in the document` };
      if (componentObjects.has(target.name)) return { kind: 'object', target: componentObjects.get(target.name) };
      if (componentFields.has(target.name)) return { kind: 'field', target: componentFields.get(target.name), isRef: true };
      return { skip: `${parent}.${propName} uses ${target.name}, which couldn't be added` };
    }
    if (isArraySchema(schema)) {
      const items = schema.items;
      if (isPlainObject(items) && typeof items.$ref === 'string') {
        const target = componentOf(items.$ref);
        if (target && componentObjects.has(target.name)) return { kind: 'object', target: componentObjects.get(target.name), isArray: true };
        if (target && componentFields.has(target.name)) {
          schema = { ...schema, items: target.schema };
        } else {
          return { skip: `${parent}.${propName} is a list of ${items.$ref}, which isn't in the document` };
        }
      } else if (isObjectLike(items)) {
        const name = objectFrom(`${pascal(propName)}Item`, items, { depth: depth + 1, parent });
        return name ? { kind: 'object', target: name, isArray: true } : { skip: `${parent}.${propName} couldn't be added` };
      }
    }
    if (isObjectLike(schema)) {
      const name = objectFrom(pascal(propName) || propName, schema, { depth: depth + 1, parent });
      return name ? { kind: 'object', target: name } : { skip: `${parent}.${propName} couldn't be added` };
    }
    const normalized = normalizeValue(schema, { openapi31 });
    if (normalized.error) return { skip: `${parent}.${propName} ${normalized.error}` };
    const description = typeof raw.description === 'string' ? raw.description.slice(0, 5000) : null;
    const target = addField(propName, normalized.schema, description, parent);
    return target ? { kind: 'field', target } : { skip: `${parent}.${propName}: the dictionary is full` };
  };

  objectFrom = (preferred, schema, { depth = 0, parent = null, name: fixedName = null } = {}) => {
    if (depth > MAX_DEPTH) return null;
    const merged = mergeAllOf(schema);
    if (!merged) {
      note(`${fixedName || preferred} combines several schemas (oneOf/anyOf), which the dictionary does not describe`);
      return null;
    }
    let name = fixedName;
    if (!name) {
      // A nested object takes the property's name, or Parent+Property when that is taken.
      name = objects.has(objectNameOf(preferred).toLowerCase()) && parent ? reserveObjectName(`${parent}${preferred}`) : reserveObjectName(preferred);
      if (!name || objects.size >= MAX_OBJECTS) return null;
    }
    const object = { name, description: merged.description, additionalProperties: merged.additionalProperties, properties: [] };
    objects.set(name.toLowerCase(), object);
    const entries = Object.entries(merged.properties);
    if (entries.length > MAX_PROPERTIES) note(`${name} has ${entries.length} properties; the first ${MAX_PROPERTIES} were added`);
    for (const [propName, propSchema] of entries.slice(0, MAX_PROPERTIES)) {
      const value = describeValue(propName, propSchema, { parent: name, depth });
      if (value.skip) {
        note(value.skip);
        continue;
      }
      object.properties.push({
        name: fieldNameOf(propName),
        kind: value.kind,
        target: value.target,
        isArray: value.isArray === true,
        required: merged.required.includes(propName),
      });
    }
    return name;
  };

  // Component names first, so properties can point at them whatever the order.
  for (const [name, schema] of Object.entries(schemas)) {
    if (!isPlainObject(schema)) continue;
    if (typeof schema.$ref === 'string') continue; // an alias of another component
    if (isObjectLike(schema)) {
      if (!mergeAllOf(schema)) {
        note(`${name} combines several schemas (oneOf/anyOf), which the dictionary does not describe`);
        continue;
      }
      const reserved = reserveObjectName(name);
      if (!reserved) continue;
      componentObjects.set(name, reserved);
      objects.set(reserved.toLowerCase(), { name: reserved, placeholder: true });
    }
  }
  for (const [name, schema] of Object.entries(schemas)) {
    if (!isPlainObject(schema) || typeof schema.$ref === 'string' || componentObjects.has(name) || isObjectLike(schema)) continue;
    const normalized = normalizeValue(schema, { openapi31 });
    if (normalized.error) {
      note(`${name} ${normalized.error}`);
      continue;
    }
    const field = addField(name, normalized.schema, typeof schema.description === 'string' ? schema.description : null, null);
    if (field) componentFields.set(name, field);
  }
  for (const [name, objectName] of componentObjects) objectFrom(name, schemas[name], { name: objectName });

  // Parameters and inline bodies of every operation.
  const resolveIn = (section, value) => {
    if (isPlainObject(value) && typeof value.$ref === 'string') {
      const prefix = `#/components/${section}/`;
      return value.$ref.startsWith(prefix) ? spec.components?.[section]?.[value.$ref.slice(prefix.length)] : undefined;
    }
    return value;
  };
  const isJson = (type) => /^application\/(.+\+)?json$/i.test(type.split(';')[0].trim()) || type === '*/*';

  for (const [path, item] of Object.entries(isPlainObject(spec?.paths) ? spec.paths : {})) {
    if (!isPlainObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isPlainObject(operation)) continue;
      const opName = objectNameOf(pascal(typeof operation.operationId === 'string' && operation.operationId ? operation.operationId : `${method} ${path}`));
      const parameters = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      for (const rawParam of parameters) {
        const param = resolveIn('parameters', rawParam);
        if (!isPlainObject(param) || typeof param.name !== 'string' || !['query', 'header', 'path', 'cookie'].includes(param.in)) continue;
        const schema = isPlainObject(param.schema) ? param.schema
          : isPlainObject(param.content) ? Object.values(param.content)[0]?.schema : undefined;
        if (!isPlainObject(schema)) continue;
        if (typeof schema.$ref === 'string' && componentFields.has(componentOf(schema.$ref)?.name)) continue;
        if (isObjectLike(schema) || typeof schema.$ref === 'string') continue;
        const normalized = normalizeValue(schema, { openapi31 });
        if (normalized.error) {
          note(`Parameter ${param.name} of ${method.toUpperCase()} ${path} ${normalized.error}`);
          continue;
        }
        addField(param.name, normalized.schema, typeof param.description === 'string' ? param.description.slice(0, 5000) : null, opName);
      }

      const bodies = [];
      const requestBody = resolveIn('requestBodies', operation.requestBody);
      if (isPlainObject(requestBody?.content)) bodies.push([`${opName}Request`, requestBody.content]);
      for (const [status, rawResponse] of Object.entries(isPlainObject(operation.responses) ? operation.responses : {})) {
        const response = resolveIn('responses', rawResponse);
        if (/^2/.test(status) && isPlainObject(response?.content)) bodies.push([`${opName}Response`, response.content]);
      }
      for (const [name, content] of bodies) {
        const media = Object.entries(content).find(([type]) => isJson(type));
        let schema = media?.[1]?.schema;
        if (!isPlainObject(schema) || typeof schema.$ref === 'string') continue;
        let objectName = name;
        if (isArraySchema(schema) && isObjectLike(schema.items)) {
          schema = schema.items;
          objectName = `${name}Item`;
        }
        if (isObjectLike(schema) && !objects.has(objectName.toLowerCase())) objectFrom(objectName, schema);
      }
    }
  }

  const planned = [...objects.values()].filter((object) => !object.placeholder);
  return { fields: [...fields.values()], objects: planned, notes, openapi31 };
};

module.exports = { planImport, normalizeValue };
