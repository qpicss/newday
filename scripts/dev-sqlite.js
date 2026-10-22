// Runs the app against a local SQLite file so it can be tried without MySQL.
// Seeds an admin and a regular user on first run. Development only.
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = process.env.DB_STORAGE || 'dev.sqlite';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const User = require('../models/User');
require('../models/Application');
require('../models/Token');

const SEED_USERS = [
  { name: 'Demo Admin', email: 'admin@example.com', password: 'admin12345', role: 'admin' },
  { name: 'Demo Developer', email: 'dev@example.com', password: 'dev12345', role: 'user' },
];

const seed = async () => {
  await sequelize.sync();
  for (const { password, ...fields } of SEED_USERS) {
    const [, created] = await User.findOrCreate({
      where: { email: fields.email },
      defaults: { ...fields, isVerified: true, password: await bcrypt.hash(password, 10) },
    });
    if (created) {
      console.log(`Seeded ${fields.role}: ${fields.email} / ${password}`);
    }
  }
};

seed()
  .then(() => require('../server'))
  .catch((error) => {
    console.error('Failed to prepare the SQLite database:', error);
    process.exit(1);
  });
