// Extra credentials of an application: created by its owner (or a platform admin), the secret
// shown once and stored hashed, usable at the token endpoint like the original ones, and deleted
// on their own.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { app, request, models, Application, resetDatabase, createUser, api, browser, VALID_APP } = require('./helpers');

const { ApplicationCredential } = models;

const tokenWith = (clientId, clientSecret) => request(app).post('/oauth/token').auth(clientId, clientSecret)
  .type('form').send({ grant_type: 'client_credentials' });

describe('application credentials', () => {
  let owner;
  let other;
  let application;
  const base = () => `/api/applications/${application.id}/credentials`;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser();
    other = await createUser();
    application = (await api('post', '/api/applications', owner).send(VALID_APP)).body.application;
  });

  it('returns a new client ID and secret once and stores only the hash', async () => {
    const res = await api('post', base(), owner).send({ name: 'Production server' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { credential } = res.body;
    assert.equal(credential.name, 'Production server');
    assert.notEqual(credential.clientId, application.clientId);
    assert.ok(credential.clientSecret.length >= 40);

    const stored = await ApplicationCredential.findByPk(credential.id);
    assert.equal(stored.secretHash, Application.hashSecret(credential.clientSecret));
    assert.notEqual(stored.secretHash, credential.clientSecret);

    const listed = await api('get', base(), owner);
    assert.deepEqual(listed.body.credentials.map((item) => item.name), ['Production server']);
    assert.doesNotMatch(JSON.stringify(listed.body), new RegExp(`${credential.clientSecret}|${stored.secretHash}|secretHash|clientSecret`));
  });

  it('issues tokens for the application with the extra credentials, and stops once they are deleted', async () => {
    const { credential } = (await api('post', base(), owner).send({ name: 'Staging' })).body;
    const issued = await tokenWith(credential.clientId, credential.clientSecret);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    // Same subject as the original credentials: the gateway sees the application's access.
    assert.equal(jwt.decode(issued.body.access_token).sub, application.clientId);
    assert.ok((await ApplicationCredential.findByPk(credential.id)).lastUsedAt);

    assert.equal((await tokenWith(credential.clientId, 'wrong-secret')).status, 401);
    assert.equal((await tokenWith(application.clientId, application.clientSecret)).status, 200, 'the original credentials keep working');

    const deleted = await api('delete', `${base()}/${credential.id}`, owner);
    assert.equal(deleted.status, 200);
    assert.equal((await tokenWith(credential.clientId, credential.clientSecret)).status, 401);
    assert.equal((await tokenWith(application.clientId, application.clientSecret)).status, 200);
  });

  it('keeps credentials private to the owner, with platform admins as the exception', async () => {
    assert.equal((await api('post', base(), other).send({ name: 'Mine now' })).status, 404);
    assert.equal((await api('get', base(), other)).status, 404);
    const { credential } = (await api('post', base(), owner).send({ name: 'Worker' })).body;
    assert.equal((await api('delete', `${base()}/${credential.id}`, other)).status, 404);

    const admin = await createUser({ role: 'admin' });
    const adminBase = `/api/admin/applications/${application.id}/credentials`;
    assert.equal((await api('post', adminBase, admin).send({ name: 'Support' })).status, 201);
    assert.equal((await api('get', adminBase, admin)).body.credentials.length, 2);
    assert.equal((await api('delete', `${adminBase}/${credential.id}`, admin)).status, 200);
    assert.equal((await api('get', adminBase, other)).status, 403);
  });

  it('validates names, refuses duplicates and caps the number of sets', async () => {
    assert.equal((await api('post', base(), owner).send({ name: '  ' })).status, 400);
    assert.equal((await api('post', base(), owner).send({ name: 'x'.repeat(101) })).status, 400);
    assert.equal((await api('post', base(), owner).send({ name: 'CI' })).status, 201);
    assert.equal((await api('post', base(), owner).send({ name: 'ci' })).status, 409);
    for (let index = 1; index < 10; index += 1) assert.equal((await api('post', base(), owner).send({ name: `Node ${index}` })).status, 201);
    const full = await api('post', base(), owner).send({ name: 'One too many' });
    assert.equal(full.status, 400);
    assert.match(full.body.error, /at most 10/);
  });

  it('deletes the credentials with the application', async () => {
    await api('post', base(), owner).send({ name: 'Batch' });
    assert.equal((await api('delete', `/api/applications/${application.id}`, owner)).status, 200);
    assert.equal(await ApplicationCredential.count(), 0);
  });

  it('shows the credentials on the application page, without secrets', async () => {
    const { credential } = (await api('post', base(), owner).send({ name: 'Mobile app' })).body;
    const page = await browser('get', `/developer/applications/${application.id}`, owner);
    assert.equal(page.status, 200);
    assert.match(page.text, /Add credentials/);
    assert.match(page.text, /Mobile app/);
    assert.ok(page.text.includes(credential.clientId));
    assert.match(page.text, /Not used yet/);
    assert.ok(!page.text.includes(credential.clientSecret));
    // The cookie-authenticated form posts with the page's origin (CSRF rule).
    assert.equal((await browser('post', base(), owner).send({ name: 'From the page' })).status, 201);
  });
});
