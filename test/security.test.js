const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const {
  app,
  request,
  HOST,
  ORIGIN,
  resetDatabase,
  createUser,
  tokenFor,
  VALID_APP,
} = require('./helpers');

describe('CSRF protection for cookie-authenticated requests', () => {
  let user;

  beforeEach(async () => {
    await resetDatabase();
    user = await createUser();
  });

  const cookiePost = () => request(app)
    .post('/api/applications')
    .set('Host', HOST)
    .set('Cookie', `token=${tokenFor(user)}`);

  it('allows same-origin requests', async () => {
    const res = await cookiePost().set('Origin', ORIGIN).send(VALID_APP);

    assert.equal(res.status, 201);
  });

  it('accepts a same-origin Referer when Origin is missing', async () => {
    const res = await cookiePost().set('Referer', `${ORIGIN}/developer/applications/create`).send(VALID_APP);

    assert.equal(res.status, 201);
  });

  it('blocks requests from another origin', async () => {
    const res = await cookiePost().set('Origin', 'https://evil.example').send(VALID_APP);

    assert.equal(res.status, 403);
  });

  it('blocks requests with no Origin or Referer', async () => {
    const res = await cookiePost().send(VALID_APP);

    assert.equal(res.status, 403);
  });

  it('does not apply to Bearer-token API clients', async () => {
    const res = await request(app)
      .post('/api/applications')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send(VALID_APP);

    assert.equal(res.status, 201);
  });

  it('does not block safe GET requests', async () => {
    const res = await request(app)
      .get('/api/applications')
      .set('Cookie', `token=${tokenFor(user)}`);

    assert.equal(res.status, 200);
  });
});

describe('authentication', () => {
  beforeEach(resetDatabase);

  it('redirects unauthenticated page requests to login', async () => {
    const res = await request(app).get('/developer/dashboard');

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login');
  });

  it('rejects tokens signed with another secret', async () => {
    const user = await createUser();
    const forged = jwt.sign({ userId: user.id, role: 'admin' }, 'not-the-secret');
    const res = await request(app).get('/api/applications').set('Authorization', `Bearer ${forged}`);

    assert.equal(res.status, 401);
  });

  it('rejects tokens for deleted users', async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await user.destroy();
    const res = await request(app).get('/api/applications').set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 401);
  });
});

describe('Content-Security-Policy compatibility', () => {
  const viewsDir = path.join(__dirname, '..', 'views');
  const views = [
    ...fs.readdirSync(viewsDir),
    ...fs.readdirSync(path.join(viewsDir, 'partials')).map((file) => `partials/${file}`),
  ].filter((file) => file.endsWith('.html'));

  it('sends a CSP header that forbids inline scripts', async () => {
    const res = await request(app).get('/login');
    const csp = res.headers['content-security-policy'];

    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /script-src-attr 'none'/);
  });

  for (const file of views) {
    it(`${file} has no inline scripts or inline event handlers`, () => {
      const html = fs.readFileSync(path.join(viewsDir, file), 'utf8');

      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'inline <script> block');
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handler attribute');
    });
  }

  it('every referenced page script exists', () => {
    // Shared with the gateway admin UI and served by app.js from gateway/ui.
    const shared = {
      '/js/charts.js': path.join(__dirname, '..', 'gateway', 'ui', 'charts.js'),
      '/js/flow.js': path.join(__dirname, '..', 'gateway', 'src', 'flow.js'),
    };
    for (const file of views) {
      const html = fs.readFileSync(path.join(viewsDir, file), 'utf8');
      for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
        assert.ok(fs.existsSync(shared[src] || path.join(__dirname, '..', 'public', src)), `${file} references missing ${src}`);
      }
    }
  });

  it('serves the shared chart script', async () => {
    const res = await request(app).get('/js/charts.js');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.text, /GatewayCharts/);
  });
});
