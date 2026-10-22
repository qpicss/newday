const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A connection handler: a port the gateway listens on for API traffic.
// HTTPS handlers use a certificate issued by the management CA ('generated')
// or one supplied by the admin ('custom'). Private keys are stored encrypted.
const GatewayHandler = sequelize.define('GatewayHandler', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  gatewayId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  port: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // 'http' or 'https'
  protocol: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'http',
  },
  // 'generated' or 'custom' (HTTPS only)
  tlsMode: {
    type: DataTypes.STRING(10),
  },
  // Policy run for every request on this port, before the API's policy
  policyId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // The node this handler runs on; empty means every node of the gateway (the cluster)
  nodeId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  certificatePem: {
    type: DataTypes.TEXT,
  },
  privateKeySealed: {
    type: DataTypes.TEXT,
  },
}, {
  timestamps: true,
});

module.exports = GatewayHandler;
