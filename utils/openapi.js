// Parsing, validation and editing of OpenAPI 3.x documents.
const YAML = require('yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const OPENAPI_VERSION = /^3\.\d+(\.\d+)?(-[\w.]+)?$/;
const PATH_PATTERN = /^\/[^\s?#]*$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Accepts an absolute http(s) URL or a server-relative path such as /v1.
const validateBaseUrl = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || value.length > 2048) {
    return 'Base URL must be at most 2048 characters';
  }
  if (value.startsWith('/')) {
    return null;
  }
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? null : 'Base URL must use http or https';
  } catch {
    return 'Base URL must be a valid URL (for example https://api.example.com/v1)';
  }
};

const validateSpec = (doc) => {
  if (!isPlainObject(doc)) {
    return { error: 'The file must contain an OpenAPI document (an object at the top level)' };
  }
  if (doc.swagger) {
    return { error: 'Swagger 2.0 files are not supported. Convert the file to OpenAPI 3.0 or later.' };
  }
  if (typeof doc.openapi !== 'string' || !OPENAPI_VERSION.test(doc.openapi)) {
    return { error: 'Only OpenAPI 3.0 or later is supported (the "openapi" field must be 3.x)' };
  }
  if (!isPlainObject(doc.info)) {
    return { error: 'The OpenAPI document is missing its "info" section' };
  }

  const title = typeof doc.info.title === 'string' ? doc.info.title.trim() : '';
  if (!title || title.length > 255) {
    return { error: 'info.title is required (max 255 characters)' };
  }
  // YAML turns `version: 1.0` into a number, so accept numbers too.
  const version = ['string', 'number'].includes(typeof doc.info.version) ? String(doc.info.version).trim() : '';
  if (!version || version.length > 50) {
    return { error: 'info.version is required (max 50 characters)' };
  }

  if (doc.paths === undefined && doc.webhooks === undefined) {
    return { error: 'The OpenAPI document must define "paths"' };
  }
  if (doc.paths !== undefined && !isPlainObject(doc.paths)) {
    return { error: '"paths" must be an object' };
  }
  for (const path of Object.keys(doc.paths || {})) {
    if (!path.startsWith('/')) {
      return { error: `Path "${path}" must start with "/"` };
    }
  }

  const spec = { ...doc, info: { ...doc.info, title, version } };
  return { spec };
};

// Where JSON text stops being valid (an offset), for parsers whose errors don't say.
const jsonErrorOffset = (text) => {
  let index = 0;
  const fail = () => {
    throw index;
  };
  const space = () => {
    while (index < text.length && ' \t\n\r'.includes(text[index])) index += 1;
  };
  const literal = (word) => {
    if (text.startsWith(word, index)) index += word.length;
    else fail();
  };
  const string = () => {
    index += 1;
    while (index < text.length && text[index] !== '"') {
      if (text[index] === '\n') fail();
      index += text[index] === '\\' ? 2 : 1;
    }
    if (index >= text.length) fail();
    index += 1;
  };
  const value = (depth) => {
    if (depth > 500) fail();
    space();
    const char = text[index];
    if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']';
      index += 1;
      space();
      if (text[index] === close) {
        index += 1;
        return;
      }
      for (;;) {
        if (char === '{') {
          space();
          if (text[index] !== '"') fail();
          string();
          space();
          if (text[index] !== ':') fail();
          index += 1;
        }
        value(depth + 1);
        space();
        if (text[index] === ',') index += 1;
        else if (text[index] === close) {
          index += 1;
          return;
        } else fail();
      }
    }
    if (char === '"') return string();
    if (char === 't') return literal('true');
    if (char === 'f') return literal('false');
    if (char === 'n') return literal('null');
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index, index + 400));
    if (!number) fail();
    index += number[0].length;
    return undefined;
  };
  try {
    value(0);
    space();
    return index < text.length ? index : null;
  } catch (offset) {
    return typeof offset === 'number' ? offset : null;
  }
};

// The 1-based line a JSON or YAML parse error points at.
const errorLine = (error, content, isJson) => {
  if (!isJson) return error.linePos?.[0]?.line || null;
  const message = String(error.message);
  const line = message.match(/line (\d+)/);
  if (line) return Number(line[1]);
  const position = message.match(/position (\d+)/);
  const offset = position ? Number(position[1]) : jsonErrorOffset(content);
  return offset === null ? null : content.slice(0, offset).split('\n').length;
};

const parseSpecText = (content) => {
  if (typeof content !== 'string' || !content.trim()) {
    return { error: 'The file is empty' };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SPEC_BYTES) {
    return { error: 'OpenAPI files must be 2 MB or smaller' };
  }

  let doc;
  const isJson = content.trim().startsWith('{');
  try {
    // YAML is a superset of JSON, but JSON.parse gives clearer errors for JSON files.
    doc = isJson ? JSON.parse(content) : YAML.parse(content, { maxAliasCount: 100 });
  } catch (error) {
    return { error: `The file could not be parsed: ${String(error.message).split('\n')[0]}`, line: errorLine(error, content, isJson) };
  }
  return validateSpec(doc);
};

// Name, version, description and base URL as stored on the Api record.
const summarizeSpec = (spec) => ({
  name: spec.info.title,
  version: String(spec.info.version),
  description: typeof spec.info.description === 'string' ? spec.info.description.slice(0, 5000) : null,
  baseUrl: Array.isArray(spec.servers) && typeof spec.servers[0]?.url === 'string'
    ? spec.servers[0].url.slice(0, 2048)
    : null,
});

const listOperations = (spec) => {
  const operations = [];
  for (const [path, item] of Object.entries(spec?.paths || {})) {
    if (!isPlainObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isPlainObject(operation)) continue;
      operations.push({
        method,
        path,
        summary: typeof operation.summary === 'string' ? operation.summary : '',
        operationId: typeof operation.operationId === 'string' ? operation.operationId : '',
        deprecated: operation.deprecated === true,
      });
    }
  }
  return operations.sort((a, b) => (
    a.path.localeCompare(b.path) || HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method)
  ));
};

const validateOperation = ({ method, path, summary } = {}) => {
  const normalizedMethod = typeof method === 'string' ? method.trim().toLowerCase() : '';
  if (!HTTP_METHODS.includes(normalizedMethod)) {
    return { error: 'Choose a valid HTTP method' };
  }
  const normalizedPath = typeof path === 'string' ? path.trim() : '';
  if (!PATH_PATTERN.test(normalizedPath) || normalizedPath.length > 500) {
    return { error: 'Paths must start with "/" and contain no spaces, "?" or "#" (e.g. /users/{id})' };
  }
  if (summary !== undefined && summary !== null && (typeof summary !== 'string' || summary.length > 255)) {
    return { error: 'Summaries must be at most 255 characters' };
  }
  return { operation: { method: normalizedMethod, path: normalizedPath, summary: (summary || '').trim() } };
};

const withOperation = (spec, { method, path, summary }) => {
  const paths = { ...(spec.paths || {}) };
  if (paths[path]?.[method]) {
    return { error: `${method.toUpperCase()} ${path} already exists` };
  }
  paths[path] = {
    ...(paths[path] || {}),
    [method]: {
      ...(summary ? { summary } : {}),
      responses: { 200: { description: 'Successful response' } },
    },
  };
  return { spec: { ...spec, paths } };
};

const withoutOperation = (spec, { method, path }) => {
  if (!spec.paths?.[path]?.[method]) {
    return { error: 'That endpoint does not exist' };
  }
  const paths = { ...spec.paths };
  const { [method]: removed, ...rest } = paths[path];
  const hasOtherOperations = HTTP_METHODS.some((other) => rest[other]);
  if (hasOtherOperations) {
    paths[path] = rest;
  } else {
    delete paths[path];
  }
  return { spec: { ...spec, paths } };
};

// Keeps the document's info and servers in sync with edited API details.
const withInfo = (spec, { name, version, description, baseUrl }) => {
  const info = { ...spec.info, title: name, version };
  if (description) {
    info.description = description;
  } else {
    delete info.description;
  }
  const otherServers = Array.isArray(spec.servers) ? spec.servers.slice(1) : [];
  const servers = baseUrl ? [{ ...(spec.servers?.[0] || {}), url: baseUrl }, ...otherServers] : otherServers;
  const updated = { ...spec, info };
  if (servers.length) {
    updated.servers = servers;
  } else {
    delete updated.servers;
  }
  return updated;
};

const buildSpec = ({ name, version, description, baseUrl }) => withInfo(
  { openapi: '3.0.3', info: { title: name, version }, paths: {} },
  { name, version, description, baseUrl }
);

module.exports = {
  HTTP_METHODS,
  parseSpecText,
  validateSpec,
  validateBaseUrl,
  summarizeSpec,
  listOperations,
  validateOperation,
  withOperation,
  withoutOperation,
  withInfo,
  buildSpec,
};
