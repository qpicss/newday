const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// An extra client ID and secret of an application, next to the one it was created with, so each
// client or environment can have its own and be cut off alone. Tokens issued with one are tokens
// of the application: same subscriptions, same usage.
const ApplicationCredential = sequelize.define('ApplicationCredential', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  applicationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  clientId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  // SHA-256 hash of the secret (Application.hashSecret); the plain secret is shown once.
  secretHash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdById: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [{ fields: ['applicationId'] }],
});

module.exports = ApplicationCredential;
