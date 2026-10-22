const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A part of an organization that owns API products and APIs. A running gateway can be attached to it;
// every gateway serves at most one catalog and receives the catalog's published products.
const Catalog = sequelize.define('Catalog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  organizationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
  },
}, {
  timestamps: true,
});

module.exports = Catalog;
