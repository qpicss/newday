const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Join table: which API products are in which catalog.
const CatalogProduct = sequelize.define('CatalogProduct', {
  catalogId: {
    type: DataTypes.UUID,
    primaryKey: true,
  },
  productId: {
    type: DataTypes.UUID,
    primaryKey: true,
  },
}, {
  timestamps: true,
});

module.exports = CatalogProduct;
