// Route matching: /{api basePath}{OpenAPI path template}, e.g. /acme/orders/orders/{id}.

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PARAM = /^\{([^/{}]+)\}$/;

const compileTemplate = (template) => {
  const names = [];
  const pattern = template
    .split(/(\{[^/{}]+\})/)
    .map((part) => {
      const param = part.match(PARAM);
      if (param) {
        names.push(param[1]);
        return '([^/]+)';
      }
      return escapeRegex(part);
    })
    .join('');
  return { regex: new RegExp(`^${pattern}/?$`), names };
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
    })),
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
