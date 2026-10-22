const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Daily request counts reported by gateways, per application, product and API.
// Feeds the usage charts and usage-based billing.
const UsageRecord = sequelize.define('UsageRecord', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  // YYYY-MM-DD (UTC)
  day: {
    type: DataTypes.STRING(10),
    allowNull: false,
  },
  gatewayId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  organizationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  productId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  apiId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  clientId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  applicationId: {
    type: DataTypes.UUID,
  },
  requests: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  errors: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  rateLimited: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  latencyMsTotal: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  timestamps: true,
  indexes: [{ unique: true, fields: ['day', 'gatewayId', 'productId', 'apiId', 'clientId'] }],
});

module.exports = UsageRecord;
