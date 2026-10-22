const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A user's place in an organization. A user can belong to several organizations, with a role in each:
// 'admin' manages catalogs, products, APIs, gateways, members and approvals; 'member' browses the
// organization's catalogs and subscribes applications to its products.
const Membership = sequelize.define('Membership', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  organizationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  role: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'member',
  },
}, {
  timestamps: true,
  indexes: [{ unique: true, fields: ['userId', 'organizationId'] }],
});

Membership.ROLES = ['admin', 'member'];

module.exports = Membership;
