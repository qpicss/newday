const { ApiProduct, Application, Catalog, Subscription } = require('../models');
const { sendServerError } = require('../utils/http');
const { listOperations } = require('../utils/openapi');
const { serializeProduct, serializeSubscription } = require('./productController');
const { scheduleAutoPush } = require('../services/autoPush');

const catalogIncludes = (withSpecs = false) => [
  { association: 'organization', attributes: ['id', 'name'] },
  { association: 'catalog', attributes: ['id', 'name'] },
  {
    association: 'apis',
    attributes: withSpecs
      ? ['id', 'name', 'version', 'description', 'baseUrl', 'basePath', 'spec']
      : ['id', 'name', 'version'],
    through: { attributes: [] },
  },
];

// Members only see the organization they are working in.
const findPublishedProduct = (id, organizationId, withSpecs = false) => ApiProduct.findOne({
  where: { id, status: 'published', organizationId: organizationId || null },
  include: catalogIncludes(withSpecs),
});

// The selected organization's catalogs with their published products (?catalogId= narrows it to one).
const listCatalog = async (req, res) => {
  try {
    const organizationId = req.user.organizationId || null;
    const catalogFilter = typeof req.query.catalogId === 'string' ? { id: req.query.catalogId } : {};
    const [catalogs, products] = await Promise.all([
      Catalog.findAll({ where: { organizationId, ...catalogFilter }, attributes: ['id', 'name', 'description'], order: [['name', 'ASC']] }),
      ApiProduct.findAll({
        where: {
          status: 'published',
          organizationId,
          ...(catalogFilter.id && { catalogId: catalogFilter.id }),
        },
        include: catalogIncludes(),
        order: [['name', 'ASC']],
      }),
    ]);
    res.json({
      catalogs: catalogs.map((catalog) => ({
        id: catalog.id,
        name: catalog.name,
        description: catalog.description,
        productCount: products.filter((product) => product.catalogId === catalog.id).length,
      })),
      products: products.map(serializeProduct),
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to load the catalog');
  }
};

// One published product with its APIs and endpoints, plus the caller's own subscriptions to it.
const getCatalogProduct = async (req, res) => {
  try {
    const product = await findPublishedProduct(req.params.id, req.user.organizationId, true);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const subscriptions = await Subscription.findAll({
      where: { productId: product.id },
      include: [{ association: 'application', attributes: ['id', 'name', 'clientId'], where: { userId: req.user.id } }],
    });

    res.json({
      product: {
        ...serializeProduct(product),
        apis: product.apis.map((api) => ({
          id: api.id,
          name: api.name,
          version: api.version,
          description: api.description,
          baseUrl: api.baseUrl,
          operations: listOperations(api.spec),
        })),
      },
      subscriptions: subscriptions.map(serializeSubscription),
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to load product');
  }
};

const findOwnApplication = (req) => Application.findOne({
  where: { id: req.params.id, userId: req.user.id },
});

const subscriptionView = (subscriptionId) => Subscription.findByPk(subscriptionId, {
  include: [{
    association: 'product',
    attributes: ['id', 'name'],
    include: [{ association: 'organization', attributes: ['id', 'name'] }],
  }],
});

// An app owner asks for access; the product's organization admin decides. The application and the
// product must both belong to the organization the user is working in.
const requestSubscription = async (req, res) => {
  try {
    const application = await findOwnApplication(req);
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }
    const product = await findPublishedProduct(req.body?.productId ?? null, req.user.organizationId);
    if (!product) {
      return res.status(404).json({ error: 'This product is not available in your organization\'s catalogs' });
    }
    if (application.organizationId !== product.organizationId) {
      return res.status(400).json({ error: `${application.name} belongs to another organization. Create an application in this organization to use its products.` });
    }

    const existing = await Subscription.findOne({ where: { applicationId: application.id, productId: product.id } });
    if (existing && Subscription.ACTIVE_STATUSES.includes(existing.status)) {
      return res.status(409).json({
        error: existing.status === 'approved'
          ? `${application.name} already has access to ${product.name}`
          : `${application.name} is already waiting for approval`,
      });
    }

    // A rejected or revoked request can be made again.
    const fields = { status: 'pending', requestedById: req.user.id, decidedById: null, decidedAt: null };
    const subscription = existing
      ? await existing.update(fields)
      : await Subscription.create({ ...fields, applicationId: application.id, productId: product.id });

    res.status(201).json({ subscription: serializeSubscription(await subscriptionView(subscription.id)) });
  } catch (error) {
    sendServerError(res, error, 'Failed to request access');
  }
};

const listApplicationSubscriptions = async (req, res) => {
  try {
    const application = await findOwnApplication(req);
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }
    const subscriptions = await Subscription.findAll({
      where: { applicationId: application.id },
      include: [{
        association: 'product',
        attributes: ['id', 'name'],
        include: [{ association: 'organization', attributes: ['id', 'name'] }],
      }],
      order: [['createdAt', 'DESC']],
    });
    res.json({ subscriptions: subscriptions.map(serializeSubscription) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load subscriptions');
  }
};

// Withdraws a pending request or gives up approved access.
const cancelSubscription = async (req, res) => {
  try {
    const application = await findOwnApplication(req);
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }
    const subscription = await Subscription.findOne({
      where: { id: req.params.subscriptionId, applicationId: application.id },
      include: [{ association: 'product', attributes: ['organizationId'] }],
    });
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    await subscription.destroy();
    // Approved access is deployed on the publisher's gateways.
    if (subscription.status === 'approved') scheduleAutoPush(subscription.product?.organizationId);
    res.json({ message: 'Subscription cancelled' });
  } catch (error) {
    sendServerError(res, error, 'Failed to cancel subscription');
  }
};

module.exports = {
  findPublishedProduct,
  listCatalog,
  getCatalogProduct,
  requestSubscription,
  listApplicationSubscriptions,
  cancelSubscription,
};
