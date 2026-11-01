// Route matching: /{api basePath}{OpenAPI path template}, e.g. /acme/orders/orders/{id}.
// {name} matches one path segment; {name+} matches the rest of the path, slashes included
// (e.g. /files/{path+} for a website or file server behind the gateway).

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PARAM = /^\{([^/{}]+)\}$/;

const compileTemplate = (template) => {
  const names = [];
  let greedy = false;
  const pattern = template
    .split(/(\{[^/{}]+\})/)
    .map((part) => {
      const param = part.match(PARAM);
      if (param) {
        const rest = param[1].endsWith('+');
        greedy = greedy || rest;
        names.push(rest ? param[1].slice(0, -1) : param[1]);
        return rest ? '(.+)' : '([^/]+)';
      }
      return escapeRegex(part);
    })
    .join('');
  return { regex: new RegExp(`^${pattern}/?$`), names, greedy };
};

const normalizeBasePath = (basePath) => `/${String(basePath).split('/').filter(Boolean).join('/')}`;

const compileRoutes = (apis) => apis
  .map((api) => ({
    api,
    basePath: normalizeBasePath(api.basePath),
    operations: api.operations.map((operation) => ({
      method: operation.method.toUpperCase(),
      path: operation.path,
      // Parameters and request body from the OpenAPI document, for the Validate steps.
      contract: operation.contract || null,
      ...compileTemplate(operation.path),
    }))
      // {name+} operations are tried last, so /items/{id} wins over /{path+}.
      .sort((a, b) => Number(a.greedy) - Number(b.greedy)),
  }))
  // Longest base path first, so /acme/orders/v2 wins over /acme/orders.
  .sort((a, b) => b.basePath.length - a.basePath.length);

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// Returns { status: 200, api, operation, path, params } or { status: 404 | 405, allow }.
const matchRoute = (routes, method, pathname) => {
  for (const route of routes) {
    const { basePath } = route;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) continue;

    const path = pathname.slice(basePath.length) || '/';
    const candidates = route.operations.filter((operation) => operation.regex.test(path));
    if (!candidates.length) {
      return { status: 404 };
    }

    const operation = candidates.find((candidate) => candidate.method === method)
      || (method === 'HEAD' ? candidates.find((candidate) => candidate.method === 'GET') : undefined);
    if (!operation) {
      return { status: 405, allow: [...new Set(candidates.map((candidate) => candidate.method))] };
    }

    const values = path.match(operation.regex).slice(1);
    const params = Object.fromEntries(operation.names.map((name, index) => [name, safeDecode(values[index])]));
    return { status: 200, api: route.api, operation, path, params };
  }
  return { status: 404 };
};

// The operation of one API (as in the configuration) that an operation path and method match.
const findOperation = (operations, method, path) => {
  const upper = String(method).toUpperCase();
  const candidates = (operations || []).filter((operation) => compileTemplate(operation.path).regex.test(path));
  return candidates.find((operation) => operation.method.toUpperCase() === upper)
    || (upper === 'HEAD' ? candidates.find((operation) => operation.method.toUpperCase() === 'GET') : undefined)
    || null;
};

module.exports = { compileRoutes, matchRoute, compileTemplate, normalizeBasePath, findOperation };
