const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, User, resetDatabase, createUser } = require('./helpers');

const register = (body) => request(app).post('/auth/register').send({ organizationName: 'Acme Inc.', ...body });
const login = (body) => request(app).post('/auth/login').send(body);

describe('POST /auth/register', () => {
  beforeEach(resetDatabase);

  it('creates a regular user and sets an HttpOnly auth cookie', async () => {
    const res = await register({ name: 'Ada', email: 'ada@example.com', password: 'password123' });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'user');
    assert.ok(res.body.token);
    assert.match(res.headers['set-cookie'][0], /^token=.+; HttpOnly; Path=\/; SameSite=Lax/);
  });

  it('creates a new organization with the user as its admin', async () => {
    const res = await register({ name: 'Ada', email: 'ada@example.com', password: 'password123', organizationName: '  Analytical Engines  ' });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.orgRole, 'admin');
    assert.equal(res.body.user.organization.name, 'Analytical Engines');
    const user = await User.findOne({ where: { email: 'ada@example.com' } });
    assert.equal(user.organizationId, res.body.user.organization.id);
  });

  it('gives every registration its own organization', async () => {
    const first = await register({ name: 'Ada', email: 'ada@example.com', password: 'password123', organizationName: 'Same Name' });
    const second = await register({ name: 'Bob', email: 'bob@example.com', password: 'password123', organizationName: 'Same Name' });

    assert.notEqual(first.body.user.organization.id, second.body.user.organization.id);
  });

  it('ignores a role supplied by the client', async () => {
    const res = await register({ name: 'Eve', email: 'eve@example.com', password: 'password123', role: 'admin' });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'user');
  });

  it('normalizes the email address', async () => {
    const res = await register({ name: 'Ada', email: '  Ada@Example.COM ', password: 'password123' });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'ada@example.com');
  });

  for (const [label, body, message] of [
    ['missing password', { name: 'Ada', email: 'ada@example.com' }, /Password/],
    ['short password', { name: 'Ada', email: 'ada@example.com', password: 'short' }, /at least 8/],
    ['invalid email', { name: 'Ada', email: 'not-an-email', password: 'password123' }, /email/],
    ['missing name', { email: 'ada@example.com', password: 'password123' }, /Name/],
    ['missing organization name', { name: 'Ada', email: 'ada@example.com', password: 'password123', organizationName: undefined }, /Organization name/],
    ['too short organization name', { name: 'Ada', email: 'ada@example.com', password: 'password123', organizationName: 'A' }, /Organization name/],
  ]) {
    it(`rejects ${label} with 400`, async () => {
      const res = await register(body);

      assert.equal(res.status, 400);
      assert.match(res.body.error, message);
      assert.equal(await User.count(), 0);
    });
  }

  it('rejects a duplicate email', async () => {
    await register({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
    const res = await register({ name: 'Ada 2', email: 'ADA@example.com', password: 'password123' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'User already exists');
  });

  it('returns a clean error for malformed JSON', async () => {
    const res = await request(app)
      .post('/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"name":');

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.doesNotMatch(JSON.stringify(res.body), /at JSON\.parse|node_modules/);
  });
});

describe('POST /auth/login', () => {
  beforeEach(resetDatabase);

  it('logs in with valid credentials (email is case-insensitive)', async () => {
    await createUser({ email: 'ada@example.com', password: 'password123' });
    const res = await login({ email: 'ADA@example.com', password: 'password123' });

    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.ok(res.headers['set-cookie']);
  });

  it('returns the same generic error for a wrong password and an unknown user', async () => {
    await createUser({ email: 'ada@example.com', password: 'password123' });
    const wrongPassword = await login({ email: 'ada@example.com', password: 'nope-nope' });
    const unknownUser = await login({ email: 'ghost@example.com', password: 'password123' });

    assert.equal(wrongPassword.status, 400);
    assert.equal(unknownUser.status, 400);
    assert.equal(wrongPassword.body.error, 'Invalid credentials');
    assert.equal(unknownUser.body.error, 'Invalid credentials');
  });

  it('rejects a missing password without a server error', async () => {
    const res = await login({ email: 'ada@example.com' });

    assert.equal(res.status, 400);
  });

  it('rate limits repeated failed logins', async () => {
    await createUser({ email: 'ada@example.com', password: 'password123' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await login({ email: 'ada@example.com', password: 'wrong-password' });
      assert.equal(res.status, 400);
    }

    const blocked = await login({ email: 'ada@example.com', password: 'password123' });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers['retry-after']);
  });

  it('does not count successful logins towards the limit', async () => {
    await createUser({ email: 'ada@example.com', password: 'password123' });
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const res = await login({ email: 'ada@example.com', password: 'password123' });
      assert.equal(res.status, 200);
    }
  });
});

describe('token minting', () => {
  beforeEach(resetDatabase);

  it('no longer exposes the unauthenticated POST /auth/token endpoint', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await request(app).post('/auth/token').send({ userId: admin.id });

    assert.equal(res.status, 404);
    assert.equal(res.body.token, undefined);
  });
});

describe('POST /auth/logout', () => {
  it('clears the auth cookie', async () => {
    const res = await request(app).post('/auth/logout').set('Accept', 'application/json');

    assert.equal(res.status, 200);
    assert.match(res.headers['set-cookie'][0], /^token=; .*Max-Age=0/);
  });

  it('redirects browsers to the login page', async () => {
    const res = await request(app).post('/auth/logout').set('Accept', 'text/html');

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login');
  });
});
