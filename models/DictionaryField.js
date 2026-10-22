const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A data dictionary entry for one value (customerId, email, X-Request-Id...): its name, meaning
// and schema. Objects use fields as properties; operations use them as parameters. The name is
// unique (ignoring case) within the organization.
const DictionaryField = sequelize.define('DictionaryField', {
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
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // JSON schema of the value in the dictionary's own form (utils/dictionary.js validateFieldSchema):
  // OpenAPI 3.0 style, rendered for 3.1 documents when used.
  schema: {
    type: DataTypes.TEXT,
    allowNull: false,
    get() {
      const raw = this.getDataValue('schema');
      return raw ? JSON.parse(raw) : null;
    },
    set(value) {
      this.setDataValue('schema', JSON.stringify(value));
    },
  },
  // 'manual' (added in the console) or 'import' (taken from an API's OpenAPI document)
  source: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'manual',
  },
  sourceApiId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  createdById: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [{ fields: ['organizationId', 'name'] }],
});

module.exports = DictionaryField;
