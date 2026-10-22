const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// One property of a dictionary object: a name plus either a dictionary field (fieldId) or another
// object (refObjectId, which may be the object itself for trees). isArray makes it a list of them.
const DictionaryProperty = sequelize.define('DictionaryProperty', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  objectId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  position: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  fieldId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  refObjectId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  isArray: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  required: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
}, {
  timestamps: true,
  indexes: [{ fields: ['objectId'] }, { fields: ['fieldId'] }, { fields: ['refObjectId'] }],
});

module.exports = DictionaryProperty;
