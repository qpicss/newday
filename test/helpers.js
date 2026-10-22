// Must run before the app is loaded: use an isolated in-memory database.
process.env.NODE_ENV = 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.GATEWAY_AUTO_PUSH = 'false';

const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const sequelize = require('../config/database');
const models = require('../models');

const { User, Organization, Application, Token, Membership } = models;
const { generateUserToken } = require('../utils/jwt');
const { resetRateLimits } = require('../middleware/rateLimit');

// Same-origin headers a browser would send; cookie-authenticated writes need them.
const HOST = 'app.test';
const ORIGIN = `http://${HOST}`;

let userCounter = 0;

const resetDatabase = async () => {
  resetRateLimits();
  await sequelize.sync({ force: true });
};

// Without `organization` a new one is created with the user as its admin; with one, the user joins it
// (as a member unless `orgRole` says otherwise). Pass `organization: null` for a user without any.
const createUser = async ({ role = 'user', password = 'password123', organization, orgRole, ...fields } = {}) => {
  userCounter += 1;
  const userOrganization = organization === null
    ? null
    : organization || await Organization.create({ name: `Org ${userCounter}` });
  const user = await User.create({
    name: `User ${userCounter}`,
    email: `user${userCounter}@example.com`,
    role,
    password: await bcrypt.hash(password, 4),
    organizationId: userOrganization ? userOrganization.id : null,
    ...fields,
  });
  if (userOrganization) {
    await Membership.create({ userId: user.id, organizationId: userOrganization.id, role: orgRole || (organization ? 'member' : 'admin') });
  }
  return user;
};

// Adds an existing user to another organization.
const addMembership = (user, organization, role = 'member') => Membership.create({ userId: user.id, organizationId: organization.id, role });

const tokenFor = (user) => generateUserToken(user, '1h');

// A catalog in the user's selected organization, created through the API.
const createCatalog = async (user, name = 'Main catalog') => {
  const res = await request(app).post('/api/org/catalogs').set('Authorization', `Bearer ${tokenFor(user)}`).send({ name });
  if (res.status !== 201) throw new Error(`createCatalog failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.catalog;
};

// Request authenticated with a Bearer token (API client).
const api = (method, path, user) => request(app)[method](path)
  .set('Authorization', `Bearer ${tokenFor(user)}`);

// Request authenticated with the browser cookie from this site's origin.
const browser = (method, path, user) => request(app)[method](path)
  .set('Host', HOST)
  .set('Origin', ORIGIN)
  .set('Cookie', `token=${tokenFor(user)}`);

const VALID_APP = {
  name: 'My App',
  description: 'Test application',
  redirectUris: ['https://example.com/callback'],
};

module.exports = {
  app,
  request,
  sequelize,
  models,
  User,
  Organization,
  Application,
  Token,
  HOST,
  ORIGIN,
  resetDatabase,
  createUser,
  addMembership,
  createCatalog,
  tokenFor,
  api,
  browser,
  VALID_APP,
};
