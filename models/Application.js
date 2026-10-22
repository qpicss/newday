const crypto = require('crypto');
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Older rows may hold a plain newline/comma separated string instead of JSON.
const parseStoredUris = (raw) => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // fall through to the legacy format
  }
  return String(raw).split(/[\r\n,]+/).map((uri) => uri.trim()).filter(Boolean);
};

const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');

const Application = sequelize.define('Application', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  // Organization the application was created in; it can subscribe to that organization's products.
  organizationId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
  },
  clientId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  // SHA-256 hash of the client secret; the plain secret is only shown once at creation.
  clientSecret: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Stored as a JSON array, exposed as a JavaScript array.
  redirectUris: {
    type: DataTypes.TEXT,
    allowNull: false,
    get() {
      return parseStoredUris(this.getDataValue('redirectUris'));
    },
    set(value) {
      this.setDataValue('redirectUris', JSON.stringify(value));
    },
  },
  publicKey: {
    type: DataTypes.TEXT,
  },
  scopes: {
    type: DataTypes.TEXT,
    defaultValue: '["openid", "profile", "email"]',
  },
  grantTypes: {
    type: DataTypes.TEXT,
    defaultValue: '["authorization_code", "refresh_token"]',
  },
  tokenEndpointAuthMethod: {
    type: DataTypes.STRING,
    defaultValue: 'client_secret_basic',
  },
}, {
  timestamps: true,
});

Application.hashSecret = hashSecret;

Application.prototype.verifyClientSecret = function verifyClientSecret(secret) {
  if (typeof secret !== 'string') {
    return false;
  }
  const expected = Buffer.from(this.clientSecret, 'hex');
  const actual = Buffer.from(hashSecret(secret), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

module.exports = Application;
