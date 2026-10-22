// What the gateway's Validate steps check for one operation, taken from the API's OpenAPI document:
// header and query parameters (with their schemas) and the request body per media type.
// Every local $ref is resolved here, so the gateway gets self-contained schemas.
//   { parameters: [{ in, name, required, schema, style?, explode?, allowEmptyValue?, contentType? }],
//     body: null | { required, content: { 'application/json': { schema }, ... } } }
const MAX_NODES = 20000;
const MAX_DEPTH = 64;
// OpenAPI: these header parameters are ignored (the HTTP layer and security schemes own them).
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const pointerGet = (doc, ref) => {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let value = doc;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(value) && !Array.isArray(value)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
};

// Copies `value` with local $refs replaced by what they point to. A $ref back into itself (a
// recursive schema) becomes {} (anything) at that point; external or broken refs become {} too.
const resolver = (doc) => {
  let nodes = 0;
  const resolve = (value, stack = [], depth = 0) => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return {};
    if (Array.isArray(value)) return value.map((item) => resolve(item, stack, depth + 1));
    if (!isPlainObject(value)) return value;
    if (typeof value.$ref === 'string') {
      if (stack.includes(value.$ref)) return {};
      const target = pointerGet(doc, value.$ref);
      if (target === undefined) return {};
      // OpenAPI 3.1 allows siblings next to $ref; they add to the referenced schema.
      const { $ref, ...siblings } = value;
      const resolved = resolve(target, [...stack, $ref], depth + 1);
      return Object.keys(siblings).length && isPlainObject(resolved) ? { ...resolved, ...resolve(siblings, stack, depth + 1) } : resolved;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      // Examples can be large and never affect validation.
      if (key === 'example' || key === 'examples' || key === 'xml' || key === 'externalDocs') continue;
      result[key] = resolve(item, stack, depth + 1);
    }
    return result;
  };
  return resolve;
};

const parameterOf = (param) => {
  if (!isPlainObject(param) || typeof param.name !== 'string' || !['header', 'query'].includes(param.in)) return null;
  if (param.in === 'header' && IGNORED_HEADERS.has(param.name.toLowerCase())) return null;
  const entry = { in: param.in, name: param.name, required: param.required === true };
  if (isPlainObject(param.schema)) entry.schema = param.schema;
  else if (isPlainObject(param.content) && Object.keys(param.content).length) {
    const [contentType, media] = Object.entries(param.content)[0];
    entry.contentType = contentType;
    entry.schema = isPlainObject(media?.schema) ? media.schema : {};
  } else {
    entry.schema = {};
  }
  if (typeof param.style === 'string') entry.style = param.style;
  if (typeof param.explode === 'boolean') entry.explode = param.explode;
  if (param.allowEmptyValue === true) entry.allowEmptyValue = true;
  return entry;
};

const operationContract = (spec, path, method) => {
  const resolve = resolver(spec);
  const item = resolve(spec?.paths?.[path]);
  const operation = isPlainObject(item) ? item[method] : null;
  if (!isPlainObject(operation)) return null;

  // Operation-level parameters override path-level ones with the same name and location.
  const byKey = new Map();
  for (const list of [item.parameters, operation.parameters]) {
    for (const param of Array.isArray(list) ? list : []) {
      const entry = parameterOf(param);
      if (entry) byKey.set(`${entry.in}:${entry.in === 'header' ? entry.name.toLowerCase() : entry.name}`, entry);
    }
  }

  let body = null;
  const requestBody = operation.requestBody;
  if (isPlainObject(requestBody) && isPlainObject(requestBody.content)) {
    const content = {};
    for (const [mediaType, media] of Object.entries(requestBody.content)) {
      content[mediaType] = isPlainObject(media) && media.schema !== undefined ? { schema: media.schema } : {};
    }
    body = { required: requestBody.required === true, content };
  }
  return { parameters: [...byKey.values()], body };
};

module.exports = { operationContract };
