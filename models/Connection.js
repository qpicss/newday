const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DEFAULT_SETTINGS = {
  connectTimeoutMs: 5000,
  timeoutMs: 30000,
  retries: 0,
  retryOn: [502, 503, 504],
  circuitBreaker: { enabled: false, failureThreshold: 5, cooldownMs: 30000 },
  auth: { type: 'none', username: null, headerName: null },
  tls: { rejectUnauthorized: true, caPem: null, clientCertificatePem: null, serverName: null },
};

// How gateways reach a backend: timeouts, retries, circuit breaker, credentials and TLS.
// Secrets (the auth secret and the client private key) are stored encrypted.
const Connection = sequelize.define('Connection', {
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
  settings: {
    type: DataTypes.TEXT,
    allowNull: false,
    get() {
      const raw = this.getDataValue('settings');
      const stored = raw ? JSON.parse(raw) : {};
      return {
        ...DEFAULT_SETTINGS,
        ...stored,
        circuitBreaker: { ...DEFAULT_SETTINGS.circuitBreaker, ...(stored.circuitBreaker || {}) },
        auth: { ...DEFAULT_SETTINGS.auth, ...(stored.auth || {}) },
        tls: { ...DEFAULT_SETTINGS.tls, ...(stored.tls || {}) },
      };
    },
    set(value) {
      this.setDataValue('settings', JSON.stringify(value));
    },
  },
  authSecretSealed: {
    type: DataTypes.TEXT,
  },
  clientKeySealed: {
    type: DataTypes.TEXT,
  },
}, {
  timestamps: true,
});

Connection.DEFAULT_SETTINGS = DEFAULT_SETTINGS;

module.exports = Connection;
