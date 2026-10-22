const crypto = require('crypto');
const { Application, ApplicationCredential, Token } = require('../models');
const { getPki } = require('../utils/pki');
const { signAccessToken, publicJwk } = require('../utils/gatewayTokens');
const { sendServerError } = require('../utils/http');

// Client authentication: HTTP Basic (client_secret_basic) or form fields (client_secret_post).
const clientCredentialsFrom = (req) => {
  const header = req.get('authorization') || '';
  if (/^Basic /i.test(header)) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator > 0) {
      // RFC 6749 section 2.3.1: both parts are form-urlencoded.
      const decode = (value) => {
        try {
          return decodeURIComponent(value.replace(/\+/g, ' '));
        } catch {
          return value;
        }
      };
      return { clientId: decode(decoded.slice(0, separator)), clientSecret: decode(decoded.slice(separator + 1)) };
    }
  }
  return { clientId: req.body?.client_id, clientSecret: req.body?.client_secret };
};

const sameHash = (storedHex, secret) => {
  const expected = Buffer.from(storedHex, 'hex');
  const actual = Buffer.from(Application.hashSecret(secret), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

// The application these credentials belong to: by the client ID it was created with, or by one of
// its extra credentials (whose last use is recorded). Null when the ID or the secret is wrong.
const authenticateClient = async (clientId, clientSecret) => {
  const application = await Application.findOne({ where: { clientId } });
  if (application) return application.verifyClientSecret(clientSecret) ? application : null;
  const credential = await ApplicationCredential.findOne({ where: { clientId } });
  if (!credential || !sameHash(credential.secretHash, clientSecret)) return null;
  const owner = await Application.findByPk(credential.applicationId);
  if (owner) await credential.update({ lastUsedAt: new Date() });
  return owner;
};

const invalidClient = (res) => res
  .status(401)
  .set('WWW-Authenticate', 'Basic realm="oauth-server"')
  .json({ error: 'invalid_client', error_description: 'Client authentication failed' });

// POST /oauth/token  grant_type=client_credentials
const issueToken = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  try {
    const grantType = req.body?.grant_type;
    if (!grantType) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'grant_type is required' });
    }
    if (grantType !== 'client_credentials') {
      return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Only client_credentials is supported' });
    }

    const { clientId, clientSecret } = clientCredentialsFrom(req);
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string' || !clientId || !clientSecret) {
      return invalidClient(res);
    }
    // A token from extra credentials is the application's token: same subject, access and usage.
    const application = await authenticateClient(clientId, clientSecret);
    if (!application) {
      return invalidClient(res);
    }

    const { tokenKey } = await getPki();
    const { token, jti, expiresIn } = signAccessToken(application, tokenKey);
    // Only the token ID is recorded, never the token itself.
    await Token.create({
      userId: application.userId,
      applicationId: application.id,
      accessToken: jti,
      expiresIn,
      tokenType: 'Bearer',
      scope: 'gateway',
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
    });

    res.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });
  } catch (error) {
    sendServerError(res, error, 'Could not issue a token');
  }
};

const jwks = async (req, res) => {
  try {
    const { tokenKey } = await getPki();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ keys: [publicJwk(tokenKey)] });
  } catch (error) {
    sendServerError(res, error, 'Could not load signing keys');
  }
};

module.exports = { issueToken, jwks };
