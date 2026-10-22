const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Api, ApiProduct, Catalog, ProductApi, Policy, Connection, GatewayHandler } = require('../models');
const { defaultFlow } = require('../gateway/src/flow');
const { validateBasePath, normalizeBasePath, uniqueBasePath } = require('../utils/basePath');
const { sendServerError } = require('../utils/http');
const { optionalText } = require('../utils/validation');
const {
  parseSpecText,
  validateBaseUrl,
  summarizeSpec,
  listOperations,
  validateOperation,
  withOperation,
  withoutOperation,
  withInfo,
  buildSpec,
} = require('../utils/openapi');
const { importIntoDictionary } = require('../services/dictionary');

// Every new API gets a policy of its own with the default flow (Input -> Output): until someone
// adds steps, the gateway answers each call with the request it received.
const createApiWithPolicy = (attributes) => sequelize.transaction(async (transaction) => {
  const api = await Api.create(attributes, { transaction });
  const policy = await Policy.create({
    organizationId: api.organizationId,
    name: `${api.name} policy`.slice(0, 255),
    description: `Flow for ${api.name}. It returns each request as it is until you add steps.`,
    flow: defaultFlow(),
    ownerApiId: api.id,
  }, { transaction });
  await api.update({ policyId: policy.id }, { transaction });
  return api;
});

const serializeApi = (api, { withOperations = false } = {}) => {
  const operations = listOperations(api.spec);
  return {
    id: api.id,
    name: api.name,
    version: api.version,
    description: api.description,
    baseUrl: api.baseUrl,
    basePath: api.basePath,
    catalogId: api.catalogId,
    ...(api.catalog && { catalog: { id: api.catalog.id, name: api.catalog.name } }),
    policyId: api.policyId,
    connectionId: api.connectionId,
    source: api.source,
    openapi: api.spec?.openapi,
    operationCount: operations.length,
    ...(withOperations && { operations }),
    ...(api.products && {
      products: api.products.map((product) => ({ id: product.id, name: product.name, status: product.status })),
    }),
    createdAt: api.createdAt,
    updatedAt: api.updatedAt,
  };
};

// With partial = true only the provided fields are validated and returned.
const validateApiInfo = (body = {}, { partial = false } = {}) => {
  const fields = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) return { error: 'API name is required (max 255 characters)' };
    fields.name = name;
  }
  if (!partial || body.version !== undefined) {
    const version = typeof body.version === 'string' ? body.version.trim() : '';
    if (!version || version.length > 50) return { error: 'Version is required (max 50 characters, e.g. 1.0.0)' };
    fields.version = version;
  }
  if (body.description !== undefined) {
    const { value, error } = optionalText(body.description, 'Description', 5000);
    if (error) return { error };
    fields.description = value;
  }
  if (body.baseUrl !== undefined) {
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : body.baseUrl;
    const error = validateBaseUrl(baseUrl);
    if (error) return { error };
    fields.baseUrl = baseUrl || null;
  }
  return { fields };
};

// Gateway settings: base path (unique in the organization) and policy (from the organization).
const validateGatewaySettings = async (req, body = {}, apiId = null) => {
  const fields = {};
  if (body.basePath !== undefined) {
    const error = validateBasePath(body.basePath);
    if (error) return { error };
    const basePath = normalizeBasePath(body.basePath);
    const taken = await Api.findOne({
      where: {
        organizationId: req.user.organizationId,
        basePath,
        ...(apiId && { id: { [Op.ne]: apiId } }),
      },
    });
    if (taken) return { error: `${basePath} is already used by ${taken.name}`, status: 409 };
    fields.basePath = basePath;
  }
  if (body.policyId !== undefined) {
    if (body.policyId === null || body.policyId === '') {
      fields.policyId = null;
    } else {
      const policy = await Policy.findOne({ where: { id: body.policyId, organizationId: req.user.organizationId } });
      if (!policy) return { error: "Choose one of your organization's policies" };
      fields.policyId = policy.id;
    }
  }
  if (body.connectionId !== undefined) {
    if (body.connectionId === null || body.connectionId === '') {
      fields.connectionId = null;
    } else {
      const connection = await Connection.findOne({ where: { id: body.connectionId, organizationId: req.user.organizationId } });
      if (!connection) return { error: "Choose one of your organization's connections" };
      fields.connectionId = connection.id;
    }
  }
  return { fields };
};

// New APIs are created inside one of the organization's catalogs.
const findTargetCatalog = (req) => {
  const catalogId = req.body?.catalogId ?? req.query.catalogId;
  if (typeof catalogId !== 'string' || !catalogId) return null;
  return Catalog.findOne({ where: { id: catalogId, organizationId: req.user.organizationId } });
};
const CATALOG_REQUIRED = 'Choose the catalog the API belongs to';

const findOrgApi = (req, options = {}) => Api.findOne({
  where: { id: req.params.id, organizationId: req.user.organizationId },
  ...options,
});

const productsInclude = { association: 'products', attributes: ['id', 'name', 'status'], through: { attributes: [] } };

const listApis = async (req, res) => {
  try {
    const apis = await Api.findAll({
      where: {
        organizationId: req.user.organizationId,
        ...(typeof req.query.catalogId === 'string' && { catalogId: req.query.catalogId }),
      },
      include: [productsInclude],
      order: [['name', 'ASC']],
    });
    res.json({ apis: apis.map((api) => serializeApi(api)) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load APIs');
  }
};

// Create from scratch: details plus an optional list of endpoints.
const createApi = async (req, res) => {
  try {
    const { fields, error } = validateApiInfo(req.body);
    if (error) {
      return res.status(400).json({ error });
    }
    const catalog = await findTargetCatalog(req);
    if (!catalog) {
      return res.status(400).json({ error: CATALOG_REQUIRED });
    }

    let spec = buildSpec(fields);
    const endpoints = Array.isArray(req.body.endpoints) ? req.body.endpoints : [];
    if (endpoints.length > 200) {
      return res.status(400).json({ error: 'Add at most 200 endpoints at a time' });
    }
    for (const endpoint of endpoints) {
      const { operation, error: operationError } = validateOperation(endpoint);
      if (operationError) return res.status(400).json({ error: operationError });
      const result = withOperation(spec, operation);
      if (result.error) return res.status(400).json({ error: result.error });
      spec = result.spec;
    }

    const api = await createApiWithPolicy({
      ...fields,
      basePath: await uniqueBasePath(Api, req.user.organizationId, fields.name),
      organizationId: req.user.organizationId,
      catalogId: catalog.id,
      source: 'manual',
      spec,
    });
    res.status(201).json({ api: serializeApi(api, { withOperations: true }) });
  } catch (error) {
    sendServerError(res, error, 'Failed to create API');
  }
};

// Import an OpenAPI 3.x document sent as text (JSON or YAML).
const importApi = async (req, res) => {
  try {
    const catalog = await findTargetCatalog(req);
    if (!catalog) {
      return res.status(400).json({ error: CATALOG_REQUIRED });
    }
    const { spec, error } = parseSpecText(req.body?.content);
    if (error) {
      return res.status(400).json({ error });
    }

    const summary = summarizeSpec(spec);
    const api = await createApiWithPolicy({
      ...summary,
      basePath: await uniqueBasePath(Api, req.user.organizationId, summary.name),
      organizationId: req.user.organizationId,
      catalogId: catalog.id,
      source: 'import',
      spec,
    });
    // The document's schemas and parameters go into the data dictionary. The API is imported
    // either way: the dictionary can be filled from it again on the designer page.
    let dictionary = null;
    try {
      dictionary = await importIntoDictionary({ spec, organizationId: req.user.organizationId, apiId: api.id, userId: req.user.id });
    } catch (error) {
      console.error('Dictionary import failed:', error.name);
    }
    res.status(201).json({ api: serializeApi(api, { withOperations: true }), dictionary });
  } catch (error) {
    sendServerError(res, error, 'Failed to import API');
  }
};

const getApi = async (req, res) => {
  try {
    const api = await findOrgApi(req, { include: [productsInclude] });
    if (!api) {
      return res.status(404).json({ error: 'API not found' });
    }
    res.json({ api: serializeApi(api, { withOperations: true }) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load API');
  }
};

const updateApi = async (req, res) => {
  try {
    const api = await findOrgApi(req);
    if (!api) {
      return res.status(404).json({ error: 'API not found' });
    }

    const { fields, error } = validateApiInfo(req.body, { partial: true });
    if (error) {
      return res.status(400).json({ error });
    }
    const gatewaySettings = await validateGatewaySettings(req, req.body, api.id);
    if (gatewaySettings.error) {
      return res.status(gatewaySettings.status || 400).json({ error: gatewaySettings.error });
    }

    const merged = {
      name: api.name,
      version: api.version,
      description: api.description,
      baseUrl: api.baseUrl,
      ...fields,
    };
    await api.update({ ...fields, ...gatewaySettings.fields, spec: withInfo(api.spec, merged) });
    res.json({ api: serializeApi(api, { withOperations: true }) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update API');
  }
};

// Products left without any API are moved back to draft so the catalog never shows empty products.
const deleteApi = async (req, res) => {
  try {
    const api = await findOrgApi(req);
    if (!api) {
      return res.status(404).json({ error: 'API not found' });
    }

    const unpublished = await sequelize.transaction(async (transaction) => {
      const links = await ProductApi.findAll({ where: { apiId: api.id }, transaction });
      const productIds = links.map((link) => link.productId);
      await ProductApi.destroy({ where: { apiId: api.id }, transaction });
      await api.destroy({ transaction });

      // The API's own policy goes with it, unless another API or a port uses it too.
      const owned = await Policy.findOne({ where: { ownerApiId: api.id, organizationId: api.organizationId }, transaction });
      if (owned) {
        const stillUsed = await Api.count({ where: { policyId: owned.id }, transaction })
          + await GatewayHandler.count({ where: { policyId: owned.id }, transaction });
        if (stillUsed) await owned.update({ ownerApiId: null }, { transaction });
        else await owned.destroy({ transaction });
      }

      const emptied = [];
      for (const productId of productIds) {
        const remaining = await ProductApi.count({ where: { productId }, transaction });
        if (remaining === 0) {
          const [count] = await ApiProduct.update(
            { status: 'draft' },
            { where: { id: productId, status: 'published' }, transaction }
          );
          if (count) emptied.push(productId);
        }
      }
      return emptied;
    });

    res.json({ message: 'API deleted', unpublishedProductIds: unpublished });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete API');
  }
};

const downloadSpec = async (req, res) => {
  try {
    const api = await findOrgApi(req);
    if (!api) {
      return res.status(404).json({ error: 'API not found' });
    }
    const fileName = `${api.name}-${api.version}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '') || 'openapi';
    res.set('Content-Disposition', `attachment; filename="${fileName}.json"`);
    res.type('application/json').send(JSON.stringify(api.spec, null, 2));
  } catch (error) {
    sendServerError(res, error, 'Failed to download the OpenAPI document');
  }
};

const addOperation = async (req, res) => {
  try {
    const api = await findOrgApi(req);
    if (!api) {
      return res.status(404).json({ error: 'API not found' });
    }
    const { operation, error } = validateOperation(req.body);
    if (error) {
      return res.status(400).json({ error });
    }
    const result = withOperation(api.spec, operation);
    if (result.error) {
      return res.status(409).json({ error: result.error });
    }
    await api.update({ spec: result.spec });
    res.status(201).json({ api: serializeApi(api, { withOperations: true }) });
  } catch (error) {
    sendServerError(res, error, 'Failed to add endpoint');
  }
};

// The endpoint is identified by ?method=get&path=/users/{id}
const removeOperation = async (req, res) => {
  try {
    const api = await findOrgApi(req);
    if (!api) {
      return res.status(404).json({ error: 'API not found' });
    }
    const { operation, error } = validateOperation({ method: req.query.method, path: req.query.path });
    if (error) {
      return res.status(400).json({ error });
    }
    const result = withoutOperation(api.spec, operation);
    if (result.error) {
      return res.status(404).json({ error: result.error });
    }
    await api.update({ spec: result.spec });
    res.json({ api: serializeApi(api, { withOperations: true }) });
  } catch (error) {
    sendServerError(res, error, 'Failed to remove endpoint');
  }
};

module.exports = {
  serializeApi,
  listApis,
  createApi,
  importApi,
  getApi,
  updateApi,
  deleteApi,
  downloadSpec,
  addOperation,
  removeOperation,
};
