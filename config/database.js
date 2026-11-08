const fs = require('fs');
const { Sequelize } = require('sequelize');
require('dotenv').config();

// MySQL is the default. Set DB_DIALECT=sqlite for tests and local runs without a MySQL server.
const dialect = process.env.DB_DIALECT || 'mysql';

// DB_SSL=true connects to MySQL over TLS and verifies the server (Azure Database for MySQL requires
// TLS; Amazon RDS offers it). DB_SSL_CA: a PEM file of CA certificates to verify it with, such as
// RDS's global-bundle.pem; without it Node's built-in list is used.
const ssl = process.env.DB_SSL === 'true'
  ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA && { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8') }) }
  : null;

const sequelize = dialect === 'sqlite'
  ? new Sequelize({
    dialect: 'sqlite',
    storage: process.env.DB_STORAGE || ':memory:',
    logging: false,
  })
  : new Sequelize(
    process.env.DB_NAME || 'newday',
    process.env.DB_USER || 'root',
    process.env.DB_PASSWORD || '',
    {
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      dialect: 'mysql',
      logging: false,
      ...(ssl && { dialectOptions: { ssl } }),
    }
  );

module.exports = sequelize;
