const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Every certificate issued to a gateway, for expiry tracking and revocation. Revoked certificates
// are refused on push, status calls and the gateway link. A renewal keeps its bundle (private key
// sealed) until pull-mode nodes have fetched it.
const GatewayCredential = sequelize.define('GatewayCredential', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  gatewayId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  serialNumber: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  fingerprint: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
  },
  validTo: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  // 'download' (credentials file) or 'renewal' (sent to the nodes)
  source: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'download',
  },
  revokedAt: {
    type: DataTypes.DATE,
  },
  bundleSealed: {
    type: DataTypes.TEXT,
  },
}, {
  timestamps: true,
});

module.exports = GatewayCredential;
