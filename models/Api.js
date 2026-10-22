const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// An API owned by an organization, described by an OpenAPI 3.x document.
const Api = sequelize.define('Api', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  organizationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  // The catalog the API belongs to (in the same organization). Products only use APIs of their catalog.
  catalogId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  version: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
  },
  baseUrl: {
    type: DataTypes.STRING(2048),
  },
  // Path prefix on the gateway, e.g. /orders -> https://gateway/orders/{operation path}.
  // Unique within an organization.
  basePath: {
    type: DataTypes.STRING(200),
  },
  // How gateways reach the upstream (timeouts, retries, credentials, TLS); defaults when empty
  connectionId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // Policy the gateway runs before calling the upstream (optional)
  policyId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // 'import' (uploaded OpenAPI file) or 'manual' (created in the console)
  source: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'manual',
  },
  // The OpenAPI document, stored as JSON and exposed as an object.
  // LONGTEXT on MySQL (plain TEXT is capped at 64 KB); SQLite TEXT has no such limit.
  spec: {
    type: sequelize.getDialect() === 'mysql' ? DataTypes.TEXT('long') : DataTypes.TEXT,
    allowNull: false,
    get() {
      const raw = this.getDataValue('spec');
      return raw ? JSON.parse(raw) : null;
    },
    set(value) {
      this.setDataValue('spec', JSON.stringify(value));
    },
  },
}, {
  timestamps: true,
});

module.exports = Api;
