const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const { User, Organization, Invitation, Membership } = require('../models');
const { resolveActiveOrganization } = require('../services/membership');
const { generateUserToken } = require('../utils/jwt');
const { sendServerError } = require('../utils/http');
const {
  normalizeEmail,
  validateEmail,
  validatePassword,
  validateName,
  validateOrganizationName,
} = require('../utils/validation');

const SESSION_SECONDS = 24 * 60 * 60;

const setAuthCookie = (res, token, maxAge) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
};

// `user` must have been through resolveActiveOrganization (organization, orgRole, memberships).
const toUserResponse = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  orgRole: user.orgRole,
  organization: user.organization ? { id: user.organization.id, name: user.organization.name } : null,
  organizations: user.memberships,
});

const startSession = (res, user) => {
  const token = generateUserToken(user, SESSION_SECONDS);
  setAuthCookie(res, token, SESSION_SECONDS);
  return token;
};

// Every registration creates a new organization (tenant) with the user as its admin.
const register = async (req, res) => {
  try {
    const { password, name, organizationName } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);

    const validationError = validateName(name)
      || validateEmail(email)
      || validatePassword(password)
      || validateOrganizationName(organizationName);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // The platform role is never taken from the request.
    const user = await sequelize.transaction(async (transaction) => {
      const organization = await Organization.create({ name: organizationName.trim() }, { transaction });
      const newUser = await User.create({
        email,
        password: passwordHash,
        name: name.trim(),
        organizationId: organization.id,
      }, { transaction });
      await Membership.create({ userId: newUser.id, organizationId: organization.id, role: 'admin' }, { transaction });
      return newUser;
    });

    const token = startSession(res, user);
    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: toUserResponse(await resolveActiveOrganization(user)),
    });
  } catch (error) {
    sendServerError(res, error, 'Registration failed');
  }
};

const login = async (req, res) => {
  try {
    const { password } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);

    if (!email || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ where: { email } });
    const isMatch = user ? await bcrypt.compare(password, user.password) : false;
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = startSession(res, user);

    // Send token and user info in JSON response for API clients
    res.json({
      message: 'Login successful',
      token,
      user: toUserResponse(await resolveActiveOrganization(user)),
    });
  } catch (error) {
    sendServerError(res, error, 'Login failed');
  }
};

const logout = (req, res) => {
  setAuthCookie(res, '', 0);

  if (req.accepts(['json', 'html']) === 'html') {
    return res.redirect('/login');
  }
  res.json({ message: 'Logged out' });
};

// Adds the invited person to the organization and signs them in. New people create an account;
// people who already have one confirm with its password and keep their other organizations.
const acceptInvitation = async (req, res) => {
  try {
    const { token, name, password } = req.body ?? {};
    const invitation = await Invitation.findByToken(token);
    if (!invitation || !invitation.isUsable()) {
      return res.status(400).json({ error: 'This invitation is invalid or has expired. Ask your organization admin for a new one.' });
    }

    const existingUser = await User.findOne({ where: { email: invitation.email } });
    if (existingUser) {
      const passwordOk = typeof password === 'string' && await bcrypt.compare(password, existingUser.password);
      if (!passwordOk) {
        return res.status(400).json({ error: 'That password is not correct for this account' });
      }
    } else {
      const validationError = validateName(name) || validatePassword(password);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    }

    const user = await sequelize.transaction(async (transaction) => {
      const member = existingUser || await User.create({
        email: invitation.email,
        password: await bcrypt.hash(password, 10),
        name: name.trim(),
        // Following the emailed link proves the address.
        isVerified: true,
      }, { transaction });
      const [membership, created] = await Membership.findOrCreate({
        where: { userId: member.id, organizationId: invitation.organizationId },
        defaults: { role: invitation.orgRole },
        transaction,
      });
      // An invitation never lowers an existing role.
      if (!created && invitation.orgRole === 'admin' && membership.role !== 'admin') {
        await membership.update({ role: 'admin' }, { transaction });
      }
      // Work in the organization just joined.
      await member.update({ organizationId: invitation.organizationId, ...(existingUser && { isVerified: true }) }, { transaction });
      await invitation.update({ acceptedAt: new Date() }, { transaction });
      return member;
    });

    const sessionToken = startSession(res, user);
    res.status(existingUser ? 200 : 201).json({
      message: 'Invitation accepted',
      token: sessionToken,
      user: toUserResponse(await resolveActiveOrganization(user)),
    });
  } catch (error) {
    sendServerError(res, error, 'Could not accept the invitation');
  }
};

module.exports = { register, login, logout, acceptInvitation };
