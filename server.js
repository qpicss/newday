require('dotenv').config();

const app = require('./app');
const sequelize = require('./config/database');
require('./models/User');
require('./models/Application');
require('./models/Token');
const { startLinkServer } = require('./services/linkServer');
const { startUsageCollector } = require('./services/usageCollector');
const { startGatewayMonitor } = require('./services/gatewayMonitor');
const { linkSettings } = require('./utils/linkSettings');

const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Add it to your environment or .env file.');
  process.exit(1);
}

// Schema changes are only applied with DB_SYNC_ALTER=true, never implicitly.
sequelize.sync({ alter: process.env.DB_SYNC_ALTER === 'true' })
  .then(() => {
    console.log('Database connected successfully');

    // Express 5 passes listen errors (e.g. EADDRINUSE) to this callback.
    app.listen(PORT, (error) => {
      if (error) {
        console.error(`Could not start server on port ${PORT}:`, error.message);
        process.exit(1);
      }
      console.log(`Server running on port ${PORT}`);
      console.log(`Visit http://localhost:${PORT} to access the application`);
    });

    // mTLS endpoint gateways call (registration, configuration pulls, usage, admin UI sign-in).
    const link = linkSettings();
    if (link.enabled) {
      startLinkServer(link, { logger: { info: (message) => console.log(message) } })
        .then(() => console.log(`Gateway link listening on port ${link.port} (gateways use ${link.publicUrl})`))
        .catch((error) => console.error(`Gateway link could not start on port ${link.port}: ${error.message}`));
    }
    startUsageCollector();
    startGatewayMonitor();
  })
  .catch((error) => {
    console.error('Database connection failed:', error.message);
    process.exit(1);
  });
