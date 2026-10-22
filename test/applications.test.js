const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  app,
  request,
  Application,
  Token,
  resetDatabase,
  createUser,
  api,
  browser,
  VALID_APP,
} = require('./helpers');

const createApp = (user, body = VALID_APP) => api('post', '/api/applications', user).send(body);

describe('applications API', () => {
  let owner;
  let other;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser();
    other = await createUser();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/applications');

    assert.equal(res.status, 401);
  });

  it('returns the client secret once and stores only its hash', async () => {
    const res = await createApp(owner);

    assert.equal(res.status, 201);
    const { clientSecret, clientId, redirectUris } = res.body.application;
    assert.ok(clientSecret.length >= 40);
    assert.deepEqual(redirectUris, ['https://example.com/callback']);

    const stored = await Application.findOne({ where: { clientId } });
    assert.notEqual(stored.clientSecret, clientSecret);
    assert.equal(stored.verifyClientSecret(clientSecret), true);
    assert.equal(stored.verifyClientSecret('wrong-secret'), false);
  });

  it('never returns the secret or its hash when listing, reading, or updating', async () => {
    const { body } = await createApp(owner);
    const { id } = body.application;

    const list = await api('get', '/api/applications', owner);
    const single = await api('get', `/api/applications/${id}`, owner);
    const updated = await api('put', `/api/applications/${id}`, owner).send({ name: 'Renamed' });

    for (const res of [list, single, updated]) {
      assert.equal(res.status, 200);
      assert.doesNotMatch(JSON.stringify(res.body), /clientSecret/);
    }
    assert.deepEqual(list.body.applications[0].redirectUris, ['https://example.com/callback']);
  });

  it('accepts redirect URIs as an array, a JSON string, or one per line', async () => {
    const inputs = [
      ['https://a.example/cb', 'http://localhost:8080/cb'],
      JSON.stringify(['https://a.example/cb', 'http://localhost:8080/cb']),
      'https://a.example/cb\nhttp://localhost:8080/cb\n',
    ];

    for (const redirectUris of inputs) {
      const res = await createApp(owner, { name: 'App', redirectUris });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.application.redirectUris, ['https://a.example/cb', 'http://localhost:8080/cb']);
    }
  });

  for (const [label, body] of [
    ['a missing name', { redirectUris: ['https://example.com/cb'] }],
    ['missing redirect URIs', { name: 'App' }],
    ['an empty redirect URI list', { name: 'App', redirectUris: [] }],
    ['a javascript: redirect URI', { name: 'App', redirectUris: ['javascript:alert(1)'] }],
    ['plain http to a public host', { name: 'App', redirectUris: ['http://example.com/cb'] }],
    ['a redirect URI with a fragment', { name: 'App', redirectUris: ['https://example.com/cb#x'] }],
    ['a relative redirect URI', { name: 'App', redirectUris: ['/callback'] }],
    ['a non-string description', { ...VALID_APP, description: { evil: true } }],
  ]) {
    it(`rejects ${label}`, async () => {
      const res = await createApp(owner, body);

      assert.equal(res.status, 400);
      assert.ok(res.body.error);
      assert.equal(await Application.count(), 0);
    });
  }

  it('updates only the provided fields and validates them', async () => {
    const { body } = await createApp(owner);
    const { id } = body.application;

    const bad = await api('put', `/api/applications/${id}`, owner).send({ redirectUris: ['ftp://x'] });
    assert.equal(bad.status, 400);

    const good = await api('put', `/api/applications/${id}`, owner).send({ description: 'New description' });
    assert.equal(good.status, 200);
    assert.equal(good.body.application.name, 'My App');
    assert.equal(good.body.application.description, 'New description');
    assert.deepEqual(good.body.application.redirectUris, ['https://example.com/callback']);
  });

  it("does not let another user read, update, or delete someone else's application", async () => {
    const { body } = await createApp(owner);
    const { id } = body.application;

    const read = await api('get', `/api/applications/${id}`, other);
    const update = await api('put', `/api/applications/${id}`, other).send({ name: 'Hijacked' });
    const remove = await api('delete', `/api/applications/${id}`, other);

    assert.equal(read.status, 404);
    assert.equal(update.status, 404);
    assert.equal(remove.status, 404);
    assert.equal((await Application.findByPk(id)).name, 'My App');
  });

  it('deletes the application together with its tokens', async () => {
    const { body } = await createApp(owner);
    const { id } = body.application;
    await Token.create({
      userId: owner.id,
      applicationId: id,
      accessToken: 'access-1',
      expiresIn: 3600,
      tokenType: 'Bearer',
      scope: 'openid',
      accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const res = await api('delete', `/api/applications/${id}`, owner);

    assert.equal(res.status, 200);
    assert.equal(await Application.count(), 0);
    assert.equal(await Token.count(), 0);
  });
});

describe('developer application pages', () => {
  let owner;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser();
  });

  it('escapes application data in the dashboard', async () => {
    await createApp(owner, { ...VALID_APP, name: '<script>alert(1)</script>' });

    const res = await browser('get', '/developer/dashboard', owner);

    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<script>alert(1)</script>'));
    assert.ok(res.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  it('shows the application detail page to its owner only', async () => {
    const { body } = await createApp(owner);
    const { id } = body.application;
    const stranger = await createUser();

    const mine = await browser('get', `/developer/applications/${id}`, owner);
    const theirs = await browser('get', `/developer/applications/${id}`, stranger);

    assert.equal(mine.status, 200);
    assert.ok(mine.text.includes('https://example.com/callback'));
    assert.equal(theirs.status, 404);
  });

  it('creates an application from the no-JavaScript form and ignores the query string', async () => {
    const res = await browser('post', '/developer/applications/create?name=FromQuery', owner)
      .type('form')
      .send({ name: 'From Form', redirectUris: 'https://example.com/cb\nhttps://example.com/cb2' });

    assert.equal(res.status, 201);
    assert.ok(res.text.includes('From Form'));
    const stored = await Application.findOne({ where: { userId: owner.id } });
    assert.equal(stored.name, 'From Form');
    assert.deepEqual(stored.redirectUris, ['https://example.com/cb', 'https://example.com/cb2']);
  });

  it('reads legacy newline-separated redirect URIs', async () => {
    const legacy = Application.build({ redirectUris: [] });
    legacy.setDataValue('redirectUris', 'https://old.example/cb\nhttps://old.example/cb2');

    assert.deepEqual(legacy.redirectUris, ['https://old.example/cb', 'https://old.example/cb2']);
  });
});

describe('redesigned pages', () => {
  let owner;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser({ name: 'Ada Lovelace' });
  });

  it('server-renders the applications list with escaped data', async () => {
    await createApp(owner, { ...VALID_APP, name: '<img src=x onerror=alert(1)>' });

    const res = await browser('get', '/developer/applications', owner);

    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<img src=x'));
    assert.ok(res.text.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('shows an empty state when there are no applications', async () => {
    const res = await browser('get', '/developer/applications', owner);

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('No applications yet'));
  });

  it('flags legacy redirect URIs that fail validation on the detail page', async () => {
    const { body } = await createApp(owner);
    const stored = await Application.findByPk(body.application.id);
    stored.setDataValue('redirectUris', 'not-a-url');
    await stored.save();

    const res = await browser('get', `/developer/applications/${stored.id}`, owner);

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Some redirect URIs need attention'));
  });

  it('renders the shared navigation with the user initials', async () => {
    const res = await browser('get', '/developer/applications', owner);

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('>AL</'));
    assert.match(res.text, /href="\/developer\/applications" class="app-nav-link" aria-current="page"/);
  });

  it('renders a friendly 404 page for unknown pages', async () => {
    const res = await request(app).get('/no-such-page').set('Accept', 'text/html');

    assert.equal(res.status, 404);
    assert.ok(res.text.includes('Page not found'));
  });

  it('renders a friendly 404 page for a missing application', async () => {
    const res = await browser('get', '/developer/applications/00000000-0000-0000-0000-000000000000', owner);

    assert.equal(res.status, 404);
    assert.ok(res.text.includes('Application not found'));
  });
});
