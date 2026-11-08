// Settings for running the console behind a proxy and against a cloud MySQL. Each case runs in a
// child process, because both are read once when the app and the database connection are built.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const run = (script, env) => JSON.parse(execFileSync(process.execPath, ['-e', script], {
  cwd: ROOT,
  env: { ...process.env, DOTENV_CONFIG_QUIET: 'true', NODE_ENV: 'test', JWT_SECRET: 'test-secret', DB_DIALECT: 'sqlite', TRUST_PROXY: '', DB_SSL: '', DB_SSL_CA: '', ...env },
  encoding: 'utf8',
}));

const trusted = (env) => run(`
  const app = require('./app');
  const trust = app.get('trust proxy fn');
  console.log(JSON.stringify({ loopback: trust('127.0.0.1', 0), remote: trust('203.0.113.9', 0), second: trust('203.0.113.9', 1), third: trust('203.0.113.9', 2) }));
`, env);

describe('TRUST_PROXY', () => {
  it('trusts no proxy unless it is set', () => {
    assert.deepEqual(trusted({}), { loopback: false, remote: false, second: false, third: false });
  });

  it('trusts the named addresses, or the given number of proxies', () => {
    assert.deepEqual(trusted({ TRUST_PROXY: 'loopback' }), { loopback: true, remote: false, second: false, third: false });
    assert.deepEqual(trusted({ TRUST_PROXY: '2' }), { loopback: true, remote: true, second: true, third: false });
  });
});

describe('DB_SSL', () => {
  const options = (env) => run(`
    const sequelize = require('./config/database');
    console.log(JSON.stringify(sequelize.options.dialectOptions || null));
  `, { DB_DIALECT: 'mysql', ...env });

  it('connects without TLS unless it is set', () => {
    assert.equal(options({}), null);
  });

  it('verifies the server, with the given CA bundle', () => {
    assert.deepEqual(options({ DB_SSL: 'true' }), { ssl: { rejectUnauthorized: true } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ca-'));
    try {
      const ca = path.join(dir, 'bundle.pem');
      fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----\n');
      assert.deepEqual(options({ DB_SSL: 'true', DB_SSL_CA: ca }), { ssl: { rejectUnauthorized: true, ca: fs.readFileSync(ca, 'utf8') } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
