const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const { User, Organization, Application, ApplicationCredential, Token, Subscription, Membership } = require('../models');
const { countAdmins } = require('../services/membership');
const { generateUserToken } = require('../utils/jwt');
const { serializeApplication } = require('./applicationController');
const { sendServerError } = require('../utils/http');
const {
  normalizeEmail,
  validateEmail,
  validatePassword,
  validateName,
  validateOrganizationName,
  validateOrgRole,
} = require('../utils/validation');

const toSafeUser = (user) => {
  const safeUser = user.toJSON();
  delete safeUser.password;
  delete safeUser.orgRole;
  return safeUser;
};

const parseBoolean = (value) => value === true || value === 'true' || value === 'on';

// Create a user from the admin workspace.
const createUser = async (req, res) => {
  try {
    const { name, password, role, isVerified } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);

    const validationError = validateName(name) || validateEmail(email) || validatePassword(password);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Every user is a tenant: join an existing organization or create a new one.
    const { organizationId, organizationName } = req.body ?? {};
    let organization = null;
    if (organizationId) {
      organization = await Organization.findByPk(organizationId);
      if (!organization) {
        return res.status(400).json({ error: 'Organization not found' });
      }
    } else {
      const organizationError = validateOrganizationName(organizationName);
      if (organizationError) {
        return res.status(400).json({ error: organizationError });
      }
    }
    // New organizations get the user as admin; existing ones default to member.
    const orgRole = req.body?.orgRole ?? (organization ? 'member' : 'admin');
    const orgRoleError = validateOrgRole(orgRole);
    if (orgRoleError) {
      return res.status(400).json({ error: orgRoleError });
    }

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let targetOrganization = organization;
    const user = await sequelize.transaction(async (transaction) => {
      targetOrganization = organization
        || await Organization.create({ name: organizationName.trim() }, { transaction });
      const created = await User.create({
        name: name.trim(),
        email,
        password: passwordHash,
        role: role === 'admin' ? 'admin' : 'user',
        isVerified: parseBoolean(isVerified),
        organizationId: targetOrganization.id,
      }, { transaction });
      await Membership.create({ userId: created.id, organizationId: targetOrganization.id, role: orgRole }, { transaction });
      return created;
    });

    res.status(201).json({
      user: { ...toSafeUser(user), organizations: [{ id: targetOrganization.id, name: targetOrganization.name, role: orgRole }] },
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to create user');
  }
};

// Get all users
const getAllUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: { exclude: ['password'] }
    });
    res.json({ users });
  } catch (error) {
    sendServerError(res, error, 'Failed to fetch users');
  }
};

// Get a specific user
const getUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: { exclude: ['password'] }
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    sendServerError(res, error, 'Failed to fetch user');
  }
};

// Update a user
const updateUser = async (req, res) => {
  try {
    const { name, role, isVerified } = req.body ?? {};
    const user = await User.findByPk(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates = {};

    if (name !== undefined) {
      const nameError = validateName(name);
      if (nameError) {
        return res.status(400).json({ error: nameError });
      }
      updates.name = name.trim();
    }

    if (req.body?.email !== undefined) {
      const email = normalizeEmail(req.body.email);
      const emailError = validateEmail(email);
      if (emailError) {
        return res.status(400).json({ error: emailError });
      }
      if (email !== user.email) {
        const existingUser = await User.findOne({ where: { email } });
        if (existingUser && existingUser.id !== user.id) {
          return res.status(409).json({ error: 'A user with this email already exists' });
        }
      }
      updates.email = email;
    }

    if (role) {
      const newRole = role === 'admin' ? 'admin' : 'user';
      if (user.id === req.user.id && newRole !== 'admin') {
        return res.status(400).json({ error: 'You cannot remove your own admin role' });
      }
      updates.role = newRole;
    }

    if (isVerified !== undefined) {
      updates.isVerified = parseBoolean(isVerified);
    }

    await user.update(updates);
    res.json({ user: toSafeUser(user) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update user');
  }
};

// Delete a user together with their applications and tokens
const deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    // Don't leave an organization with members but no admin.
    const adminships = await Membership.findAll({ where: { userId: user.id, role: 'admin' }, include: [{ association: 'organization', attributes: ['name'] }] });
    for (const membership of adminships) {
      const otherMembers = await Membership.count({ where: { organizationId: membership.organizationId } }) - 1;
      if (otherMembers > 0 && await countAdmins(membership.organizationId) <= 1) {
        return res.status(400).json({ error: `This user is the only admin of ${membership.organization?.name || 'an organization'}. Make another member an admin first.` });
      }
    }

    await sequelize.transaction(async (transaction) => {
      const applications = await Application.findAll({
        where: { userId: user.id },
        attributes: ['id'],
        transaction,
      });
      const applicationIds = applications.map((application) => application.id);

      await Token.destroy({ where: { userId: user.id }, transaction });
      if (applicationIds.length) {
        await Token.destroy({ where: { applicationId: applicationIds }, transaction });
        await Subscription.destroy({ where: { applicationId: applicationIds }, transaction });
        await ApplicationCredential.destroy({ where: { applicationId: applicationIds }, transaction });
      }
      await Application.destroy({ where: { userId: user.id }, transaction });
      await Membership.destroy({ where: { userId: user.id }, transaction });
      await user.destroy({ transaction });
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete user');
  }
};

// Set a new password for a user
const setUserPassword = async (req, res) => {
  try {
    const { password } = req.body ?? {};
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.update({ password: await bcrypt.hash(password, 10) });
    res.json({ message: 'Password updated' });
  } catch (error) {
    sendServerError(res, error, 'Failed to update password');
  }
};

// List every application, with its owner
const getAllApplications = async (req, res) => {
  try {
    const applications = await Application.findAll({
      include: [{ association: 'owner', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', 'DESC']],
    });
    res.json({ applications: applications.map(serializeApplication) });
  } catch (error) {
    sendServerError(res, error, 'Failed to fetch applications');
  }
};

// List the applications owned by one user
const getUserApplications = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, { attributes: ['id'] });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const applications = await Application.findAll({
      where: { userId: user.id },
      order: [['createdAt', 'DESC']],
    });
    res.json({ applications: applications.map(serializeApplication) });
  } catch (error) {
    sendServerError(res, error, 'Failed to fetch applications');
  }
};

// Generate a bearer token for a user (for testing purposes)
const generateToken = async (req, res) => {
  try {
    const { userId } = req.body ?? {};
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ token: generateUserToken(user, '1h') });
  } catch (error) {
    sendServerError(res, error, 'Failed to generate token');
  }
};

module.exports = {
  createUser,
  getAllUsers,
  getUser,
  updateUser,
  deleteUser,
  setUserPassword,
  getAllApplications,
  getUserApplications,
  generateToken
};
