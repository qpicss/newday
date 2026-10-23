// Access tokens for calling APIs through gateways (OAuth 2.0 client credentials).
// RS256, signed with the platform token key; gateways get the public key in every push.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const AUDIENCE = 'oauth-server-gateway';
const TOKEN_LIFETIME_SECONDS = 600;

const issuer = () => (process.env.APP_URL || 'oauth-server').replace(/\/+$/, '');

const signAccessToken = (application, tokenKey) => {
  const jti = crypto.randomUUID();
  const token = jwt.sign({}, tokenKey.privateKeyPem, {
    algorithm: 'RS256',
    keyid: tokenKey.kid,
    subject: application.clientId,
    audience: AUDIENCE,
    issuer: issuer(),
    expiresIn: TOKEN_LIFETIME_SECONDS,
    jwtid: jti,
  });
  return { token, jti, expiresIn: TOKEN_LIFETIME_SECONDS };
};

// One-time sign-in ticket for a gateway node's admin UI, for an org admin opening it from the
// console. Gateways check it with the same public key as access tokens, under their own audience.
const ADMIN_AUDIENCE = 'oauth-server-gateway-admin';
const ADMIN_TICKET_SECONDS = 60;

const signAdminTicket = ({ user, organization, gateway, node }, tokenKey) => jwt.sign({
  name: user.name,
  email: user.email,
  organization: organization?.name || '',
  gatewayId: gateway.id,
  node: node.name,
}, tokenKey.privateKeyPem, {
  algorithm: 'RS256',
  keyid: tokenKey.kid,
  subject: String(user.id),
  audience: ADMIN_AUDIENCE,
  issuer: issuer(),
  expiresIn: ADMIN_TICKET_SECONDS,
  jwtid: crypto.randomUUID(),
});

const publicJwk = (tokenKey) => ({
  ...crypto.createPublicKey(tokenKey.publicKeyPem).export({ format: 'jwk' }),
  kid: tokenKey.kid,
  use: 'sig',
  alg: 'RS256',
});

module.exports = { AUDIENCE, ADMIN_AUDIENCE, TOKEN_LIFETIME_SECONDS, ADMIN_TICKET_SECONDS, issuer, signAccessToken, signAdminTicket, publicJwk };
