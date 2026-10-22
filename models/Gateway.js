const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A gateway: one node or a cluster of nodes that share credentials and configuration.
// Management pushes the catalog's configuration to every node over mTLS.
const Gateway = sequelize.define('Gateway', {
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
  // Address consumers use (load balancer or single node), e.g. https://api.acme.com
  publicUrl: {
    type: DataTypes.STRING(2048),
    allowNull: false,
  },
  // Hash of the configuration last pushed to every node, to show "changes not deployed".
  lastPushedHash: {
    type: DataTypes.STRING(64),
  },
  lastPushedAt: {
    type: DataTypes.DATE,
  },
  credentialsIssuedAt: {
    type: DataTypes.DATE,
  },
  // Push automatically after changes to the catalog, products, policies or approvals
  autoPush: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  // Observability and admin UI settings pushed to the nodes (see services/gatewayConfig.js)
  observability: {
    type: DataTypes.TEXT,
    get() {
      const raw = this.getDataValue('observability');
      const stored = raw ? JSON.parse(raw) : {};
      return {
        requestLog: { enabled: true, size: 500, ...(stored.requestLog || {}) },
        metrics: { enabled: true, ...(stored.metrics || {}) },
        adminUi: { enabled: true, ...(stored.adminUi || {}) },
        offload: { type: 'none', url: null, headerName: null, batchSize: 100, flushIntervalMs: 5000, sampleRate: 1, ...(stored.offload || {}) },
      };
    },
    set(value) {
      this.setDataValue('observability', JSON.stringify(value));
    },
  },
  // Value of the off-load target's auth header (encrypted)
  offloadSecretSealed: {
    type: DataTypes.TEXT,
  },
}, {
  timestamps: true,
});

module.exports = Gateway;
