const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  app,
  request,
  models,
  User,
  resetDatabase,
  createUser,
  api,
  browser,
} = require('./helpers');

const { Invitation, Organization, Membership } = models;
const roleIn = async (user, organizationId) => (await Membership.findOne({ where: { userId: user.id, organizationId } }))?.role;

const tokenFromUrl = (url) => url.split('/invite/')[1];

describe('organization members', () => {
  let admin;
  let member;
  let outsider;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ name: 'Org Admin' });
    member = await createUser({ name: 'Team Member', organization: { id: admin.organizationId } });
    outsider = await createUser({ name: 'Outsider' });
  });

  it('lists only members of your own organization', async () => {
    const res = await api('get', '/api/org/members', member);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.members.map((m) => m.name).sort(), ['Org Admin', 'Team Member']);
  });

  it('lets an org admin add a member manually', async () => {
    const res = await api('post', '/api/org/members', admin)
      .send({ name: 'Grace', email: 'Grace@Example.com', password: 'password123', orgRole: 'member' });

    assert.equal(res.status, 201);
    assert.equal(res.body.existingAccount, false);
    const grace = await User.findOne({ where: { email: 'grace@example.com' } });
    assert.equal(grace.organizationId, admin.organizationId);
    assert.equal(await roleIn(grace, admin.organizationId), 'member');

    const login = await request(app).post('/auth/login').send({ email: 'grace@example.com', password: 'password123' });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.organization.id, admin.organizationId);
  });

  it('validates manually added members', async () => {
    const weak = await api('post', '/api/org/members', admin).send({ name: 'G', email: 'g@example.com', password: 'short' });
    const badRole = await api('post', '/api/org/members', admin).send({ name: 'G', email: 'g@example.com', password: 'password123', orgRole: 'owner' });
    const noName = await api('post', '/api/org/members', admin).send({ email: 'g@example.com', password: 'password123' });
    const already = await api('post', '/api/org/members', admin).send({ email: member.email });

    assert.equal(weak.status, 400);
    assert.equal(badRole.status, 400);
    assert.equal(noName.status, 400);
    assert.equal(already.status, 409);
  });

  it('adds an existing account without touching its other organizations', async () => {
    const res = await api('post', '/api/org/members', admin).send({ email: outsider.email, orgRole: 'member' });

    assert.equal(res.status, 201);
    assert.equal(res.body.existingAccount, true);
    assert.equal(await roleIn(outsider, admin.organizationId), 'member');
    assert.equal(await roleIn(outsider, outsider.organizationId), 'admin');
    // Their selected organization stays the same until they switch.
    assert.equal((await User.findByPk(outsider.id)).organizationId, outsider.organizationId);
  });

  it('keeps member management admin-only', async () => {
    const add = await api('post', '/api/org/members', member).send({ name: 'G', email: 'g@example.com', password: 'password123' });
    const promote = await api('put', `/api/org/members/${member.id}`, member).send({ orgRole: 'admin' });
    const invite = await api('post', '/api/org/invitations', member).send({ email: 'x@example.com' });

    assert.equal(add.status, 403);
    assert.equal(promote.status, 403);
    assert.equal(invite.status, 403);
  });

  it('changes member roles but not your own', async () => {
    const promote = await api('put', `/api/org/members/${member.id}`, admin).send({ orgRole: 'admin' });
    const self = await api('put', `/api/org/members/${admin.id}`, admin).send({ orgRole: 'member' });

    assert.equal(promote.status, 200);
    assert.equal(await roleIn(member, admin.organizationId), 'admin');
    assert.equal(self.status, 400);
  });

  it("can't touch members of another organization", async () => {
    const promote = await api('put', `/api/org/members/${outsider.id}`, admin).send({ orgRole: 'member' });
    const remove = await api('delete', `/api/org/members/${outsider.id}`, admin);

    assert.equal(promote.status, 404);
    assert.equal(remove.status, 404);
  });

  it('removes only the membership; the account and its other organizations stay', async () => {
    const otherOrganization = await Organization.create({ name: 'Second Org' });
    await Membership.create({ userId: member.id, organizationId: otherOrganization.id, role: 'admin' });

    const res = await api('delete', `/api/org/members/${member.id}`, admin);
    const self = await api('delete', `/api/org/members/${admin.id}`, admin);

    assert.equal(res.status, 200);
    assert.equal(self.status, 400);
    assert.equal(await roleIn(member, admin.organizationId), undefined);
    // They were working in the organization they were removed from: they move to their next one.
    const moved = await User.findByPk(member.id);
    assert.equal(moved.organizationId, otherOrganization.id);
    const { body } = await api('get', '/api/org', member);
    assert.equal(body.organization.name, 'Second Org');
  });

  it('renames the organization', async () => {
    const res = await api('put', '/api/org', admin).send({ name: 'Renamed Inc.' });
    const tooShort = await api('put', '/api/org', admin).send({ name: 'X' });

    assert.equal(res.status, 200);
    assert.equal((await Organization.findByPk(admin.organizationId)).name, 'Renamed Inc.');
    assert.equal(tooShort.status, 400);
  });
});

describe('invitations', () => {
  let admin;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ name: 'Org Admin' });
  });

  const invite = (email = 'new@example.com', orgRole = 'member') => api('post', '/api/org/invitations', admin).send({ email, orgRole });

  it('creates an invitation and returns a shareable link when email is not configured', async () => {
    const res = await invite('New@Example.com');

    assert.equal(res.status, 201);
    assert.equal(res.body.invitation.email, 'new@example.com');
    assert.equal(res.body.emailSent, false);
    assert.equal(res.body.mailConfigured, false);
    assert.match(res.body.inviteUrl, /\/invite\/[\w-]{40,}$/);

    // Only a hash of the token is stored.
    const stored = await Invitation.findByPk(res.body.invitation.id);
    assert.notEqual(stored.tokenHash, tokenFromUrl(res.body.inviteUrl));
  });

  it('rejects duplicate invitations and people who are already members', async () => {
    await invite('new@example.com');
    const duplicate = await invite('new@example.com');
    const existing = await invite(admin.email);

    assert.equal(duplicate.status, 409);
    assert.equal(existing.status, 409);
  });

  it('lets someone with an account join with their password and keep their organizations', async () => {
    const elsewhere = await createUser({ name: 'Elsewhere', password: 'mypassword1' });
    const { body } = await invite(elsewhere.email, 'member');
    const token = tokenFromUrl(body.inviteUrl);

    const page = await request(app).get(`/invite/${token}`);
    assert.ok(page.text.includes('Enter the password of your account'));
    assert.ok(!page.text.includes('Full name'));

    const wrong = await request(app).post('/auth/accept-invite').send({ token, password: 'not-it-at-all' });
    assert.equal(wrong.status, 400);

    const res = await request(app).post('/auth/accept-invite').send({ token, password: 'mypassword1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.organization.id, admin.organizationId);
    assert.equal(res.body.user.orgRole, 'member');
    assert.deepEqual(res.body.user.organizations.map((organization) => organization.role).sort(), ['admin', 'member']);
    assert.equal(await roleIn(elsewhere, elsewhere.organizationId), 'admin');
  });

  it('accepts an invitation into the organization with the invited role', async () => {
    const { body } = await invite('new@example.com', 'admin');
    const token = tokenFromUrl(body.inviteUrl);

    const page = await request(app).get(`/invite/${token}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Join Org'));

    const res = await request(app).post('/auth/accept-invite').send({ token, name: 'New Person', password: 'password123' });
    assert.equal(res.status, 201);
    assert.match(res.headers['set-cookie'][0], /^token=/);
    assert.equal(res.body.user.orgRole, 'admin');
    assert.equal(res.body.user.organization.id, admin.organizationId);

    const user = await User.findOne({ where: { email: 'new@example.com' } });
    assert.equal(user.isVerified, true);

    const reuse = await request(app).post('/auth/accept-invite').send({ token, name: 'Again', password: 'password123' });
    assert.equal(reuse.status, 400);
  });

  it('refuses invalid and expired invitations', async () => {
    const { body } = await invite();
    const token = tokenFromUrl(body.inviteUrl);
    await Invitation.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: body.invitation.id } });

    const expired = await request(app).post('/auth/accept-invite').send({ token, name: 'Late', password: 'password123' });
    const bogus = await request(app).post('/auth/accept-invite').send({ token: 'not-a-token', name: 'X', password: 'password123' });
    const page = await request(app).get(`/invite/${token}`);

    assert.equal(expired.status, 400);
    assert.equal(bogus.status, 400);
    assert.ok(page.text.includes('Invitation unavailable'));
  });

  it('resending issues a new link and invalidates the old one', async () => {
    const { body } = await invite();
    const oldToken = tokenFromUrl(body.inviteUrl);

    const resent = await api('post', `/api/org/invitations/${body.invitation.id}/resend`, admin);
    const newToken = tokenFromUrl(resent.body.inviteUrl);

    assert.equal(resent.status, 200);
    assert.notEqual(newToken, oldToken);
    const old = await request(app).post('/auth/accept-invite').send({ token: oldToken, name: 'Old', password: 'password123' });
    const fresh = await request(app).post('/auth/accept-invite').send({ token: newToken, name: 'Fresh', password: 'password123' });
    assert.equal(old.status, 400);
    assert.equal(fresh.status, 201);
  });

  it('revokes invitations', async () => {
    const { body } = await invite();
    const res = await api('delete', `/api/org/invitations/${body.invitation.id}`, admin);
    const accept = await request(app).post('/auth/accept-invite')
      .send({ token: tokenFromUrl(body.inviteUrl), name: 'Late', password: 'password123' });

    assert.equal(res.status, 200);
    assert.equal(accept.status, 400);
  });

  it("can't manage another organization's invitations", async () => {
    const { body } = await invite();
    const otherAdmin = await createUser();

    const resend = await api('post', `/api/org/invitations/${body.invitation.id}/resend`, otherAdmin);
    const revoke = await api('delete', `/api/org/invitations/${body.invitation.id}`, otherAdmin);

    assert.equal(resend.status, 404);
    assert.equal(revoke.status, 404);
  });
});

describe('organization page', () => {
  beforeEach(resetDatabase);

  it('shows members to everyone and management tools only to admins', async () => {
    const admin = await createUser({ name: 'Org Admin' });
    const member = await createUser({ name: 'Team Member', organization: { id: admin.organizationId } });

    const adminView = await browser('get', '/developer/organization', admin);
    const memberView = await browser('get', '/developer/organization', member);

    assert.equal(adminView.status, 200);
    assert.ok(adminView.text.includes('Invite by email'));
    assert.ok(adminView.text.includes('Team Member'));
    assert.equal(memberView.status, 200);
    assert.ok(memberView.text.includes('Org Admin'));
    assert.ok(!memberView.text.includes('Invite by email'));
  });
});

describe('multiple organizations', () => {
  let admin;
  let other;

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ name: 'Multi Admin' });
    other = await Organization.create({ name: 'Second Co' });
  });

  it('lists the organizations and switches between them', async () => {
    await Membership.create({ userId: admin.id, organizationId: other.id, role: 'member' });

    const list = await api('get', '/api/me/organizations', admin);
    assert.equal(list.status, 200);
    assert.equal(list.body.current.id, admin.organizationId);
    assert.equal(list.body.organizations.length, 2);

    const switched = await api('put', '/api/me/organization', admin).send({ organizationId: other.id });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.organization.role, 'member');

    // As a member there, management is closed.
    assert.equal((await api('get', '/api/org/apis', admin)).status, 403);
    assert.equal((await api('get', '/api/org', admin)).body.organization.name, 'Second Co');

    const stranger = await Organization.create({ name: 'Stranger Ltd' });
    assert.equal((await api('put', '/api/me/organization', admin).send({ organizationId: stranger.id })).status, 404);
  });

  it('lets org admins create organizations and keeps at least one admin when leaving', async () => {
    const created = await api('post', '/api/me/organizations', admin).send({ name: 'New Venture' });
    assert.equal(created.status, 201);
    assert.equal((await User.findByPk(admin.id)).organizationId, created.body.organization.id);
    assert.equal(await roleIn(admin, created.body.organization.id), 'admin');

    const leave = await api('delete', `/api/me/organizations/${created.body.organization.id}`, admin);
    assert.equal(leave.status, 409);

    // A member who is not an admin anywhere can't create organizations.
    const member = await createUser({ name: 'Plain Member', organization: other });
    assert.equal((await api('post', '/api/me/organizations', member).send({ name: 'Nope Inc' })).status, 403);
    const left = await api('delete', `/api/me/organizations/${other.id}`, member);
    assert.equal(left.status, 200);
    assert.equal((await User.findByPk(member.id)).organizationId, null);
    // With no organization left, they may start their own.
    assert.equal((await api('post', '/api/me/organizations', member).send({ name: 'Fresh Start' })).status, 201);
  });

  it('shows the switcher with every organization', async () => {
    await Membership.create({ userId: admin.id, organizationId: other.id, role: 'member' });
    const page = await browser('get', '/developer/dashboard', admin);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-switch-org="[^"]+"/);
    assert.ok(page.text.includes('Second Co'));
  });
});
