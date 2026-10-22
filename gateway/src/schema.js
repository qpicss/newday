// Validation against OpenAPI schemas (3.0 and 3.1: the JSON Schema keywords an API definition
// uses), and the turning of header and query strings into the typed values their schema describes.
// Schemas arrive with every $ref already resolved by the console (utils/openapiContract.js).
const MAX_ERRORS = 20;
const MAX_DEPTH = 64;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};
const matchesType = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
};
const typesOf = (schema) => {
  if (!isObject(schema)) return [];
  const types = Array.isArray(schema.type) ? [...schema.type] : schema.type ? [schema.type] : [];
  if (schema.nullable === true && types.length && !types.includes('null')) types.push('null');
  return types;
};

const FORMATS = {
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
  'date-time': (value) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)),
  time: (value) => /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(value),
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  uuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  uri: (value) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(value),
  hostname: (value) => /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(value),
  ipv4: (value) => /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(value),
  ipv6: (value) => /^[0-9A-Fa-f:.]{2,45}$/.test(value) && value.includes(':'),
  byte: (value) => /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0,
};
const NUMBER_FORMATS = {
  int32: (value) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647,
  int64: (value) => Number.isSafeInteger(value),
};

const patterns = new Map();
const patternOf = (source) => {
  if (!patterns.has(source)) {
    let regex = null;
    try {
      regex = new RegExp(source, 'u');
    } catch {
      // A pattern JavaScript can't compile is skipped rather than failing every request.
    }
    if (patterns.size > 1000) patterns.clear();
    patterns.set(source, regex);
  }
  return patterns.get(source);
};

const describeValue = (value) => {
  const type = typeOf(value);
  return type === 'integer' ? 'a number' : type === 'array' ? 'a list' : type === 'object' ? 'an object' : type === 'null' ? 'null' : `a ${type}`;
};
const article = (type) => (type === 'integer' || type === 'object' || type === 'array' ? `an ${type === 'array' ? 'array' : type}` : `a ${type}`);
const show = (value) => {
  const text = JSON.stringify(value);
  return text && text.length > 40 ? `${text.slice(0, 37)}...` : text;
};
const pointer = (path) => (path.length ? `/${path.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '');

const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b) && !(typeof a === 'number' && typeof b === 'number')) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (isObject(a)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
};

// The properties an object schema declares, with those of its allOf/anyOf/oneOf parts. `open` is
// true when some part allows any other property, so unknown properties can't be rejected there.
const declared = (schema, depth = 0) => {
  const names = new Set(Object.keys(isObject(schema.properties) ? schema.properties : {}));
  let open = schema.additionalProperties !== undefined && schema.additionalProperties !== false;
  if (isObject(schema.patternProperties) && Object.keys(schema.patternProperties).length) open = true;
  if (depth < 8) {
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      for (const part of Array.isArray(schema[key]) ? schema[key] : []) {
        if (!isObject(part)) continue;
        const inner = declared(part, depth + 1);
        inner.names.forEach((name) => names.add(name));
        if (inner.open) open = true;
      }
    }
  }
  return { names, open };
};

// Returns a list of { path, message } (at most MAX_ERRORS), empty when `value` matches.
// options.rejectUnknown: properties an object schema does not declare are errors unless the
// schema allows them. options.request: readOnly properties are not required (they belong to responses).
const validate = (schema, value, options = {}) => {
  const errors = [];
  const add = (path, message) => {
    if (errors.length < MAX_ERRORS) errors.push({ path: pointer(path), message });
  };

  const check = (node, data, path, depth, { inPart = false } = {}) => {
    if (errors.length >= MAX_ERRORS) return;
    if (node === true || node === undefined || node === null) return;
    if (node === false) {
      add(path, 'is not allowed');
      return;
    }
    if (!isObject(node)) return;
    if (depth > MAX_DEPTH) {
      add(path, 'is nested too deeply');
      return;
    }

    const types = typesOf(node);
    if (data === null && node.nullable === true) return;
    if (types.length && !types.some((type) => matchesType(data, type))) {
      add(path, `must be ${types.filter((type) => type !== 'null').map(article).join(' or ') || 'null'}${types.includes('null') && types.length > 1 ? ' or null' : ''}, not ${describeValue(data)}`);
      return;
    }
    if (Array.isArray(node.enum) && !node.enum.some((item) => deepEqual(item, data))) {
      add(path, `must be one of ${node.enum.slice(0, 10).map(show).join(', ')}${node.enum.length > 10 ? ', ...' : ''}`);
    }
    if (node.const !== undefined && !deepEqual(node.const, data)) add(path, `must be ${show(node.const)}`);

    if (typeof data === 'string') {
      const length = [...data].length;
      if (Number.isInteger(node.minLength) && length < node.minLength) add(path, `must be at least ${node.minLength} characters long`);
      if (Number.isInteger(node.maxLength) && length > node.maxLength) add(path, `must be at most ${node.maxLength} characters long`);
      if (typeof node.pattern === 'string') {
        const regex = patternOf(node.pattern);
        if (regex && !regex.test(data)) add(path, `must match the pattern ${node.pattern}`);
      }
      if (typeof node.format === 'string' && FORMATS[node.format] && !FORMATS[node.format](data)) add(path, `must be a valid ${node.format}`);
    }

    if (typeof data === 'number') {
      const exclusiveMin = node.exclusiveMinimum === true ? node.minimum : typeof node.exclusiveMinimum === 'number' ? node.exclusiveMinimum : undefined;
      const exclusiveMax = node.exclusiveMaximum === true ? node.maximum : typeof node.exclusiveMaximum === 'number' ? node.exclusiveMaximum : undefined;
      if (typeof node.minimum === 'number' && node.exclusiveMinimum !== true && data < node.minimum) add(path, `must be at least ${node.minimum}`);
      if (typeof node.maximum === 'number' && node.exclusiveMaximum !== true && data > node.maximum) add(path, `must be at most ${node.maximum}`);
      if (typeof exclusiveMin === 'number' && data <= exclusiveMin) add(path, `must be greater than ${exclusiveMin}`);
      if (typeof exclusiveMax === 'number' && data >= exclusiveMax) add(path, `must be less than ${exclusiveMax}`);
      if (typeof node.multipleOf === 'number' && node.multipleOf > 0) {
        const ratio = data / node.multipleOf;
        if (Math.abs(ratio - Math.round(ratio)) > 1e-9) add(path, `must be a multiple of ${node.multipleOf}`);
      }
      if (typeof node.format === 'string' && NUMBER_FORMATS[node.format] && !NUMBER_FORMATS[node.format](data)) add(path, `must be a valid ${node.format}`);
    }

    if (Array.isArray(data)) {
      if (Number.isInteger(node.minItems) && data.length < node.minItems) add(path, `must have at least ${node.minItems} item${node.minItems === 1 ? '' : 's'}`);
      if (Number.isInteger(node.maxItems) && data.length > node.maxItems) add(path, `must have at most ${node.maxItems} items`);
      if (node.uniqueItems === true) {
        const seen = data.findIndex((item, index) => data.slice(0, index).some((other) => deepEqual(other, item)));
        if (seen !== -1) add([...path, seen], 'repeats an earlier item; items must be unique');
      }
      const tuple = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : null;
      data.forEach((item, index) => {
        if (tuple && index < tuple.length) check(tuple[index], item, [...path, index], depth + 1);
        else if (tuple && node.additionalItems === false && Array.isArray(node.items)) add([...path, index], 'is not allowed');
        else if (!Array.isArray(node.items) && node.items !== undefined) check(node.items, item, [...path, index], depth + 1);
      });
    }

    if (isObject(data)) {
      const properties = isObject(node.properties) ? node.properties : {};
      const keys = Object.keys(data);
      if (Number.isInteger(node.minProperties) && keys.length < node.minProperties) add(path, `must have at least ${node.minProperties} properties`);
      if (Number.isInteger(node.maxProperties) && keys.length > node.maxProperties) add(path, `must have at most ${node.maxProperties} properties`);
      for (const name of Array.isArray(node.required) ? node.required : []) {
        if (Object.prototype.hasOwnProperty.call(data, name)) continue;
        if (options.request && isObject(properties[name]) && properties[name].readOnly === true) continue;
        add([...path, name], 'is required');
      }
      const patternEntries = isObject(node.patternProperties) ? Object.entries(node.patternProperties) : [];
      const known = !inPart && options.rejectUnknown && node.additionalProperties === undefined ? declared(node) : null;
      for (const key of keys) {
        let matched = false;
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          matched = true;
          check(properties[key], data[key], [...path, key], depth + 1);
        }
        for (const [source, schema] of patternEntries) {
          const regex = patternOf(source);
          if (regex && regex.test(key)) {
            matched = true;
            check(schema, data[key], [...path, key], depth + 1);
          }
        }
        if (matched) continue;
        if (node.additionalProperties === false) add([...path, key], 'is not a declared property');
        else if (isObject(node.additionalProperties)) check(node.additionalProperties, data[key], [...path, key], depth + 1);
        else if (known && !known.open && known.names.size && !known.names.has(key)) add([...path, key], 'is not a declared property');
      }
    }

    // Parts of a composition see the whole object, so they never reject its other properties.
    if (Array.isArray(node.allOf)) node.allOf.forEach((part) => check(part, data, path, depth + 1, { inPart: true }));
    const passes = (part) => validate(part, data, { ...options, rejectUnknown: false }).length === 0;
    if (Array.isArray(node.anyOf) && node.anyOf.length && !node.anyOf.some(passes)) add(path, 'does not match any of the allowed schemas');
    if (Array.isArray(node.oneOf) && node.oneOf.length) {
      const count = node.oneOf.filter(passes).length;
      if (count !== 1) add(path, count ? 'matches more than one of the allowed schemas' : 'does not match any of the allowed schemas');
    }
    if (node.not !== undefined && passes(node.not)) add(path, 'matches a schema it must not match');
  };

  check(schema, value, [], 0);
  return errors;
};

// ---------------------------------------------------------------- parameter values

const primaryType = (schema) => {
  const types = typesOf(schema).filter((type) => type !== 'null');
  if (types.length) return types[0];
  if (isObject(schema)) {
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      for (const part of Array.isArray(schema[key]) ? schema[key] : []) {
        const inner = primaryType(part);
        if (inner) return inner;
      }
    }
    if (isObject(schema.properties)) return 'object';
    if (schema.items) return 'array';
  }
  return null;
};

// "42" -> 42 when the schema wants a number; values that don't convert stay strings, so the
// schema check reports them ("must be an integer, not a string").
const scalar = (raw, schema) => {
  const type = primaryType(schema);
  if (type === 'integer' || type === 'number') return /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw) ? Number(raw) : raw;
  if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (type === 'null') return raw === '' || raw === 'null' ? null : raw;
  return raw;
};

const pairsToObject = (list, schema) => {
  const properties = isObject(schema?.properties) ? schema.properties : {};
  const result = {};
  for (let index = 0; index + 1 < list.length; index += 2) result[list[index]] = scalar(list[index + 1], properties[list[index]] || schema?.additionalProperties);
  return result;
};

const DELIMITERS = { form: ',', simple: ',', spaceDelimited: ' ', pipeDelimited: '|' };

// The typed value of a header or query parameter, read from the request.
//   param: { in, name, schema, style, explode, contentType } (from the console's contract)
//   source: the request's headers (lower-case names) or query ({ name: string | string[] })
// Returns { present, value } or { present: true, error } when the text can't be read as declared.
const readParameter = (param, source) => {
  const schema = param.schema || {};
  const isHeader = param.in === 'header';
  const key = isHeader ? param.name.toLowerCase() : param.name;
  const style = param.style || (isHeader ? 'simple' : 'form');
  const explode = param.explode !== undefined ? param.explode : style === 'form';
  const type = primaryType(schema);

  // Query objects spread over several names: ?color[r]=1 (deepObject) or ?r=1&g=2 (form, explode).
  if (!isHeader && type === 'object' && (style === 'deepObject' || (style === 'form' && explode && !param.contentType))) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const value = {};
    let present = false;
    for (const [name, raw] of Object.entries(source)) {
      let property = null;
      if (style === 'deepObject') {
        const match = name.match(/^([^[\]]+)\[([^[\]]+)\]$/);
        if (match && match[1] === key) [, , property] = match;
      } else if (Object.prototype.hasOwnProperty.call(properties, name)) {
        property = name;
      }
      if (property === null) continue;
      present = true;
      value[property] = scalar([].concat(raw)[0], properties[property] || schema.additionalProperties);
    }
    return { present, value };
  }

  const raw = source[key];
  if (raw === undefined) return { present: false };
  const values = [].concat(raw).map(String);

  if (param.contentType) {
    if (!/json/i.test(param.contentType)) return { present: true, value: values[0] };
    try {
      return { present: true, value: JSON.parse(values[0]) };
    } catch {
      return { present: true, error: 'must be valid JSON' };
    }
  }
  if (type === 'array') {
    const items = isHeader || !explode || style !== 'form'
      ? values.flatMap((item) => (item === '' ? [] : item.split(DELIMITERS[style] || ',').map((part) => (isHeader ? part.trim() : part))))
      : values;
    return { present: true, value: items.map((item) => scalar(item, schema.items)) };
  }
  if (values.length > 1 && !isHeader) return { present: true, error: 'must be sent once' };
  const text = values.join(', ');
  if (type === 'object') {
    const parts = text.split(',').map((part) => part.trim());
    if (explode) return { present: true, value: pairsToObject(parts.flatMap((part) => { const at = part.indexOf('='); return at === -1 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)]; }), schema) };
    return { present: true, value: pairsToObject(parts, schema) };
  }
  return { present: true, value: scalar(text, schema) };
};

// Form bodies (application/x-www-form-urlencoded) as the object their schema describes.
const formToObject = (text, schema) => {
  const properties = isObject(schema?.properties) ? schema.properties : {};
  const result = {};
  for (const [name, value] of new URLSearchParams(text)) {
    const property = properties[name] || schema?.additionalProperties;
    if (primaryType(property) === 'array') result[name] = [...(result[name] || []), scalar(value, property.items)];
    else if (name in result) result[name] = [].concat(result[name], value);
    else result[name] = scalar(value, property);
  }
  return result;
};

module.exports = { validate, readParameter, formToObject, primaryType, MAX_ERRORS };
