const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Join table: which APIs are included in which API product.
const ProductApi = sequelize.define('ProductApi', {
  productId: {
    type: DataTypes.UUID,
    primaryKey: true,
  },
  apiId: {
    type: DataTypes.UUID,
    primaryKey: true,
  },
}, {
  timestamps: true,
});

module.exports = ProductApi;
