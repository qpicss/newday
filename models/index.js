// Loads every model and wires up associations. Require this (not individual
// model files) before running queries that use `include`.
const User = require('./User');
const Membership = require('./Membership');
const Organization = require('./Organization');
const Invitation = require('./Invitation');
const Application = require('./Application');
const ApplicationCredential = require('./ApplicationCredential');
const Token = require('./Token');
const Api = require('./Api');
const ApiProduct = require('./ApiProduct');
const ProductApi = require('./ProductApi');
const Subscription = require('./Subscription');
const SystemKey = require('./SystemKey');
const Catalog = require('./Catalog');
const CatalogProduct = require('./CatalogProduct');
const Gateway = require('./Gateway');
const GatewayNode = require('./GatewayNode');
const GatewayHandler = require('./GatewayHandler');
const Policy = require('./Policy');
const GatewayCredential = require('./GatewayCredential');
const Connection = require('./Connection');
const UsageRecord = require('./UsageRecord');
const DictionaryField = require('./DictionaryField');
const DictionaryObject = require('./DictionaryObject');
const DictionaryProperty = require('./DictionaryProperty');

// constraints: false keeps these query-only associations (no foreign keys are created),
// so existing databases need no constraint migrations and cleanup is done explicitly.
const loose = { constraints: false };

// User.organizationId is the organization currently selected; memberships list all of them.
User.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId', ...loose });
User.hasMany(Membership, { as: 'memberships', foreignKey: 'userId', ...loose });
Organization.hasMany(Membership, { as: 'memberships', foreignKey: 'organizationId', ...loose });
Membership.belongsTo(User, { as: 'user', foreignKey: 'userId', ...loose });
Membership.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId', ...loose });

Invitation.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId', ...loose });
Invitation.belongsTo(User, { as: 'invitedBy', foreignKey: 'invitedById', ...loose });

Application.belongsTo(User, { as: 'owner', foreignKey: 'userId', ...loose });
Application.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId', ...loose });
Application.hasMany(Subscription, { as: 'subscriptions', foreignKey: 'applicationId', ...loose });
Application.hasMany(ApplicationCredential, { as: 'credentials', foreignKey: 'applicationId', ...loose });
ApplicationCredential.belongsTo(Application, { as: 'application', foreignKey: 'applicationId', ...loose });

Api.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId', ...loose });
ApiProduct.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId', ...loose });

ApiProduct.belongsToMany(Api, {
  as: 'apis', through: ProductApi, foreignKey: 'productId', otherKey: 'apiId', ...loose,
});
Api.belongsToMany(ApiProduct, {
  as: 'products', through: ProductApi, foreignKey: 'apiId', otherKey: 'productId', ...loose,
});

ApiProduct.hasMany(Subscription, { as: 'subscriptions', foreignKey: 'productId', ...loose });
Subscription.belongsTo(ApiProduct, { as: 'product', foreignKey: 'productId', ...loose });
Subscription.belongsTo(Application, { as: 'application', foreignKey: 'applicationId', ...loose });

// A catalog owns products and APIs; a gateway serves at most one catalog.
// (CatalogProduct is the pre-ownership join table, kept only for scripts/migrate-data.js.)
Organization.hasMany(Catalog, { as: 'catalogs', foreignKey: 'organizationId', ...loose });
Catalog.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId', ...loose });
Catalog.hasMany(ApiProduct, { as: 'products', foreignKey: 'catalogId', ...loose });
ApiProduct.belongsTo(Catalog, { as: 'catalog', foreignKey: 'catalogId', ...loose });
Catalog.hasMany(Api, { as: 'apis', foreignKey: 'catalogId', ...loose });
Api.belongsTo(Catalog, { as: 'catalog', foreignKey: 'catalogId', ...loose });
Catalog.hasMany(Gateway, { as: 'gateways', foreignKey: 'catalogId', ...loose });
Gateway.belongsTo(Catalog, { as: 'catalog', foreignKey: 'catalogId', ...loose });
Gateway.hasMany(GatewayNode, { as: 'nodes', foreignKey: 'gatewayId', ...loose });
Gateway.hasMany(GatewayHandler, { as: 'handlers', foreignKey: 'gatewayId', ...loose });
Policy.hasMany(Api, { as: 'apis', foreignKey: 'policyId', ...loose });
Api.belongsTo(Policy, { as: 'policy', foreignKey: 'policyId', ...loose });
GatewayHandler.belongsTo(Policy, { as: 'policy', foreignKey: 'policyId', ...loose });
Policy.hasMany(GatewayHandler, { as: 'handlers', foreignKey: 'policyId', ...loose });
GatewayHandler.belongsTo(Gateway, { as: 'gateway', foreignKey: 'gatewayId', ...loose });
Gateway.hasMany(GatewayCredential, { as: 'credentials', foreignKey: 'gatewayId', ...loose });
Api.belongsTo(Connection, { as: 'connection', foreignKey: 'connectionId', ...loose });
Connection.hasMany(Api, { as: 'apis', foreignKey: 'connectionId', ...loose });

// Data dictionary: objects are made of properties, each pointing at a field or another object.
DictionaryObject.hasMany(DictionaryProperty, { as: 'properties', foreignKey: 'objectId', ...loose });
DictionaryProperty.belongsTo(DictionaryObject, { as: 'object', foreignKey: 'objectId', ...loose });
DictionaryProperty.belongsTo(DictionaryField, { as: 'field', foreignKey: 'fieldId', ...loose });
DictionaryProperty.belongsTo(DictionaryObject, { as: 'refObject', foreignKey: 'refObjectId', ...loose });
DictionaryField.hasMany(DictionaryProperty, { as: 'usages', foreignKey: 'fieldId', ...loose });

module.exports = {
  User,
  Membership,
  Organization,
  Invitation,
  Application,
  ApplicationCredential,
  Token,
  Api,
  ApiProduct,
  ProductApi,
  Subscription,
  SystemKey,
  Catalog,
  CatalogProduct,
  Gateway,
  GatewayNode,
  GatewayHandler,
  Policy,
  GatewayCredential,
  Connection,
  UsageRecord,
  DictionaryField,
  DictionaryObject,
  DictionaryProperty,
};
