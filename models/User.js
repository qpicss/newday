const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  isVerified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  role: {
    type: DataTypes.STRING,
    defaultValue: 'user',
    allowNull: false,
  },
  // The organization the user is working in (selected with the organization switcher).
  // Memberships (models/Membership.js) say which organizations a user belongs to and with which role.
  organizationId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // Legacy column from before memberships; the role in the selected organization is resolved
  // from Membership at sign-in (middleware/auth.js) and never read from here.
  orgRole: {
    type: DataTypes.STRING,
    defaultValue: 'member',
    allowNull: false,
  },
}, {
  timestamps: true,
});

module.exports = User;
