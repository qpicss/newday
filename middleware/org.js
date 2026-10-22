const { isPageRequest } = require('./auth');

const forbid = (req, res, heading, message) => {
  if (isPageRequest(req)) {
    return res.status(403).render('error.html', { user: req.user, status: 403, heading, message });
  }
  return res.status(403).json({ error: message });
};

// The signed-in user must belong to an organization (tenant).
const requireOrganization = (req, res, next) => {
  if (req.user?.organizationId) {
    return next();
  }
  return forbid(req, res, 'No organization', 'Your account is not part of an organization yet.');
};

// Only organization admins can manage members, APIs, products and approvals.
const requireOrgAdmin = (req, res, next) => {
  if (req.user?.organizationId && req.user.orgRole === 'admin') {
    return next();
  }
  return forbid(req, res, 'Organization admins only', 'Only organization admins can do this.');
};

module.exports = { requireOrganization, requireOrgAdmin };
