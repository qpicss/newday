const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  app,
  request,
  User,
  Application,
  resetDatabase,
  createUser,
  api,
  browser,
  VALID_APP,
} = require('./helpers');

describe('admin API', () => {
  let admin;
  let user;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ role: 'admin' });
    user = await createUser();
  });

  it('is forbidden for regular users', async () => {
    const list = await api('get', '/api/admin/users', user);
    const token = await api('post', '/api/admin/token', user).send({ userId: admin.id });

    assert.equal(list.status, 403);
    assert.equal(token.status, 403);
    assert.equal(token.body.token, undefined);
  });

  it('lists users without password hashes', async () => {
    const res = await api('get', '/api/admin/users', admin);

    assert.equal(res.status, 200);
    assert.equal(res.body.users.length, 2);
    assert.doesNotMatch(JSON.stringify(res.body), /password/);
  });

  it('creates users with validation', async () => {
    const invalid = await api('post', '/api/admin/users', admin)
      .send({ name: 'New', email: 'new@example.com', password: 'short' });
    const noOrganization = await api('post', '/api/admin/users', admin)
      .send({ name: 'New', email: 'new@example.com', password: 'password123' });
    const created = await api('post', '/api/admin/users', admin)
      .send({ name: 'New', email: 'New@Example.com', password: 'password123', role: 'admin', isVerified: true, organizationName: 'New Co' });
    const duplicate = await api('post', '/api/admin/users', admin)
      .send({ name: 'New', email: 'new@example.com', password: 'password123', organizationName: 'Other Co' });

    assert.equal(invalid.status, 400);
    assert.equal(noOrganization.status, 400);
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, 'new@example.com');
    assert.equal(created.body.user.role, 'admin');
    assert.deepEqual(created.body.user.organizations.map((organization) => [organization.name, organization.role]), [['New Co', 'admin']]);
    assert.equal(created.body.user.password, undefined);
    assert.equal(duplicate.status, 409);
  });

  it('adds a user to an existing organization', async () => {
    const res = await api('post', '/api/admin/users', admin)
      .send({ name: 'Teammate', email: 'mate@example.com', password: 'password123', organizationId: user.organizationId });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.organizationId, user.organizationId);
    assert.deepEqual(res.body.user.organizations.map((organization) => organization.role), ['member']);
  });

  it("won't delete the only admin of an organization that still has members", async () => {
    await createUser({ organization: { id: user.organizationId } });

    const res = await api('delete', `/api/admin/users/${user.id}`, admin);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /only admin/);
  });

  it('updates another user', async () => {
    const res = await api('put', `/api/admin/users/${user.id}`, admin)
      .send({ name: 'Renamed', role: 'admin', isVerified: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.name, 'Renamed');
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.isVerified, true);
  });

  it('rejects an invalid email on update', async () => {
    const res = await api('put', `/api/admin/users/${user.id}`, admin).send({ email: 'nope' });

    assert.equal(res.status, 400);
  });

  it('prevents an admin from removing their own admin role', async () => {
    const res = await api('put', `/api/admin/users/${admin.id}`, admin).send({ role: 'user' });

    assert.equal(res.status, 400);
    assert.equal((await User.findByPk(admin.id)).role, 'admin');
  });

  it('prevents an admin from deleting their own account', async () => {
    const res = await api('delete', `/api/admin/users/${admin.id}`, admin);

    assert.equal(res.status, 400);
    assert.ok(await User.findByPk(admin.id));
  });

  it("deletes a user and their applications", async () => {
    await api('post', '/api/applications', user).send(VALID_APP);
    assert.equal(await Application.count(), 1);

    const res = await api('delete', `/api/admin/users/${user.id}`, admin);

    assert.equal(res.status, 200);
    assert.equal(await User.findByPk(user.id), null);
    assert.equal(await Application.count(), 0);
  });

  it('issues a token for a user', async () => {
    const res = await api('post', '/api/admin/token', admin).send({ userId: user.id });

    assert.equal(res.status, 200);
    const me = await api('get', '/api/applications', user).set('Authorization', `Bearer ${res.body.token}`);
    assert.equal(me.status, 200);
  });
});

describe('admin pages', () => {
  beforeEach(resetDatabase);

  it('renders the admin dashboard for admins', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await browser('get', '/developer/admin', admin);

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Admin Dashboard'));
  });

  it('redirects regular users to the login page', async () => {
    const user = await createUser();
    const res = await browser('get', '/developer/admin', user);

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login');
  });
});

describe('admin management of user applications', () => {
  let admin;
  let owner;
  let applicationId;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ role: 'admin' });
    owner = await createUser({ name: 'Grace Hopper' });
    const { body } = await api('post', '/api/applications', owner).send(VALID_APP);
    applicationId = body.application.id;
  });

  it('lists every application with its owner', async () => {
    const res = await api('get', '/api/admin/applications', admin);

    assert.equal(res.status, 200);
    assert.equal(res.body.applications.length, 1);
    assert.equal(res.body.applications[0].owner.name, 'Grace Hopper');
    assert.doesNotMatch(JSON.stringify(res.body), /clientSecret/);
  });

  it("lists one user's applications", async () => {
    const res = await api('get', `/api/admin/users/${owner.id}/applications`, admin);
    const missing = await api('get', '/api/admin/users/00000000-0000-0000-0000-000000000000/applications', admin);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.applications.map((application) => application.id), [applicationId]);
    assert.equal(missing.status, 404);
  });

  it("reads and updates another user's application", async () => {
    const read = await api('get', `/api/admin/applications/${applicationId}`, admin);
    const update = await api('put', `/api/admin/applications/${applicationId}`, admin)
      .send({ name: 'Renamed by admin', redirectUris: ['https://new.example/cb'] });
    const invalid = await api('put', `/api/admin/applications/${applicationId}`, admin)
      .send({ redirectUris: ['javascript:alert(1)'] });

    assert.equal(read.status, 200);
    assert.equal(read.body.application.owner.id, owner.id);
    assert.equal(update.status, 200);
    assert.equal(update.body.application.name, 'Renamed by admin');
    assert.equal(invalid.status, 400);

    const stored = await Application.findByPk(applicationId);
    assert.equal(stored.userId, owner.id);
    assert.deepEqual(stored.redirectUris, ['https://new.example/cb']);
  });

  it("deletes another user's application", async () => {
    const res = await api('delete', `/api/admin/applications/${applicationId}`, admin);

    assert.equal(res.status, 200);
    assert.equal(await Application.count(), 0);
  });

  it('keeps the admin application endpoints admin-only', async () => {
    const stranger = await createUser();
    const responses = await Promise.all([
      api('get', '/api/admin/applications', stranger),
      api('get', `/api/admin/applications/${applicationId}`, stranger),
      api('put', `/api/admin/applications/${applicationId}`, stranger).send({ name: 'Hijacked' }),
      api('delete', `/api/admin/applications/${applicationId}`, stranger),
      api('put', `/api/admin/users/${owner.id}/password`, stranger).send({ password: 'hijacked123' }),
    ]);

    responses.forEach((res) => assert.equal(res.status, 403));
    assert.equal((await Application.findByPk(applicationId)).name, 'My App');
  });
});

describe('admin password reset', () => {
  beforeEach(resetDatabase);

  it("sets a user's password so they can sign in with it", async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser({ email: 'grace@example.com', password: 'old-password' });

    const tooShort = await api('put', `/api/admin/users/${user.id}/password`, admin).send({ password: 'short' });
    const res = await api('put', `/api/admin/users/${user.id}/password`, admin).send({ password: 'brand-new-pass' });

    assert.equal(tooShort.status, 400);
    assert.equal(res.status, 200);
    assert.doesNotMatch(JSON.stringify(res.body), /brand-new-pass|\$2/);

    const oldLogin = await request(app).post('/auth/login').send({ email: 'grace@example.com', password: 'old-password' });
    const newLogin = await request(app).post('/auth/login').send({ email: 'grace@example.com', password: 'brand-new-pass' });
    assert.equal(oldLogin.status, 400);
    assert.equal(newLogin.status, 200);
  });
});

describe('admin management pages', () => {
  let admin;
  let owner;
  let applicationId;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ role: 'admin' });
    owner = await createUser({ name: 'Grace Hopper' });
    const { body } = await api('post', '/api/applications', owner).send({ ...VALID_APP, name: 'Compiler <b>App</b>' });
    applicationId = body.application.id;
  });

  it("shows a user's profile and applications on their management page", async () => {
    const res = await browser('get', `/developer/admin/users/${owner.id}`, admin);

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Grace Hopper'));
    assert.ok(res.text.includes('Compiler &lt;b&gt;App&lt;/b&gt;'));
    assert.ok(res.text.includes(`/api/admin/applications/${applicationId}`));
    assert.ok(res.text.includes('Set a new password'));
  });

  it('redirects the old edit URL to the management page', async () => {
    const res = await browser('get', `/developer/admin/users/${owner.id}/edit`, admin);

    assert.equal(res.status, 301);
    assert.equal(res.headers.location, `/developer/admin/users/${owner.id}`);
  });

  it('lists all applications with their owners', async () => {
    const res = await browser('get', '/developer/admin/applications', admin);

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Grace Hopper'));
    assert.ok(res.text.includes('Compiler &lt;b&gt;App&lt;/b&gt;'));
  });

  it("opens any user's application in admin mode", async () => {
    const res = await browser('get', `/developer/admin/applications/${applicationId}`, admin);

    assert.equal(res.status, 200);
    assert.ok(res.text.includes(`data-api-url="/api/admin/applications/${applicationId}"`));
    assert.ok(res.text.includes('Manage user'));
  });

  it('shows application counts on the admin dashboard', async () => {
    const res = await browser('get', '/developer/admin', admin);

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('1 app<'));
    assert.ok(res.text.includes(`href="/developer/admin/users/${owner.id}"`));
  });

  it('keeps the management pages admin-only', async () => {
    for (const path of [`/developer/admin/users/${owner.id}`, '/developer/admin/applications', `/developer/admin/applications/${applicationId}`]) {
      const res = await browser('get', path, owner);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.location, '/login');
    }
  });
});

describe('admin: organizations', () => {
  let admin;
  let owner;
  let teammate;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ role: 'admin', name: 'Platform Admin' });
    owner = await createUser({ name: 'Acme Owner' });
    teammate = await createUser({ name: 'Acme Teammate', organization: { id: owner.organizationId } });
  });

  const orgUrl = () => `/api/admin/organizations/${owner.organizationId}`;

  it('lists every organization with what it holds', async () => {
    await api('post', '/api/org/catalogs', owner).send({ name: 'Partner APIs' });
    const res = await api('get', '/api/admin/organizations', admin);
    const acme = res.body.organizations.find((organization) => organization.id === owner.organizationId);

    assert.equal(res.status, 200);
    assert.equal(res.body.organizations.length, 2);
    assert.equal(acme.counts.members, 2);
    assert.equal(acme.counts.catalogs, 1);
    assert.equal((await api('get', '/api/admin/organizations', owner)).status, 403);

    const detail = await api('get', orgUrl(), admin);
    assert.deepEqual(detail.body.organization.catalogs.map((catalog) => catalog.name), ['Partner APIs']);
    assert.deepEqual(detail.body.organization.members.map((member) => [member.name, member.orgRole]).sort(), [['Acme Owner', 'admin'], ['Acme Teammate', 'member']]);
  });

  it('manages members and always keeps an admin', async () => {
    const outsider = await createUser({ name: 'Outsider' });
    const added = await api('post', `${orgUrl()}/members`, admin).send({ email: outsider.email, orgRole: 'member' });
    const again = await api('post', `${orgUrl()}/members`, admin).send({ email: outsider.email });
    const unknown = await api('post', `${orgUrl()}/members`, admin).send({ email: 'nobody@example.com' });
    assert.equal(added.status, 201);
    assert.equal(again.status, 409);
    assert.equal(unknown.status, 404);

    const demoteLast = await api('put', `${orgUrl()}/members/${owner.id}`, admin).send({ orgRole: 'member' });
    assert.equal(demoteLast.status, 409);
    const promote = await api('put', `${orgUrl()}/members/${teammate.id}`, admin).send({ orgRole: 'admin' });
    assert.equal(promote.status, 200);
    const demote = await api('put', `${orgUrl()}/members/${owner.id}`, admin).send({ orgRole: 'member' });
    assert.equal(demote.status, 200);

    const removed = await api('delete', `${orgUrl()}/members/${outsider.id}`, admin);
    assert.equal(removed.status, 200);
    // The account and its own organization stay.
    assert.ok(await User.findByPk(outsider.id));
  });

  it('creates, renames and deletes empty organizations', async () => {
    const created = await api('post', '/api/admin/organizations', admin).send({ name: 'Beta Labs', adminEmail: teammate.email });
    assert.equal(created.status, 201);
    const betaUrl = `/api/admin/organizations/${created.body.organization.id}`;
    const detail = await api('get', betaUrl, admin);
    assert.deepEqual(detail.body.organization.members.map((member) => member.orgRole), ['admin']);

    assert.equal((await api('put', betaUrl, admin).send({ name: 'Beta Labs GmbH' })).body.organization.name, 'Beta Labs GmbH');

    await api('post', '/api/org/catalogs', owner).send({ name: 'Busy' });
    const blocked = await api('delete', orgUrl(), admin);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /catalogs/);

    const deleted = await api('delete', betaUrl, admin);
    assert.equal(deleted.status, 200);
    assert.equal((await api('get', betaUrl, admin)).status, 404);
  });

  it('lets a platform admin work in any organization as its admin', async () => {
    const switched = await api('put', '/api/me/organization', admin).send({ organizationId: owner.organizationId });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.organization.role, 'admin');

    const catalog = await api('post', '/api/org/catalogs', admin).send({ name: 'Made by platform admin' });
    assert.equal(catalog.status, 201);
    const ownerView = await api('get', '/api/org/catalogs', owner);
    assert.deepEqual(ownerView.body.catalogs.map((item) => item.name), ['Made by platform admin']);

    const page = await browser('get', '/developer/catalogs', admin);
    assert.ok(page.text.includes('as platform admin'));
    // Regular users can't switch into organizations they don't belong to.
    assert.equal((await api('put', '/api/me/organization', teammate).send({ organizationId: admin.organizationId })).status, 404);
  });

  it('renders the organization pages and user memberships', async () => {
    const pages = await Promise.all([
      browser('get', '/developer/admin/organizations', admin),
      browser('get', `/developer/admin/organizations/${owner.organizationId}`, admin),
      browser('get', `/developer/admin?organizationId=${owner.organizationId}`, admin),
      browser('get', `/developer/admin/users/${teammate.id}`, admin),
    ]);
    pages.forEach((page) => assert.equal(page.status, 200, page.req.path));
    assert.ok(pages[0].text.includes('New organization'));
    assert.ok(pages[1].text.includes('Acme Teammate'));
    assert.ok(pages[2].text.includes('Acme Owner'));
    assert.ok(!pages[2].text.includes('Platform Admin</a>'));
    assert.ok(pages[3].text.includes('Add to an organization'));
    assert.equal((await browser('get', '/developer/admin/organizations', owner)).status, 302);
  });
});
