const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Platform keys created on first use: the management CA (self-signed), the management client
// certificate used for mTLS to gateways, and the key that signs gateway access tokens.
// Private keys are stored encrypted (utils/secretBox.js).
const SystemKey = sequelize.define('SystemKey', {
  name: {
    type: DataTypes.STRING(64),
    primaryKey: true,
  },
  certificatePem: {
    type: DataTypes.TEXT,
  },
  publicKeyPem: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  privateKeySealed: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
}, {
  timestamps: true,
});

module.exports = SystemKey;
