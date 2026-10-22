const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

// Load all models and their associations before any route runs a query.
const { Invitation, User } = require('./models');

// Import routes
const authRoutes = require('./routes/auth');
const applicationRoutes = require('./routes/applications');
const developerRoutes = require('./routes/developer');
const adminRoutes = require('./routes/admin');
const orgRoutes = require('./routes/org');
const catalogRoutes = require('./routes/catalog');
const oauthRoutes = require('./routes/oauth');
const meRoutes = require('./routes/me');
const { jwks } = require('./controllers/oauthController');

const app = express();

// Middleware
// Helmet's default Content-Security-Policy blocks inline scripts, so all page
// scripts live in public/js and are loaded with <script src>.
app.use(helmet());
app.use(cors());
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}
// OpenAPI imports and policy flows can be large; every other JSON body stays small.
app.use('/api/org/apis/import', express.json({ limit: '2mb' }));
// The source editor sends whole OpenAPI documents (2 MB of text, a little more as JSON), the schema
// designer single schemas of up to 512 KB.
app.use(/^\/api\/org\/apis\/[^/]+\/(spec(\/validate)?|schemas(\/[^/]+)?|operations\/content-schema)$/, express.json({ limit: '3mb' }));
app.use('/api/org/policies', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// One chart library for the console and the gateway admin UI.
app.get('/js/charts.js', (req, res) => res.type('text/javascript').sendFile(path.join(__dirname, 'gateway', 'ui', 'charts.js')));
// The policy flow format (validation, problems) shared by the console, the gateway and the flow editor.
app.get('/js/flow.js', (req, res) => res.type('text/javascript').sendFile(path.join(__dirname, 'gateway', 'src', 'flow.js')));

// Set view engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'html');
app.engine('html', require('ejs').renderFile);
Object.assign(app.locals, require('./utils/viewHelpers'));

// Routes
app.use('/auth', authRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/developer', developerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/me', meRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/oauth', oauthRoutes);
app.get('/.well-known/jwks.json', jwks);

// Serve public login and registration pages
app.get('/login', (req, res) => {
  res.render('login.html');
});

app.get('/register', (req, res) => {
  res.render('register.html');
});

// Public page for accepting an organization invitation
app.get('/invite/:token', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const invitation = await Invitation.findByToken(req.params.token);
    if (invitation) {
      await invitation.reload({ include: [{ association: 'organization', attributes: ['name'] }] });
    }
    const usable = invitation && invitation.isUsable() ? invitation : null;
    res.render('invite.html', {
      token: req.params.token,
      invitation: usable,
      // People who already have an account join with their password instead of creating one.
      hasAccount: usable ? Boolean(await User.count({ where: { email: usable.email } })) : false,
    });
  } catch (error) {
    next(error);
  }
});

// Public home page
app.get('/', (req, res) => {
  res.render('home.html');
});

app.use((req, res) => {
  if (req.accepts(['json', 'html']) === 'html') {
    return res.status(404).render('error.html', {
      status: 404,
      heading: 'Page not found',
      message: "The page you're looking for doesn't exist or has moved.",
    });
  }
  res.status(404).json({ error: 'Not found' });
});

// Body-parser errors (bad JSON, payload too large) are safe to show; anything else is logged only.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
