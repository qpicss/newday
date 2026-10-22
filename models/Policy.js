const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const { defaultFlow } = require('../gateway/src/flow');

// A policy: a flow of steps (gateway scripts, If branches, service calls) the gateway runs for an
// API's requests, from Input to Output. See gateway/src/flow.js for the format.
// APIs get a policy of their own when they are created (ownerApiId); any policy can also be
// chosen for other APIs or as a port policy.
const Policy = sequelize.define('Policy', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  organizationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
  },
  // The flow, stored as JSON and exposed as an object. LONGTEXT on MySQL: scripts make it large.
  flow: {
    type: sequelize.getDialect() === 'mysql' ? DataTypes.TEXT('long') : DataTypes.TEXT,
    allowNull: true,
    get() {
      const raw = this.getDataValue('flow');
      return raw ? JSON.parse(raw) : defaultFlow();
    },
    set(value) {
      this.setDataValue('flow', JSON.stringify(value));
    },
  },
  // The API this policy was created for; removed together with that API when nothing else uses it.
  ownerApiId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // Legacy single-script policies (before flows); scripts/migrate-data.js turns them into flows.
  code: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  timeoutMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  timestamps: true,
});

module.exports = Policy;
