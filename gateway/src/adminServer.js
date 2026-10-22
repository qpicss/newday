// Admin UI for the gateway (HTTPS, gateway certificate). People sign in with the email and password
// of an org admin of the organization that owns this gateway; the gateway checks them with the
// management console over the mTLS link and never stores passwords.
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { readBody, sendJson } = require('./http');
const { LinkError } = require('./link');

const UI_DIR = path.join(__dirname, '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
};
const COOKIE = 'gw_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const cookieValue = (req, name) => {
  const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
};

const createAdminServer = ({ credentials, logger, actions, isEnabled }) => {
  const sessions = new Map(); // token -> { user, expiresAt }
  const failures = new Map(); // ip -> { count, resetAt }

  const sessionFor = (req) => {
    const token = cookieValue(req, COOKIE);
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return { token, ...session };
  };

  const setCookie = (res, token, maxAgeSeconds) => {
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`);
  };

  const serveStatic = (res, file, type) => {
    fs.readFile(path.join(UI_DIR, file), (error, content) => {
      if (error) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      res.end(content);
    });
  };

  const login = async (req, res) => {
    const ip = req.socket.remoteAddress;
    const record = failures.get(ip);
    if (record && record.resetAt > Date.now() && record.count >= LOGIN_MAX_FAILURES) {
      sendJson(res, 429, { error: 'Too many failed sign-ins. Try again in a few minutes.' }, { 'retry-after': String(Math.ceil((record.resetAt - Date.now()) / 1000)) });
      return;
    }
    let body;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'Send your email and password' });
      return;
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || typeof body.password !== 'string' || !body.password) {
      sendJson(res, 400, { error: 'Enter your email and password' });
      return;
    }
    try {
      const user = await actions.verifyAdmin(email, body.password);
      failures.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
      setCookie(res, token, SESSION_TTL_MS / 1000);
      logger.info('admin signed in', { user: user.email });
      sendJson(res, 200, { user });
    } catch (error) {
      if (error instanceof LinkError && (error.status === 401 || error.status === 403)) {
        const entry = record && record.resetAt > Date.now() ? record : { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
        entry.count += 1;
        failures.set(ip, entry);
        logger.warn('admin sign-in refused', { email });
        sendJson(res, 401, { error: 'The email or password is wrong, or this account is not an admin of the organization that owns this gateway.' });
        return;
      }
      logger.warn('admin sign-in unavailable', { error: error.message });
      sendJson(res, 503, { error: `Sign-in needs the management console, which could not be reached. ${error.message}` });
    }
  };

  const stream = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...SECURITY_HEADERS,
    });
    res.write('retry: 3000\n\n');
    const unsubscribe = actions.subscribeRequests((entry) => {
      res.write(`id: ${entry.seq}\nevent: request\ndata: ${JSON.stringify(entry)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    keepAlive.unref();
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'https://gateway.invalid');
    if (!isEnabled()) {
      sendJson(res, 404, { error: 'The admin UI is turned off for this gateway' });
      return;
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      serveStatic(res, ...STATIC[url.pathname]);
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    // Requests that change state must come from the UI's own scripts (custom header => same origin).
    if (req.method !== 'GET' && req.headers['x-gateway-ui'] !== '1') {
      sendJson(res, 403, { error: 'Missing UI header' });
      return;
    }

    try {
      if (req.method === 'POST' && url.pathname === '/api/login') {
        await login(req, res);
        return;
      }
      const session = sessionFor(req);
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        if (session) sessions.delete(session.token);
        setCookie(res, '', 0);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!session) {
        sendJson(res, 401, { error: 'Sign in to continue' });
        return;
      }
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/session':
          sendJson(res, 200, { user: session.user, expiresAt: new Date(session.expiresAt).toISOString() });
          return;
        case 'GET /api/overview':
          sendJson(res, 200, actions.overview());
          return;
        case 'GET /api/requests':
          sendJson(res, 200, actions.listRequests(Object.fromEntries(url.searchParams)));
          return;
        case 'GET /api/requests/stream':
          stream(req, res);
          return;
        case 'GET /api/series':
          sendJson(res, 200, actions.series(Number(url.searchParams.get('minutes')) || 15));
          return;
        default:
          sendJson(res, 404, { error: 'not_found' });
      }
    } catch (error) {
      logger.error('admin UI request failed', { error: error.message });
      sendJson(res, 500, { error: 'Something went wrong' });
    }
  };

  const server = https.createServer({ key: credentials.privateKey, cert: credentials.certificate, minVersion: 'TLSv1.2' }, handle);
  server.sessionCount = () => sessions.size;
  return server;
};

module.exports = { createAdminServer };
