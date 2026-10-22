const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A data dictionary object (Customer, Address, CreateOrderRequest...): a named set of properties,
// each a dictionary field or another object (DictionaryProperty). Used in an OpenAPI document it
// becomes components.schemas[name]. The name is unique (ignoring case) within the organization.
const DictionaryObject = sequelize.define('DictionaryObject', {
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
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // false: properties not listed are refused (additionalProperties: false). null: not stated.
  additionalProperties: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
  },
  // 'manual' (built in the console) or 'import' (taken from an API's OpenAPI document)
  source: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'manual',
  },
  sourceApiId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  createdById: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [{ fields: ['organizationId', 'name'] }],
});

module.exports = DictionaryObject;
