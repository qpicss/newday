const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// An application's access request to an API product.
// 'pending' -> 'approved' | 'rejected' by the product's org admin; 'approved' -> 'revoked'.
const Subscription = sequelize.define('Subscription', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  applicationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  productId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
  },
  requestedById: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  decidedById: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  decidedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [{ unique: true, fields: ['applicationId', 'productId'] }],
});

Subscription.ACTIVE_STATUSES = ['pending', 'approved'];

module.exports = Subscription;
