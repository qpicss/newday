const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// One running gateway process. `url` is its mTLS management endpoint, e.g. https://10.0.0.5:9443.
const GatewayNode = sequelize.define('GatewayNode', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  gatewayId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Management address the console pushes to; empty for pull-only nodes
  url: {
    type: DataTypes.STRING(2048),
    allowNull: true,
  },
  // 'push' (added in the console) or 'pull' (registered itself over the link)
  mode: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'push',
  },
  lastSeenAt: {
    type: DataTypes.DATE,
  },
  softwareVersion: {
    type: DataTypes.STRING(40),
  },
  // Certificate the node presented last, to know when a renewal has reached it
  certificateFingerprint: {
    type: DataTypes.STRING(128),
  },
  // 'ok' or 'error' for the last push
  lastPushStatus: {
    type: DataTypes.STRING(10),
  },
  lastPushAt: {
    type: DataTypes.DATE,
  },
  lastError: {
    type: DataTypes.TEXT,
  },
  // Host name or IP address where clients reach this node (shown in its URLs); empty means the
  // host of the gateway's public URL.
  host: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  // Added to every port on the host, so several nodes can run on one Docker host:
  // offset 1 publishes container port 8443 as host port 8444.
  portOffset: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  // Configuration version the node reported after the last push or status check
  configVersion: {
    type: DataTypes.STRING(64),
  },
}, {
  timestamps: true,
});

module.exports = GatewayNode;
