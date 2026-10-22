const { Sequelize } = require('sequelize');
require('dotenv').config();

// MySQL is the default. Set DB_DIALECT=sqlite for tests and local runs without a MySQL server.
const dialect = process.env.DB_DIALECT || 'mysql';

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
    }
  );

module.exports = sequelize;
