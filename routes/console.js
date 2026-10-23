// Pages for the selected organization: its catalogs (with their products and APIs), access requests,
// policies, connections, gateways and members. Mounted inside the developer router, so every request
// is already authenticated and req.user carries the selected organization and the role there.
//
//   Org admins manage everything below; members browse the catalogs and published products.
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { requireOrganization, requireOrgAdmin } = require('../middleware/org');
const {
  Organization,
  Invitation,
  Application,
  Api,
  ApiProduct,
  Subscription,
  Membership,
  Catalog,
  Connection,
  Gateway,
  Policy,
} = require('../models');
const { isMailConfigured } = require('../utils/mailer');
const { HTTP_METHODS, listOperations } = require('../utils/openapi');
const { serializeApi } = require('../controllers/apiController');
const {
  RATE_LIMIT_PERIODS,
  CURRENCIES,
  serializeProduct,
  serializeSubscription,
  subscriptionIncludes,
  apisInclude,
  countPendingByProduct,
} = require('../controllers/productController');
const { findPublishedProduct } = require('../controllers/catalogController');
const { DEFAULT_SCRIPT, serializePolicy, problemsOf } = require('../controllers/policyController');
const { usesBackend, CONDITION_SOURCES, OPERATORS, METHODS } = require('../gateway/src/flow');
const { gatewayIncludes, describeGateway } = require('../controllers/deploymentController');
const { isRecentlySeen, gatewaySetup } = require('../utils/gatewaySetup');
const { serializeConnection } = require('../controllers/connectionController');
const { canCreateOrganizations } = require('../services/membership');
const { usageSeries } = require('../services/usage');
const { getPki } = require('../utils/pki');
const { linkSettings } = require('../utils/linkSettings');
const gatewayNodes = require('../services/gatewayNodes');
const YAML = require('yaml');
const { DictionaryField, DictionaryObject } = require('../models');
const { FIELD_TYPES, ITEM_TYPES, describeSchema, isOpenApi31, renderField } = require('../utils/dictionary');
const { schemaUsage } = require('../utils/schemaDesign');
const { describeOperation, describeComponents, contentAt, sameContent, PARAMETER_LOCATIONS } = require('../utils/openapiDesign');
const { componentStatus } = require('../utils/dictionarySync');
const { loadDictionary, apiUsage } = require('../services/dictionary');
const { serializeField, fieldUsage, objectResponse } = require('../controllers/dictionaryController');

const notFound = (req, res, heading, message) => res.status(404).render('error.html', {
  user: req.user,
  status: 404,
  heading,
  message,
});

const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

router.use(noStore);

const orgWhere = (req, extra = {}) => ({ organizationId: req.user.organizationId, ...extra });


// ---------------------------------------------------------------- Organization

router.get('/organization', async (req, res) => {
  const hasOrganization = Boolean(req.user.organizationId);
  const isOrgAdmin = hasOrganization && req.user.orgRole === 'admin';
  const [organization, memberships, invitations] = await Promise.all([
    hasOrganization ? Organization.findByPk(req.user.organizationId) : null,
    hasOrganization
      ? Membership.findAll({
        where: orgWhere(req),
        include: [{ association: 'user', attributes: ['id', 'name', 'email', 'isVerified'] }],
        order: [['createdAt', 'ASC']],
      })
      : [],
    isOrgAdmin
      ? Invitation.findAll({ where: orgWhere(req, { acceptedAt: null }), order: [['createdAt', 'DESC']] })
      : [],
  ]);

  res.render('organization.html', {
    user: req.user,
    organization,
    members: memberships.filter((membership) => membership.user).map((membership) => ({
      id: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      isVerified: membership.user.isVerified,
      orgRole: membership.role,
      joinedAt: membership.createdAt,
    })),
    invitations,
    isOrgAdmin,
    canCreateOrganizations: canCreateOrganizations(req.user),
    mailConfigured: isMailConfigured(),
  });
});

// -------------------------------------------------------------------- Catalogs

// Admins see every catalog with what it holds; members see the published products in each.
router.get('/catalogs', requireOrganization, async (req, res) => {
  const isOrgAdmin = req.user.orgRole === 'admin';
  const catalogs = await Catalog.findAll({
    where: orgWhere(req),
    include: [
      { association: 'products', attributes: ['id', 'name', 'status', 'description'] },
      { association: 'apis', attributes: ['id', 'name'] },
      ...(isOrgAdmin ? [{ association: 'gateways', include: [{ association: 'nodes', attributes: ['id', 'lastSeenAt', 'mode', 'url', 'lastPushStatus', 'lastError'] }] }] : []),
    ],
    order: [['name', 'ASC']],
  });
  const pending = isOrgAdmin
    ? await Subscription.count({ where: { status: 'pending' }, include: [{ association: 'product', attributes: [], where: orgWhere(req) }] })
    : 0;

  res.render('catalogs.html', {
    user: req.user,
    isOrgAdmin,
    pending,
    catalogs: catalogs.map((catalog) => {
      const published = catalog.products.filter((product) => product.status === 'published');
      return {
        id: catalog.id,
        name: catalog.name,
        description: catalog.description,
        products: isOrgAdmin ? catalog.products.length : published.length,
        published: published.length,
        apis: catalog.apis.length,
        productNames: (isOrgAdmin ? catalog.products : published).map((product) => product.name).sort(),
        gateways: isOrgAdmin ? catalog.gateways.map((gateway) => ({ id: gateway.id, name: gateway.name, running: isRecentlySeen(gateway) })) : [],
      };
    }),
  });
});

const findOrgCatalog = (req, id = req.params.id) => Catalog.findOne({ where: orgWhere(req, { id }) });

router.get('/catalogs/:id', requireOrganization, async (req, res) => {
  const catalog = await findOrgCatalog(req);
  if (!catalog) {
    return notFound(req, res, 'Catalog not found', "This catalog doesn't exist or belongs to another organization.");
  }

  // Members: the published products of this catalog and the APIs in them.
  if (req.user.orgRole !== 'admin') {
    const products = await ApiProduct.findAll({
      where: orgWhere(req, { catalogId: catalog.id, status: 'published' }),
      include: [{ association: 'apis', attributes: ['id', 'name', 'version', 'description', 'spec'], through: { attributes: [] } }],
      order: [['name', 'ASC']],
    });
    return res.render('catalog-browse.html', {
      user: req.user,
      catalog,
      products: products.map((product) => ({
        ...serializeProduct(product),
        apis: product.apis.map((api) => ({
          id: api.id,
          name: api.name,
          version: api.version,
          description: api.description,
          operations: listOperations(api.spec).length,
        })),
      })),
    });
  }

  const [products, apis, pendingCounts, attached, otherGateways] = await Promise.all([
    ApiProduct.findAll({ where: orgWhere(req, { catalogId: catalog.id }), include: [apisInclude], order: [['name', 'ASC']] }),
    Api.findAll({
      where: orgWhere(req, { catalogId: catalog.id }),
      include: [{ association: 'products', attributes: ['id', 'name', 'status'], through: { attributes: [] } }],
      order: [['name', 'ASC']],
    }),
    countPendingByProduct(req.user.organizationId),
    Gateway.findAll({ where: orgWhere(req, { catalogId: catalog.id }), include: gatewayIncludes, order: [['name', 'ASC']] }),
    Gateway.findAll({
      where: orgWhere(req, { [Op.or]: [{ catalogId: null }, { catalogId: { [Op.ne]: catalog.id } }] }),
      include: [
        { association: 'nodes', attributes: ['id', 'lastSeenAt', 'mode', 'url', 'lastPushStatus', 'lastError'] },
        { association: 'handlers', attributes: ['id'] },
        { association: 'catalog', attributes: ['id', 'name'] },
      ],
      order: [['name', 'ASC']],
    }),
  ]);
  const gateways = [];
  for (const gateway of attached) gateways.push(await describeGateway(gateway));

  res.render('catalog-detail.html', {
    user: req.user,
    catalog,
    products: products.map((product) => ({ ...serializeProduct(product), pendingCount: pendingCounts.get(product.id) || 0 })),
    apis: apis.map((api) => serializeApi(api)),
    gateways,
    availableGateways: otherGateways.map((gateway) => ({
      id: gateway.id,
      name: gateway.name,
      nodes: gateway.nodes.length,
      running: isRecentlySeen(gateway),
      setup: gatewaySetup(gateway),
      catalog: gateway.catalog ? { id: gateway.catalog.id, name: gateway.catalog.name } : null,
    })),
  });
});

router.get('/catalogs/:id/apis/new', requireOrgAdmin, async (req, res) => {
  const catalog = await findOrgCatalog(req);
  if (!catalog) return notFound(req, res, 'Catalog not found', "This catalog doesn't exist or belongs to another organization.");
  res.render('api-new.html', { user: req.user, catalog, methods: HTTP_METHODS });
});

router.get('/catalogs/:id/apis/import', requireOrgAdmin, async (req, res) => {
  const catalog = await findOrgCatalog(req);
  if (!catalog) return notFound(req, res, 'Catalog not found', "This catalog doesn't exist or belongs to another organization.");
  res.render('api-import.html', { user: req.user, catalog });
});

// ------------------------------------------------------- APIs and products (in a catalog)

// The old organization-wide lists now live inside each catalog.
router.get(['/apis', '/apis/new', '/apis/import', '/products', '/catalog'], requireOrganization, (req, res) => {
  res.redirect('/developer/catalogs');
});

const catalogInclude = { association: 'catalog', attributes: ['id', 'name'] };

router.get('/apis/:id', requireOrgAdmin, async (req, res) => {
  const api = await Api.findOne({
    where: orgWhere(req, { id: req.params.id }),
    include: [{ association: 'products', attributes: ['id', 'name', 'status'], through: { attributes: [] } }, catalogInclude],
  });
  if (!api) {
    return notFound(req, res, 'API not found', "This API doesn't exist or belongs to another organization.");
  }
  const [policies, connections, policy] = await Promise.all([
    Policy.findAll({ where: orgWhere(req), attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    Connection.findAll({ where: orgWhere(req), attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    api.policyId ? Policy.findOne({ where: orgWhere(req, { id: api.policyId }), attributes: ['id', 'flow'] }) : null,
  ]);
  res.render('api-detail.html', {
    user: req.user,
    api: serializeApi(api, { withOperations: true }),
    methods: HTTP_METHODS,
    policies: policies.map((item) => ({ id: item.id, name: item.name })),
    // Only an Invoke step for "the API's backend" without its own URL uses the OpenAPI server URL.
    callsBackend: Boolean(policy && usesBackend(policy.flow)),
    policyId: api.policyId || null,
    connections,
  });
});

// ------------------------------------------------------------- API designer

const findDesignApi = (req) => Api.findOne({ where: orgWhere(req, { id: req.params.id }), include: [catalogInclude] });

// Fields and objects for the designer's pickers.
const dictionaryChoices = (dictionary) => ({
  fields: [...dictionary.fields.values()].map((field) => ({ id: field.id, name: field.name, summary: describeSchema(field.schema), type: field.schema.type })),
  objects: [...dictionary.objects.values()].map((object) => ({ id: object.id, name: object.name, propertyCount: object.properties.length })),
});

router.get('/apis/:id/design', requireOrgAdmin, async (req, res) => {
  const api = await findDesignApi(req);
  if (!api) {
    return notFound(req, res, 'API not found', "This API doesn't exist or belongs to another organization.");
  }
  const operations = listOperations(api.spec);
  const wanted = operations.find((operation) => operation.method === req.query.method && operation.path === req.query.path);
  const selected = wanted || operations[0] || null;
  const dictionary = await loadDictionary(req.user.organizationId);
  const sync = componentStatus(api.spec, dictionary);
  res.render('api-design.html', {
    user: req.user,
    api: serializeApi(api, { withOperations: true }),
    operation: selected ? describeOperation(api.spec, selected) : null,
    components: describeComponents(api.spec).map((component) => ({ ...component, status: sync.status[component.name] || null })),
    sync,
    dictionary: dictionaryChoices(dictionary),
    fieldNames: Object.fromEntries([...dictionary.fields.values()].map((field) => [field.id, field.name])),
    locations: PARAMETER_LOCATIONS,
    fieldTypes: FIELD_TYPES,
    itemTypes: ITEM_TYPES,
  });
});

// One request body or response schema of an operation, in the schema editor.
router.get('/apis/:id/design/schema', requireOrgAdmin, async (req, res) => {
  const api = await findDesignApi(req);
  if (!api) {
    return notFound(req, res, 'API not found', "This API doesn't exist or belongs to another organization.");
  }
  const operation = listOperations(api.spec).find((item) => item.method === req.query.method && item.path === req.query.path);
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
  const contentType = typeof req.query.contentType === 'string' ? req.query.contentType : '';
  const found = operation && contentType ? contentAt(api.spec, operation, { status, contentType }) : { error: true };
  if (found.error) {
    return notFound(req, res, 'Schema not found', "This endpoint doesn't have that body or response.");
  }
  const { spec } = api;
  const openapi31 = isOpenApi31(spec);
  const dictionary = await loadDictionary(req.user.organizationId);
  const field = found.fieldId ? dictionary.fields.get(found.fieldId) || null : null;
  const designUrl = `/developer/apis/${api.id}/design?method=${operation.method}&path=${encodeURIComponent(operation.path)}`;
  const query = new URLSearchParams({ method: operation.method, path: operation.path, contentType, ...(status && { status }) });
  res.render('api-content-schema.html', {
    user: req.user,
    api: serializeApi(api, { withOperations: true }),
    operation,
    status,
    contentType,
    designUrl,
    linkedField: field ? { id: field.id, name: field.name, current: sameContent(renderField(field, { openapi31 }), found.schema) } : null,
    state: {
      saveUrl: `/api/org/apis/${api.id}/operations/content-schema?${query}`,
      designUrl,
      pageUrl: `/developer/apis/${api.id}/schemas`,
      name: status ? `${status} response` : 'Request body',
      openapi31,
      schema: found.schema,
      schemas: spec.components?.schemas && typeof spec.components.schemas === 'object' ? spec.components.schemas : {},
      fields: [...dictionary.fields.values()].map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        summary: describeSchema(item.schema),
        schema: renderField(item, { openapi31, withDescription: true }),
      })),
      objects: [...dictionary.objects.values()].map((object) => ({ id: object.id, name: object.name, propertyCount: object.properties.length })),
    },
    fieldTypes: FIELD_TYPES,
    itemTypes: ITEM_TYPES,
  });
});

router.get('/apis/:id/schemas', requireOrgAdmin, async (req, res) => {
  const api = await findDesignApi(req);
  if (!api) {
    return notFound(req, res, 'API not found', "This API doesn't exist or belongs to another organization.");
  }
  const { spec } = api;
  const schemas = spec.components?.schemas && typeof spec.components.schemas === 'object' ? spec.components.schemas : {};
  const names = Object.keys(schemas);
  const selected = names.includes(req.query.name) ? req.query.name : names.sort((a, b) => a.localeCompare(b))[0] || null;
  const dictionary = await loadDictionary(req.user.organizationId);
  const sync = componentStatus(spec, dictionary);
  const openapi31 = isOpenApi31(spec);
  res.render('api-schemas.html', {
    user: req.user,
    api: serializeApi(api, { withOperations: true }),
    list: describeComponents(spec).map((component) => ({ ...component, status: sync.status[component.name] || null })),
    selected,
    usage: selected ? schemaUsage(spec, selected) : [],
    dictionaryObject: selected && schemas[selected]?.['x-dictionary-id'] ? dictionary.objects.get(schemas[selected]['x-dictionary-id']) || null : null,
    // Everything the editor works with in the browser.
    state: {
      apiUrl: `/api/org/apis/${api.id}`,
      pageUrl: `/developer/apis/${api.id}/schemas`,
      openapi31,
      selected,
      schemas,
      fields: [...dictionary.fields.values()].map((field) => ({
        id: field.id,
        name: field.name,
        description: field.description,
        summary: describeSchema(field.schema),
        schema: renderField(field, { openapi31, withDescription: true }),
      })),
      objects: [...dictionary.objects.values()].map((object) => ({ id: object.id, name: object.name, propertyCount: object.properties.length })),
    },
    fieldTypes: FIELD_TYPES,
    itemTypes: ITEM_TYPES,
  });
});

router.get('/apis/:id/source', requireOrgAdmin, async (req, res) => {
  const api = await findDesignApi(req);
  if (!api) {
    return notFound(req, res, 'API not found', "This API doesn't exist or belongs to another organization.");
  }
  const format = req.query.format === 'yaml' ? 'yaml' : 'json';
  res.render('api-source.html', {
    user: req.user,
    api: serializeApi(api, { withOperations: true }),
    format,
    content: format === 'yaml' ? YAML.stringify(api.spec, { lineWidth: 0, aliasDuplicateObjects: false }) : JSON.stringify(api.spec, null, 2),
    updatedAt: new Date(api.updatedAt).toISOString(),
  });
});

// ------------------------------------------------------------ Data dictionary

router.get('/dictionary', requireOrgAdmin, async (req, res) => {
  const view = req.query.view === 'objects' ? 'objects' : 'fields';
  const [dictionary, usage, apis] = await Promise.all([
    loadDictionary(req.user.organizationId),
    apiUsage(req.user.organizationId),
    Api.findAll({ where: orgWhere(req), attributes: ['id', 'name', 'version'], order: [['name', 'ASC']] }),
  ]);
  const apiNames = new Map(apis.map((api) => [api.id, api.name]));
  const objects = [...dictionary.objects.values()];
  const fieldObjects = new Map();
  for (const object of objects) {
    for (const property of object.properties) {
      if (!property.fieldId) continue;
      if (!fieldObjects.has(property.fieldId)) fieldObjects.set(property.fieldId, new Set());
      fieldObjects.get(property.fieldId).add(object.id);
    }
  }
  res.render('dictionary.html', {
    user: req.user,
    view,
    fields: [...dictionary.fields.values()].map((field) => ({
      id: field.id,
      name: field.name,
      description: field.description,
      summary: describeSchema(field.schema),
      sourceApi: field.sourceApiId ? apiNames.get(field.sourceApiId) || null : null,
      objectCount: fieldObjects.get(field.id)?.size || 0,
      apiCount: usage.fields.get(field.id)?.length || 0,
    })),
    objects: objects.map((object) => ({
      id: object.id,
      name: object.name,
      description: object.description,
      propertyCount: object.properties.length,
      propertyNames: object.properties.slice(0, 6).map((property) => property.name),
      sourceApi: object.sourceApiId ? apiNames.get(object.sourceApiId) || null : null,
      apiCount: usage.objects.get(object.id)?.length || 0,
    })),
    apis: apis.map((api) => ({ id: api.id, name: api.name, version: api.version })),
    fieldTypes: FIELD_TYPES,
    itemTypes: ITEM_TYPES,
  });
});

const sourceApiOf = async (req, record) => (record.sourceApiId
  ? Api.findOne({ where: orgWhere(req, { id: record.sourceApiId }), attributes: ['id', 'name'] })
  : null);

router.get('/dictionary/fields/:id', requireOrgAdmin, async (req, res) => {
  const field = await DictionaryField.findOne({ where: orgWhere(req, { id: req.params.id }) });
  if (!field) {
    return notFound(req, res, 'Field not found', "This field isn't in your organization's dictionary.");
  }
  const dictionary = await loadDictionary(req.user.organizationId);
  res.render('dictionary-field.html', {
    user: req.user,
    field: serializeField(field, await fieldUsage(req, field)),
    // Other fields, whose rules the structure editor can copy into a property.
    editorFields: [...dictionary.fields.values()].filter((other) => other.id !== field.id).map((other) => ({
      id: other.id,
      name: other.name,
      description: other.description,
      summary: describeSchema(other.schema),
      schema: renderField(other),
    })),
    sourceApi: await sourceApiOf(req, field),
    fieldTypes: FIELD_TYPES,
    itemTypes: ITEM_TYPES,
  });
});

router.get('/dictionary/objects/:id', requireOrgAdmin, async (req, res) => {
  const object = await DictionaryObject.findOne({ where: orgWhere(req, { id: req.params.id }) });
  if (!object) {
    return notFound(req, res, 'Object not found', "This object isn't in your organization's dictionary.");
  }
  res.render('dictionary-object.html', {
    user: req.user,
    object: (await objectResponse(req, object.id)).object,
    sourceApi: await sourceApiOf(req, object),
    choices: dictionaryChoices(await loadDictionary(req.user.organizationId)),
    fieldTypes: FIELD_TYPES,
    itemTypes: ITEM_TYPES,
  });
});

router.get('/products/:id', requireOrgAdmin, async (req, res) => {
  const product = await ApiProduct.findOne({
    where: orgWhere(req, { id: req.params.id }),
    include: [apisInclude, catalogInclude],
  });
  if (!product) {
    return notFound(req, res, 'Product not found', "This product doesn't exist or belongs to another organization.");
  }

  const includedIds = product.apis.map((api) => api.id);
  const [availableApis, subscriptions, usage] = await Promise.all([
    // Only APIs of the product's own catalog can be added.
    Api.findAll({
      where: orgWhere(req, {
        catalogId: product.catalogId,
        ...(includedIds.length && { id: { [Op.notIn]: includedIds } }),
      }),
      attributes: ['id', 'name', 'version'],
      order: [['name', 'ASC']],
    }),
    Subscription.findAll({
      where: { productId: product.id },
      include: subscriptionIncludes(req.user.organizationId),
      order: [['createdAt', 'DESC']],
    }),
    usageSeries({ productId: product.id, organizationId: req.user.organizationId }),
  ]);

  res.render('product-detail.html', {
    user: req.user,
    product: serializeProduct(product),
    usage,
    availableApis,
    subscriptions: subscriptions.map(serializeSubscription),
    periods: RATE_LIMIT_PERIODS,
    currencies: CURRENCIES,
  });
});

// Access requests waiting for the organization's admins, across its catalogs.
router.get('/requests', requireOrgAdmin, async (req, res) => {
  const [pendingRequests, recent] = await Promise.all([
    Subscription.findAll({
      where: { status: 'pending' },
      include: subscriptionIncludes(req.user.organizationId),
      order: [['createdAt', 'ASC']],
    }),
    Subscription.findAll({
      where: { status: { [Op.ne]: 'pending' } },
      include: subscriptionIncludes(req.user.organizationId),
      order: [['decidedAt', 'DESC']],
      limit: 20,
    }),
  ]);
  res.render('requests.html', {
    user: req.user,
    pendingRequests: pendingRequests.map(serializeSubscription),
    recentRequests: recent.map(serializeSubscription),
  });
});

// ------------------------------------------------- A published product (members subscribe here)

router.get('/catalog/:id', requireOrganization, async (req, res) => {
  const product = await findPublishedProduct(req.params.id, req.user.organizationId, true);
  if (!product) {
    return notFound(req, res, 'Product not found', 'This product is not published in your organization\'s catalogs.');
  }

  const [applications, subscriptions, gateways] = await Promise.all([
    // Applications of this organization can subscribe.
    Application.findAll({ where: { userId: req.user.id, organizationId: req.user.organizationId }, attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    Subscription.findAll({
      where: { productId: product.id },
      include: [{ association: 'application', attributes: ['id', 'name', 'clientId'], where: { userId: req.user.id } }],
    }),
    // The gateway serving the product's catalog, once it has been deployed.
    product.catalogId
      ? Gateway.findAll({ where: { catalogId: product.catalogId, lastPushedAt: { [Op.ne]: null } }, order: [['name', 'ASC']] })
      : [],
  ]);

  res.render('catalog-product.html', {
    user: req.user,
    deployments: gateways.map((gateway) => ({ name: gateway.name, publicUrl: gateway.publicUrl })),
    tokenUrl: `${req.protocol}://${req.get('host')}/oauth/token`,
    product: {
      ...serializeProduct(product),
      apis: product.apis.map((api) => ({
        id: api.id,
        name: api.name,
        version: api.version,
        description: api.description,
        baseUrl: api.baseUrl,
        basePath: api.basePath,
        operations: listOperations(api.spec),
      })),
    },
    applications,
    subscriptions: subscriptions.map(serializeSubscription),
  });
});

// ----------------------------------------------------------------- Connections

router.get('/connections', requireOrgAdmin, async (req, res) => {
  const connections = await Connection.findAll({
    where: orgWhere(req),
    include: [{ association: 'apis', attributes: ['id', 'name'] }],
    order: [['name', 'ASC']],
  });
  res.render('connections.html', { user: req.user, connections: connections.map(serializeConnection) });
});

router.get('/connections/:id', requireOrgAdmin, async (req, res) => {
  const connection = await Connection.findOne({
    where: orgWhere(req, { id: req.params.id }),
    include: [{ association: 'apis', attributes: ['id', 'name', 'basePath'] }],
  });
  if (!connection) {
    return notFound(req, res, 'Connection not found', "This connection doesn't exist or belongs to another organization.");
  }
  res.render('connection-detail.html', { user: req.user, connection: serializeConnection(connection) });
});

// -------------------------------------------------------------------- Policies

const policyUsers = [
  { association: 'apis', attributes: ['id', 'name', 'basePath', 'baseUrl'] },
  { association: 'handlers', attributes: ['id', 'name', 'port'], include: [{ association: 'gateway', attributes: ['id', 'name', 'organizationId'] }] },
];
const portsOf = (req, policy) => (policy.handlers || [])
  .filter((handler) => handler.gateway && handler.gateway.organizationId === req.user.organizationId)
  .map((handler) => ({ id: handler.id, name: handler.name, port: handler.port, gatewayId: handler.gateway.id, gateway: handler.gateway.name }));

router.get('/policies', requireOrgAdmin, async (req, res) => {
  const policies = await Policy.findAll({ where: orgWhere(req), include: policyUsers, order: [['name', 'ASC']] });
  res.render('policies.html', {
    user: req.user,
    policies: policies.map((policy) => ({ ...serializePolicy(policy), ports: portsOf(req, policy) })),
  });
});

router.get('/policies/:id', requireOrgAdmin, async (req, res) => {
  const policy = await Policy.findOne({ where: orgWhere(req, { id: req.params.id }), include: policyUsers });
  if (!policy) {
    return notFound(req, res, 'Policy not found', "This policy doesn't exist or belongs to another organization.");
  }
  const [connections, apis] = await Promise.all([
    Connection.findAll({ where: orgWhere(req), attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    Api.findAll({ where: orgWhere(req), attributes: ['id', 'name', 'basePath', 'baseUrl', 'policyId'], order: [['name', 'ASC']] }),
  ]);
  const hasBackend = (api) => {
    try {
      return ['http:', 'https:'].includes(new URL(api.baseUrl).protocol);
    } catch {
      return false;
    }
  };
  // New Invoke steps start with the backend URL of the API that owns the policy (or the only API using it).
  const owner = apis.find((api) => api.id === policy.ownerApiId) || (apis.filter((api) => api.policyId === policy.id).length === 1 ? apis.find((api) => api.policyId === policy.id) : null);
  res.render('policy-detail.html', {
    user: req.user,
    backendUrl: owner && hasBackend(owner) ? owner.baseUrl : '',
    policy: { ...serializePolicy(policy, { problems: await problemsOf(req, policy.flow) }), ports: portsOf(req, policy) },
    usesBackend: usesBackend(policy.flow),
    connections: connections.map((connection) => ({ id: connection.id, name: connection.name })),
    // For the test panel: the APIs a test can run as (their backend URL is used by Invoke steps).
    apis: apis.map((api) => ({ id: api.id, name: api.name, basePath: api.basePath, hasBackend: hasBackend(api), usesThis: api.policyId === policy.id })),
    defaultScript: DEFAULT_SCRIPT,
    conditionSources: CONDITION_SOURCES,
    operators: OPERATORS,
    methods: METHODS,
  });
});

// -------------------------------------------------------------------- Gateways

const findOrgGateway = (req) => Gateway.findOne({
  where: orgWhere(req, { id: req.params.id }),
  include: gatewayIncludes,
});

router.get('/gateways', requireOrgAdmin, async (req, res) => {
  const [gateways, pki] = await Promise.all([
    Gateway.findAll({ where: orgWhere(req), include: gatewayIncludes, order: [['name', 'ASC']] }),
    getPki(),
  ]);
  const described = [];
  for (const gateway of gateways) {
    const setup = gatewaySetup(gateway);
    described.push({ ...(await describeGateway(gateway)), running: setup.running, setup });
  }
  res.render('gateways.html', { user: req.user, gateways: described, ca: pki.ca });
});

router.get('/gateways/:id', requireOrgAdmin, async (req, res) => {
  const gateway = await findOrgGateway(req);
  if (!gateway) {
    return notFound(req, res, 'Gateway not found', "This gateway doesn't exist or belongs to another organization.");
  }
  const [catalogs, policies, pki, usage, described] = await Promise.all([
    Catalog.findAll({ where: orgWhere(req), attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    Policy.findAll({ where: orgWhere(req), attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    getPki(),
    usageSeries({ gatewayId: gateway.id }),
    describeGateway(gateway),
  ]);
  const link = linkSettings();
  const linkInfo = { enabled: link.enabled, url: link.publicUrl };
  // The setup checklist starts the first node that never connected, or a new one.
  const waiting = described.nodes.find((node) => !node.lastSeenAt && gatewayNodes.isPull(node));
  const nextName = gatewayNodes.nextNodeName(described);
  const sameHost = described.nodes.length ? gatewayNodes.nodeHost(described, described.nodes[0]) : gatewayNodes.nodeHost(described, {});
  const nodeTools = {
    credentialsFile: gatewayNodes.credentialsFileOf(described),
    dockerLinkUrl: gatewayNodes.dockerLinkUrlOf(linkInfo.url),
    firstCommands: gatewayNodes.runCommands(described, waiting || { name: nextName, mode: 'pull', portOffset: 0 }, linkInfo, { idPrefix: 'setup-command' }),
    // The first node started for the console to connect to (push): no console address, port 9443 published.
    pushCommands: gatewayNodes.runCommands(described, { name: nextName, mode: 'push', url: 'https://node', portOffset: 0 }, linkInfo, { idPrefix: 'setup-push-command' }),
    linkLocal: gatewayNodes.isLocalUrl(linkInfo.url),
    nodeCommands: Object.fromEntries(described.nodes.map((node) => [node.id, gatewayNodes.runCommands(described, node, linkInfo, { idPrefix: `node-command-${node.id}` })])),
    nextNode: { name: nextName, sameHost, sameHostOffset: gatewayNodes.nextPortOffset(described, sameHost, { pull: true }) },
  };
  res.render('gateway-detail.html', {
    user: req.user,
    nodeTools,
    gateway: { ...described, running: isRecentlySeen(gateway), setup: gatewaySetup(gateway) },
    catalogs,
    policies,
    ca: pki.ca,
    usage,
    link: { enabled: link.enabled, url: link.publicUrl },
  });
});

router.get('/gateways/:id/requests', requireOrgAdmin, async (req, res) => {
  const gateway = await findOrgGateway(req);
  if (!gateway) {
    return notFound(req, res, 'Gateway not found', "This gateway doesn't exist or belongs to another organization.");
  }
  const apis = gateway.catalogId
    ? await Api.findAll({ where: orgWhere(req, { catalogId: gateway.catalogId }), attributes: ['name'], order: [['name', 'ASC']] })
    : [];
  res.render('gateway-requests.html', {
    user: req.user,
    gateway: { id: gateway.id, name: gateway.name, nodes: gateway.nodes.length, requestLog: gateway.observability.requestLog },
    apiNames: apis.map((api) => api.name),
  });
});

module.exports = router;
