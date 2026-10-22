const sequelize = require('../config/database');
const { Api, ApiProduct, Catalog, ProductApi, Subscription } = require('../models');
const { sendServerError } = require('../utils/http');
const { optionalText } = require('../utils/validation');

const PRODUCT_STATUSES = ['draft', 'published'];
const RATE_LIMIT_PERIODS = ['second', 'minute', 'hour', 'day'];
const BILLING_PLANS = ['free', 'flat', 'usage'];
const BILLING_INTERVALS = ['month', 'year'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'INR'];
const MAX_PRICE = 1000000;

// What each decision may change a subscription from.
const DECISIONS = {
  approved: ['pending'],
  rejected: ['pending'],
  revoked: ['approved'],
};

const serializeProduct = (product) => ({
  id: product.id,
  name: product.name,
  description: product.description,
  status: product.status,
  catalogId: product.catalogId,
  ...(product.catalog && { catalog: { id: product.catalog.id, name: product.catalog.name } }),
  rateLimit: {
    enabled: product.rateLimitEnabled,
    requests: product.rateLimitRequests,
    period: product.rateLimitPeriod,
  },
  billing: {
    plan: product.billingPlan,
    priceCents: product.billingPriceCents,
    currency: product.billingCurrency,
    interval: product.billingInterval,
  },
  ...(product.apis && {
    apis: product.apis.map((api) => ({ id: api.id, name: api.name, version: api.version })),
  }),
  ...(product.organization && {
    organization: { id: product.organization.id, name: product.organization.name },
  }),
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
});

const serializeSubscription = (subscription) => ({
  id: subscription.id,
  status: subscription.status,
  createdAt: subscription.createdAt,
  decidedAt: subscription.decidedAt,
  ...(subscription.product && {
    product: {
      id: subscription.product.id,
      name: subscription.product.name,
      ...(subscription.product.organization && {
        organization: { id: subscription.product.organization.id, name: subscription.product.organization.name },
      }),
    },
  }),
  ...(subscription.application && {
    application: {
      id: subscription.application.id,
      name: subscription.application.name,
      clientId: subscription.application.clientId,
      ...(subscription.application.owner && {
        owner: {
          id: subscription.application.owner.id,
          name: subscription.application.owner.name,
          email: subscription.application.owner.email,
          organization: subscription.application.owner.organization
            ? { id: subscription.application.owner.organization.id, name: subscription.application.owner.organization.name }
            : null,
        },
      }),
    },
  }),
});

const toBoolean = (value) => value === true || value === 'true' || value === 'on';

// With partial = true only the provided fields are validated and returned.
const validateProductInput = (body = {}, { partial = false } = {}) => {
  const fields = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) return { error: 'Product name is required (max 255 characters)' };
    fields.name = name;
  }
  if (body.description !== undefined) {
    const { value, error } = optionalText(body.description, 'Description', 5000);
    if (error) return { error };
    fields.description = value;
  }
  if (body.status !== undefined) {
    if (!PRODUCT_STATUSES.includes(body.status)) return { error: 'Status must be "draft" or "published"' };
    fields.status = body.status;
  }

  if (body.rateLimitEnabled !== undefined) {
    fields.rateLimitEnabled = toBoolean(body.rateLimitEnabled);
  }
  if (body.rateLimitRequests !== undefined) {
    const requests = Number(body.rateLimitRequests);
    if (!Number.isInteger(requests) || requests < 1 || requests > 1000000000) {
      return { error: 'Rate limit must be a whole number of requests between 1 and 1,000,000,000' };
    }
    fields.rateLimitRequests = requests;
  }
  if (body.rateLimitPeriod !== undefined) {
    if (!RATE_LIMIT_PERIODS.includes(body.rateLimitPeriod)) return { error: 'Rate limit period must be second, minute, hour or day' };
    fields.rateLimitPeriod = body.rateLimitPeriod;
  }

  if (body.billingPlan !== undefined) {
    if (!BILLING_PLANS.includes(body.billingPlan)) return { error: 'Billing plan must be free, flat or usage' };
    fields.billingPlan = body.billingPlan;
  }
  if (body.billingPrice !== undefined) {
    const price = Number(body.billingPrice);
    if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE) {
      return { error: `Price must be a number between 0 and ${MAX_PRICE.toLocaleString('en-US')}` };
    }
    fields.billingPriceCents = Math.round(price * 100);
  }
  if (body.billingCurrency !== undefined) {
    if (!CURRENCIES.includes(body.billingCurrency)) return { error: `Currency must be one of ${CURRENCIES.join(', ')}` };
    fields.billingCurrency = body.billingCurrency;
  }
  if (body.billingInterval !== undefined) {
    if (!BILLING_INTERVALS.includes(body.billingInterval)) return { error: 'Billing interval must be month or year' };
    fields.billingInterval = body.billingInterval;
  }
  if (fields.billingPlan === 'free') {
    fields.billingPriceCents = 0;
  }
  if ((fields.billingPlan === 'flat' || fields.billingPlan === 'usage') && body.billingPrice !== undefined && fields.billingPriceCents === 0) {
    return { error: 'Paid plans need a price greater than 0' };
  }
  return { fields };
};

const apisInclude = { association: 'apis', attributes: ['id', 'name', 'version'], through: { attributes: [] } };

const findOrgProduct = (req, options = {}) => ApiProduct.findOne({
  where: { id: req.params.id, organizationId: req.user.organizationId },
  ...options,
});

const listProducts = async (req, res) => {
  try {
    const products = await ApiProduct.findAll({
      where: {
        organizationId: req.user.organizationId,
        ...(typeof req.query.catalogId === 'string' && { catalogId: req.query.catalogId }),
      },
      include: [apisInclude],
      order: [['name', 'ASC']],
    });
    res.json({ products: products.map(serializeProduct) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load products');
  }
};

const createProduct = async (req, res) => {
  try {
    const { fields, error } = validateProductInput(req.body);
    if (error) {
      return res.status(400).json({ error });
    }
    // New products always start as drafts: they need at least one API before publishing.
    delete fields.status;
    if (fields.billingPlan && fields.billingPlan !== 'free' && !fields.billingPriceCents) {
      return res.status(400).json({ error: 'Paid plans need a price greater than 0' });
    }
    const catalog = typeof req.body?.catalogId === 'string' && req.body.catalogId
      ? await Catalog.findOne({ where: { id: req.body.catalogId, organizationId: req.user.organizationId } })
      : null;
    if (!catalog) {
      return res.status(400).json({ error: 'Choose the catalog the product belongs to' });
    }
    const product = await ApiProduct.create({ ...fields, organizationId: req.user.organizationId, catalogId: catalog.id });
    product.apis = [];
    res.status(201).json({ product: serializeProduct(product) });
  } catch (error) {
    sendServerError(res, error, 'Failed to create product');
  }
};

const getProduct = async (req, res) => {
  try {
    const product = await findOrgProduct(req, { include: [apisInclude] });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ product: serializeProduct(product) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load product');
  }
};

const updateProduct = async (req, res) => {
  try {
    const product = await findOrgProduct(req, { include: [apisInclude] });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const { fields, error } = validateProductInput(req.body, { partial: true });
    if (error) {
      return res.status(400).json({ error });
    }
    if (fields.status === 'published' && product.apis.length === 0) {
      return res.status(400).json({ error: 'Add at least one API before publishing this product' });
    }
    const plan = fields.billingPlan || product.billingPlan;
    const priceCents = fields.billingPriceCents ?? product.billingPriceCents;
    if (plan !== 'free' && priceCents === 0) {
      return res.status(400).json({ error: 'Paid plans need a price greater than 0' });
    }

    await product.update(fields);
    res.json({ product: serializeProduct(product) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update product');
  }
};

const deleteProduct = async (req, res) => {
  try {
    const product = await findOrgProduct(req);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    await sequelize.transaction(async (transaction) => {
      await ProductApi.destroy({ where: { productId: product.id }, transaction });
      await Subscription.destroy({ where: { productId: product.id }, transaction });
      await product.destroy({ transaction });
    });
    res.json({ message: 'Product deleted' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete product');
  }
};

// Only APIs from the product's own catalog can be added.
const addProductApi = async (req, res) => {
  try {
    const product = await findOrgProduct(req);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const api = await Api.findOne({
      where: { id: req.body?.apiId ?? null, organizationId: req.user.organizationId },
    });
    if (!api) {
      return res.status(400).json({ error: 'Choose one of your organization\'s APIs' });
    }
    if (api.catalogId !== product.catalogId) {
      return res.status(400).json({ error: `${api.name} belongs to another catalog. A product can only include APIs from its own catalog.` });
    }

    await ProductApi.findOrCreate({ where: { productId: product.id, apiId: api.id } });
    await product.reload({ include: [apisInclude] });
    res.status(201).json({ product: serializeProduct(product) });
  } catch (error) {
    sendServerError(res, error, 'Failed to add API to product');
  }
};

const removeProductApi = async (req, res) => {
  try {
    const product = await findOrgProduct(req);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const removed = await ProductApi.destroy({ where: { productId: product.id, apiId: req.params.apiId } });
    if (!removed) {
      return res.status(404).json({ error: 'That API is not part of this product' });
    }

    // A published product must always include at least one API.
    const remaining = await ProductApi.count({ where: { productId: product.id } });
    if (remaining === 0 && product.status === 'published') {
      await product.update({ status: 'draft' });
    }
    await product.reload({ include: [apisInclude] });
    res.json({ product: serializeProduct(product) });
  } catch (error) {
    sendServerError(res, error, 'Failed to remove API from product');
  }
};

const subscriptionIncludes = (organizationId) => [
  {
    association: 'product',
    attributes: ['id', 'name', 'organizationId'],
    where: { organizationId },
  },
  {
    association: 'application',
    attributes: ['id', 'name', 'clientId', 'userId'],
    include: [{
      association: 'owner',
      attributes: ['id', 'name', 'email', 'organizationId'],
      include: [{ association: 'organization', attributes: ['id', 'name'] }],
    }],
  },
];

// Access requests for this organization's products. Optional filters: ?status=pending&productId=...
const listSubscriptions = async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.productId) where.productId = String(req.query.productId);

    const subscriptions = await Subscription.findAll({
      where,
      include: subscriptionIncludes(req.user.organizationId),
      order: [['createdAt', 'DESC']],
    });
    res.json({ subscriptions: subscriptions.map(serializeSubscription) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load access requests');
  }
};

// Approve, reject or revoke a subscription to one of this organization's products.
const decideSubscription = async (req, res) => {
  try {
    const { status } = req.body ?? {};
    if (!DECISIONS[status]) {
      return res.status(400).json({ error: 'Status must be approved, rejected or revoked' });
    }

    const subscription = await Subscription.findOne({
      where: { id: req.params.id },
      include: subscriptionIncludes(req.user.organizationId),
    });
    if (!subscription) {
      return res.status(404).json({ error: 'Access request not found' });
    }
    if (!DECISIONS[status].includes(subscription.status)) {
      return res.status(400).json({ error: `A ${subscription.status} request can't be ${status}` });
    }

    await subscription.update({ status, decidedById: req.user.id, decidedAt: new Date() });
    res.json({ subscription: serializeSubscription(subscription) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update access request');
  }
};

const countPendingByProduct = async (organizationId) => {
  const rows = await Subscription.findAll({
    where: { status: 'pending' },
    attributes: ['productId'],
    include: [{ association: 'product', attributes: [], where: { organizationId } }],
    raw: true,
  });
  return rows.reduce((counts, { productId }) => counts.set(productId, (counts.get(productId) || 0) + 1), new Map());
};

module.exports = {
  PRODUCT_STATUSES,
  RATE_LIMIT_PERIODS,
  BILLING_PLANS,
  BILLING_INTERVALS,
  CURRENCIES,
  serializeProduct,
  serializeSubscription,
  subscriptionIncludes,
  apisInclude,
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  deleteProduct,
  addProductApi,
  removeProductApi,
  listSubscriptions,
  decideSubscription,
  countPendingByProduct,
};
