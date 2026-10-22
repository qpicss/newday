const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A bundle of APIs that applications can subscribe to, with rate limit and billing settings.
// It belongs to one catalog; once published, the organization's members can subscribe to it.
const ApiProduct = sequelize.define('ApiProduct', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  organizationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  catalogId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
  },
  // 'draft' or 'published'
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'draft',
  },
  rateLimitEnabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  rateLimitRequests: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1000,
  },
  // 'second', 'minute', 'hour' or 'day'
  rateLimitPeriod: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'hour',
  },
  // 'free', 'flat' (fixed price per interval) or 'usage' (price per 1,000 requests)
  billingPlan: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'free',
  },
  // Stored in minor units (cents) to avoid floating point rounding.
  billingPriceCents: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  billingCurrency: {
    type: DataTypes.STRING(3),
    allowNull: false,
    defaultValue: 'USD',
  },
  // 'month' or 'year' (flat plans)
  billingInterval: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'month',
  },
}, {
  timestamps: true,
});

module.exports = ApiProduct;
