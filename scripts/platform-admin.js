// Makes a registered account a platform admin (User.role = 'admin'), for the first admin of a new
// database. From then on, platform admins promote others in the console.
//   node scripts/platform-admin.js you@example.com
// Uses the console's database settings (.env, or the environment).
require('dotenv').config();
const sequelize = require('../config/database');
const { User } = require('../models');

async function main(email) {
  if (!email) {
    console.error('Usage: node scripts/platform-admin.js <email>');
    process.exitCode = 2;
    return;
  }
  try {
    const user = await User.findOne({ where: { email: email.trim().toLowerCase() } });
    if (!user) {
      console.error(`No account with the email ${email}. Register it in the console first.`);
      process.exitCode = 1;
    } else if (user.role === 'admin') {
      console.log(`${user.email} is already a platform admin.`);
    } else {
      await user.update({ role: 'admin' });
      console.log(`${user.email} is now a platform admin. Sign out and in again to see Admin in the menu.`);
    }
  } catch (error) {
    console.error('Could not update the account:', error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main(process.argv[2]);
