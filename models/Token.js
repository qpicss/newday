const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Token = sequelize.define('Token', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  applicationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  accessToken: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  refreshToken: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  expiresIn: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  tokenType: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  scope: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  accessTokenExpiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  refreshTokenExpiresAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  authorizationCode: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  codeChallenge: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  codeChallengeMethod: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  timestamps: true,
});

module.exports = Token;
