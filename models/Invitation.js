const crypto = require('crypto');
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const INVITE_TTL_DAYS = 7;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// An invitation to join an organization. Only the token's hash is stored;
// the plain token travels in the invite link.
const Invitation = sequelize.define('Invitation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  organizationId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  orgRole: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'member',
  },
  tokenHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  invitedById: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  acceptedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  timestamps: true,
});

// Creates a fresh token, stores its hash and expiry, and returns the plain token.
Invitation.prototype.issueToken = function issueToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  this.tokenHash = hashToken(token);
  this.expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  return token;
};

Invitation.prototype.isUsable = function isUsable() {
  return !this.acceptedAt && this.expiresAt > new Date();
};

Invitation.findByToken = (token) => (
  typeof token === 'string' && token
    ? Invitation.findOne({ where: { tokenHash: hashToken(token) } })
    : Promise.resolve(null)
);

Invitation.INVITE_TTL_DAYS = INVITE_TTL_DAYS;

module.exports = Invitation;
