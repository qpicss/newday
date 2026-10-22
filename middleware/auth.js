const { User } = require('../models');
const { verifyJWT } = require('../utils/jwt');
const { resolveActiveOrganization } = require('../services/membership');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const getCookieToken = (req) => {
  const cookies = req.headers.cookie?.split(';') || [];
  const tokenCookie = cookies.find((cookie) => cookie.trim().startsWith('token='));

  return tokenCookie ? decodeURIComponent(tokenCookie.trim().slice('token='.length)) : null;
};

const isPageRequest = (req) => req.originalUrl.startsWith('/developer/') || req.originalUrl.startsWith('/admin/');

// Browsers attach the auth cookie automatically, so a state-changing request
// authenticated by cookie must come from this site (CSRF protection).
const isSameOrigin = (req) => {
  const source = req.get('Origin') || req.get('Referer');
  if (!source) {
    return false;
  }
  try {
    return new URL(source).host === req.get('host');
  } catch {
    return false;
  }
};

const deny = (req, res, error) => {
  // For protected pages, redirect to the login page
  if (isPageRequest(req)) {
    return res.redirect('/login');
  }
  return res.status(401).json({ error });
};

const authenticate = async (req, res, next) => {
  // Prefer Bearer tokens for API clients, then use the browser auth cookie.
  const authorization = req.header('Authorization');
  const bearerToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null;
  const token = bearerToken || getCookieToken(req);

  if (!token) {
    return deny(req, res, 'Access denied. No token provided.');
  }

  if (!bearerToken && !SAFE_METHODS.has(req.method) && !isSameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }

  let decoded;
  try {
    decoded = verifyJWT(token);
  } catch {
    return deny(req, res, 'Invalid token.');
  }

  const user = await User.findByPk(decoded.userId);
  if (!user) {
    return deny(req, res, 'Invalid token.');
  }

  // Selected organization and the role there, from the user's memberships.
  req.user = await resolveActiveOrganization(user);
  next();
};

// Admin authorization middleware
const authorizeAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  if (isPageRequest(req)) {
    return res.redirect('/login');
  }
  res.status(403).json({ error: 'Access denied. Admin privileges required.' });
};

module.exports = { authenticate, authorizeAdmin, isPageRequest };
