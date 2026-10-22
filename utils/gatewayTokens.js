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

const publicJwk = (tokenKey) => ({
  ...crypto.createPublicKey(tokenKey.publicKeyPem).export({ format: 'jwk' }),
  kid: tokenKey.kid,
  use: 'sig',
  alg: 'RS256',
});

module.exports = { AUDIENCE, TOKEN_LIFETIME_SECONDS, issuer, signAccessToken, publicJwk };
