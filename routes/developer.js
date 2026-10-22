const express = require('express');
const router = express.Router();
const { authenticate, authorizeAdmin } = require('../middleware/auth');
const { createApplication, serializeCredential, MAX_CREDENTIALS } = require('../controllers/applicationController');
const { User, Organization, Application, ApplicationCredential, Subscription, Gateway, GatewayCredential, Catalog, Api, ApiProduct } = require('../models');
const { gatewayIncludes } = require('../services/gatewayQueries');
const { certificateWarnings } = require('../controllers/deploymentController');
const { usageSeries } = require('../services/usage');
const { parseRedirectUris } = require('../utils/validation');
const { serializeSubscription } = require('../controllers/productController');
const { describeOrganization } = require('../controllers/adminOrgController');
const consoleRoutes = require('./console');
const docs = require('../services/docs');

const organizationInclude = { association: 'organization', attributes: ['id', 'name'] };
// A user's organizations and roles, for the admin pages.
const membershipsInclude = {
  association: 'memberships',
  attributes: ['organizationId', 'role'],
  include: [{ association: 'organization', attributes: ['id', 'name'] }],
};
const plainMemberships = (managedUser) => (managedUser.memberships || [])
  .filter((membership) => membership.organization)
  .map((membership) => ({ id: membership.organization.id, name: membership.organization.name, role: membership.role }))
  .sort((a, b) => a.name.localeCompare(b.name));

const renderNotFound = (req, res, heading, message) => res.status(404).render('error.html', {
  user: req.user,
  status: 404,
  heading,
  message,
});

// Shared by the owner's view and the admin view of an application.
const renderApplicationDetail = async (req, res, application, { adminView, owner = null }) => {
  // Older data may hold URIs that no longer pass validation; flag them on the page.
  const { error: redirectUriError } = parseRedirectUris(application.redirectUris);
  const subscriptions = await Subscription.findAll({
    where: { applicationId: application.id },
    include: [{ association: 'product', attributes: ['id', 'name', 'status'], include: [organizationInclude] }],
    order: [['createdAt', 'DESC']],
  });
  const credentials = await ApplicationCredential.findAll({ where: { applicationId: application.id }, order: [['createdAt', 'ASC']] });
  res.render('application-detail.html', {
    user: req.user,
    application,
    redirectUriError,
    adminView,
    owner,
    subscriptions: subscriptions.map(serializeSubscription),
    credentials: credentials.map(serializeCredential),
    maxCredentials: MAX_CREDENTIALS,
    usage: await usageSeries({ applicationId: application.id }),
  });
};

// Certificate expiry warnings for every gateway of the organization (org admins only).
const gatewayAlerts = async (user) => {
  if (user.orgRole !== 'admin' || !user.organizationId) return [];
  const gateways = await Gateway.findAll({ where: { organizationId: user.organizationId }, include: gatewayIncludes, order: [['name', 'ASC']] });
  if (!gateways.length) return [];
  const credentials = await GatewayCredential.findAll({ where: { gatewayId: gateways.map((gateway) => gateway.id), revokedAt: null } });
  return gateways.flatMap((gateway) => certificateWarnings(gateway, credentials.filter((credential) => credential.gatewayId === gateway.id))
    .map((message) => ({ gatewayId: gateway.id, gatewayName: gateway.name, message })));
};

const countApplicationsByUser = async () => {
  const rows = await Application.findAll({ attributes: ['userId'], raw: true });
  return rows.reduce((counts, { userId }) => counts.set(userId, (counts.get(userId) || 0) + 1), new Map());
};

// All developer routes require authentication
router.use(authenticate);

// Organization, APIs, API products and catalog pages
router.use(consoleRoutes);

// Setup progress for an org admin: catalog, API, published product, running gateway attached to a catalog.
const adminSetup = async (user) => {
  if (user.orgRole !== 'admin' || !user.organizationId) return null;
  const where = { organizationId: user.organizationId };
  const [catalogs, apis, published, gateways] = await Promise.all([
    Catalog.count({ where }),
    Api.count({ where }),
    ApiProduct.count({ where: { ...where, status: 'published' } }),
    Gateway.findAll({ where, attributes: ['id', 'catalogId'], include: [{ association: 'nodes', attributes: ['id', 'lastSeenAt'] }] }),
  ]);
  return {
    catalogs,
    apis,
    published,
    gateways: gateways.length,
    runningGateways: gateways.filter((gateway) => gateway.nodes.some((node) => node.lastSeenAt)).length,
    attachedGateways: gateways.filter((gateway) => gateway.catalogId).length,
  };
};

router.get('/dashboard', async (req, res) => {
  try {
    // The user's applications in the organization they work in
    const applications = await Application.findAll({
      where: { userId: req.user.id, organizationId: req.user.organizationId || null },
      order: [['createdAt', 'DESC']],
    });
    const applicationIds = applications.map((application) => application.id);

    const approvedSubscriptions = applicationIds.length
      ? await Subscription.count({ where: { applicationId: applicationIds, status: 'approved' } })
      : 0;
    // Org admins see how many access requests to their products are waiting.
    const pendingApprovals = req.user.orgRole === 'admin' && req.user.organizationId
      ? await Subscription.count({
        where: { status: 'pending' },
        include: [{ association: 'product', attributes: [], where: { organizationId: req.user.organizationId } }],
      })
      : 0;

    res.render('dashboard.html', {
      user: req.user,
      applications,
      approvedSubscriptions,
      pendingApprovals,
      gatewayAlerts: await gatewayAlerts(req.user),
      setup: await adminSetup(req.user),
    });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.render('dashboard.html', {
      user: req.user,
      applications: [],
      approvedSubscriptions: 0,
      pendingApprovals: 0,
      gatewayAlerts: [],
      setup: null,
    });
  }
});

router.get('/applications', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const applications = await Application.findAll({
    where: { userId: req.user.id, organizationId: req.user.organizationId || null },
    order: [['createdAt', 'DESC']],
  });

  res.render('applications.html', { user: req.user, applications });
});

// Documentation: every signed-in user, whatever their role or organization.
router.get('/docs{/*path}', (req, res) => {
  const slug = Array.isArray(req.params.path) ? req.params.path.join('/').replace(/\/+$/, '') : '';
  const page = docs.loadPage(slug);
  if (!page) {
    return renderNotFound(req, res, 'Page not found', "This documentation page doesn't exist. Pick one from the menu.");
  }
  res.render('docs.html', {
    user: req.user,
    page,
    navigation: docs.navigation(),
    guide: docs.guideFor(req.user),
  });
});

router.get('/profile', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const profile = await User.findByPk(req.user.id, {
    attributes: { exclude: ['password'] },
    include: [organizationInclude],
  });

  if (!profile) {
    return renderNotFound(req, res, 'Profile not found', "We couldn't load your profile.");
  }

  res.render('profile.html', { user: req.user, profile });
});

router.get('/applications/create', (req, res) => {
  res.render('application-create.html', { user: req.user });
});

// No-JavaScript fallback for the create form. Only the request body is used.
router.post('/applications/create', (req, res) => {
  const { name, description, redirectUris, publicKey } = req.body ?? {};
  req.body = { name, description, redirectUris, publicKey };
  req.renderApplicationResponse = true;

  return createApplication(req, res);
});

router.get('/applications/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const application = await Application.findOne({
    where: { id: req.params.id, userId: req.user.id },
  });

  if (!application) {
    return renderNotFound(req, res, 'Application not found', "This application doesn't exist or you don't have access to it.");
  }

  await renderApplicationDetail(req, res, application, { adminView: false });
});

// Admin dashboard route (only for admin users)
// ?organizationId= narrows the list to one organization's members.
router.get('/admin', authorizeAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const [users, organizations, appCounts] = await Promise.all([
    User.findAll({
      attributes: { exclude: ['password'] },
      include: [membershipsInclude],
      order: [['createdAt', 'ASC']],
    }),
    Organization.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    countApplicationsByUser(),
  ]);
  const organizationId = typeof req.query.organizationId === 'string' ? req.query.organizationId : '';
  const withOrganizations = users.map((managedUser) => Object.assign(managedUser, { organizations: plainMemberships(managedUser) }));
  const totalApplications = [...appCounts.values()].reduce((sum, count) => sum + count, 0);
  res.render('admin.html', {
    user: req.user,
    allUsers: withOrganizations,
    users: organizationId
      ? withOrganizations.filter((managedUser) => managedUser.organizations.some((organization) => organization.id === organizationId))
      : withOrganizations,
    organizations,
    organizationId,
    appCounts,
    totalApplications,
  });
});

// Every organization with what it holds.
router.get('/admin/organizations', authorizeAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const organizations = await Organization.findAll({ order: [['name', 'ASC']] });
  const described = [];
  for (const organization of organizations) described.push(await describeOrganization(organization));
  res.render('admin-organizations.html', { user: req.user, organizations: described });
});

// One organization: its members and its catalogs (with their products and APIs) and gateways.
router.get('/admin/organizations/:id', authorizeAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const organization = await Organization.findByPk(req.params.id);
  if (!organization) {
    return renderNotFound(req, res, 'Organization not found', 'This organization may have been deleted.');
  }
  res.render('admin-organization.html', { user: req.user, organization: await describeOrganization(organization) });
});

router.get('/admin/profiles', authorizeAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const profiles = await User.findAll({
    attributes: { exclude: ['password'] },
    include: [membershipsInclude],
    order: [['createdAt', 'DESC']],
  });

  res.render('admin-profiles.html', {
    user: req.user,
    profiles: profiles.map((profile) => Object.assign(profile, { organizations: plainMemberships(profile) })),
  });
});

router.get('/admin/users/new', authorizeAdmin, async (req, res) => {
  const organizations = await Organization.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] });
  res.render('admin-create-user.html', { user: req.user, organizations });
});

// Manage one user: profile, password and applications
router.get('/admin/users/:id', authorizeAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const targetUser = await User.findByPk(req.params.id, {
    attributes: { exclude: ['password'] },
    include: [membershipsInclude],
  });

  if (!targetUser) {
    return renderNotFound(req, res, 'User not found', 'This user may have been deleted.');
  }

  const [applications, organizations] = await Promise.all([
    Application.findAll({
      where: { userId: targetUser.id },
      include: [organizationInclude],
      order: [['createdAt', 'DESC']],
    }),
    Organization.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] }),
  ]);
  res.render('admin-user.html', {
    user: req.user,
    targetUser,
    memberships: plainMemberships(targetUser),
    organizations,
    applications,
  });
});

// Older links to the separate edit page
router.get('/admin/users/:id/edit', authorizeAdmin, (req, res) => {
  res.redirect(301, `/developer/admin/users/${encodeURIComponent(req.params.id)}`);
});

// Every application across all users
router.get('/admin/applications', authorizeAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const applications = await Application.findAll({
    include: [{ association: 'owner', attributes: ['id', 'name', 'email'] }],
    order: [['createdAt', 'DESC']],
  });
  res.render('admin-applications.html', { user: req.user, applications });
});

// Admin view of any application
router.get('/admin/applications/:id', authorizeAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const application = await Application.findByPk(req.params.id, {
    include: [{ association: 'owner', attributes: ['id', 'name', 'email'] }],
  });

  if (!application) {
    return renderNotFound(req, res, 'Application not found', 'This application may have been deleted.');
  }

  await renderApplicationDetail(req, res, application, { adminView: true, owner: application.owner });
});

module.exports = router;
