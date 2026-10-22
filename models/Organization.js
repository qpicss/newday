const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A tenant. Users, APIs and API products all belong to exactly one organization.
const Organization = sequelize.define('Organization', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  timestamps: true,
});

module.exports = Organization;
