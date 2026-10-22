const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const { User, Organization, Invitation, Membership } = require('../models');
const { removeMembership } = require('../services/membership');
const { sendServerError } = require('../utils/http');
const { isMailConfigured, sendInvitationEmail } = require('../utils/mailer');
const {
  normalizeEmail,
  validateEmail,
  validatePassword,
  validateName,
  validateOrganizationName,
  validateOrgRole,
} = require('../utils/validation');

// A membership with its user: the member's id is the user's id.
const toMember = (membership) => ({
  id: membership.user.id,
  name: membership.user.name,
  email: membership.user.email,
  orgRole: membership.role,
  isVerified: membership.user.isVerified,
  createdAt: membership.createdAt,
});

const userInclude = { association: 'user', attributes: ['id', 'name', 'email', 'isVerified'] };

const toInvitation = (invitation) => ({
  id: invitation.id,
  email: invitation.email,
  orgRole: invitation.orgRole,
  expiresAt: invitation.expiresAt,
  expired: invitation.expiresAt <= new Date(),
  createdAt: invitation.createdAt,
});

// Prefer APP_URL so invite links never depend on the request's Host header.
const appBaseUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// Emails the invite when SMTP is configured; the link is always returned so the admin can share it.
const deliverInvitation = async (req, invitation, token) => {
  const inviteUrl = `${appBaseUrl(req)}/invite/${token}`;
  let emailSent = false;
  let emailFailed = false;
  try {
    emailSent = await sendInvitationEmail({
      to: invitation.email,
      organizationName: req.user.organization?.name || 'your organization',
      inviterName: req.user.name,
      inviteUrl,
    });
  } catch (error) {
    console.error('Failed to send invitation email:', error);
    emailFailed = true;
  }
  return { inviteUrl, emailSent, emailFailed, mailConfigured: isMailConfigured() };
};

const findOrgMember = (req) => Membership.findOne({
  where: { userId: req.params.id, organizationId: req.user.organizationId },
  include: [userInclude],
});

const getOrganization = async (req, res) => {
  try {
    const organization = await Organization.findByPk(req.user.organizationId);
    res.json({
      organization: { id: organization.id, name: organization.name, createdAt: organization.createdAt },
      role: req.user.orgRole,
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to load organization');
  }
};

const updateOrganization = async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const nameError = validateOrganizationName(name);
    if (nameError) {
      return res.status(400).json({ error: nameError });
    }
    const organization = await Organization.findByPk(req.user.organizationId);
    await organization.update({ name: name.trim() });
    res.json({ organization: { id: organization.id, name: organization.name } });
  } catch (error) {
    sendServerError(res, error, 'Failed to update organization');
  }
};

const listMembers = async (req, res) => {
  try {
    const members = await Membership.findAll({
      where: { organizationId: req.user.organizationId },
      include: [userInclude],
      order: [['createdAt', 'ASC']],
    });
    res.json({ members: members.filter((member) => member.user).map(toMember) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load members');
  }
};

// Adds someone directly. An existing account is added as it is; for a new one the admin
// chooses a name and a temporary password.
const addMember = async (req, res) => {
  try {
    const { name, password, orgRole = 'member' } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);
    const baseError = validateEmail(email) || validateOrgRole(orgRole);
    if (baseError) {
      return res.status(400).json({ error: baseError });
    }

    const existing = await User.findOne({ where: { email } });
    if (existing) {
      const [membership, created] = await Membership.findOrCreate({
        where: { userId: existing.id, organizationId: req.user.organizationId },
        defaults: { role: orgRole },
      });
      if (!created) {
        return res.status(409).json({ error: `${existing.name} is already a member of this organization` });
      }
      if (!existing.organizationId) await existing.update({ organizationId: req.user.organizationId });
      membership.user = existing;
      return res.status(201).json({ member: toMember(membership), existingAccount: true });
    }

    const validationError = validateName(name) || validatePassword(password);
    if (validationError) {
      return res.status(400).json({ error: `No account uses this email yet. ${validationError}` });
    }
    const membership = await sequelize.transaction(async (transaction) => {
      const user = await User.create({
        name: name.trim(),
        email,
        password: await bcrypt.hash(password, 10),
        organizationId: req.user.organizationId,
      }, { transaction });
      const created = await Membership.create({ userId: user.id, organizationId: req.user.organizationId, role: orgRole }, { transaction });
      created.user = user;
      return created;
    });
    res.status(201).json({ member: toMember(membership), existingAccount: false });
  } catch (error) {
    sendServerError(res, error, 'Failed to add member');
  }
};

const updateMember = async (req, res) => {
  try {
    const { orgRole } = req.body ?? {};
    const roleError = validateOrgRole(orgRole);
    if (roleError) {
      return res.status(400).json({ error: roleError });
    }

    const member = await findOrgMember(req);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (member.userId === req.user.id) {
      return res.status(400).json({ error: "You can't change your own role" });
    }

    await member.update({ role: orgRole });
    res.json({ member: toMember(member) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update member');
  }
};

// Removes the membership only: the account, its other organizations and its applications stay.
const removeMember = async (req, res) => {
  try {
    const member = await findOrgMember(req);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (member.userId === req.user.id) {
      return res.status(400).json({ error: "You can't remove yourself. Use \"Leave organization\" instead." });
    }

    await sequelize.transaction((transaction) => removeMembership(member, transaction));
    res.json({ message: `${member.user.name} was removed from the organization` });
  } catch (error) {
    sendServerError(res, error, 'Failed to remove member');
  }
};

const listInvitations = async (req, res) => {
  try {
    const invitations = await Invitation.findAll({
      where: { organizationId: req.user.organizationId, acceptedAt: null },
      order: [['createdAt', 'DESC']],
    });
    res.json({ invitations: invitations.map(toInvitation), mailConfigured: isMailConfigured() });
  } catch (error) {
    sendServerError(res, error, 'Failed to load invitations');
  }
};

const createInvitation = async (req, res) => {
  try {
    const { orgRole = 'member' } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);
    const validationError = validateEmail(email) || validateOrgRole(orgRole);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const account = await User.findOne({ where: { email } });
    if (account && await Membership.count({ where: { userId: account.id, organizationId: req.user.organizationId } })) {
      return res.status(409).json({ error: `${account.name} is already a member of this organization` });
    }

    const existing = await Invitation.findOne({
      where: { organizationId: req.user.organizationId, email, acceptedAt: null },
    });
    if (existing && existing.isUsable()) {
      return res.status(409).json({ error: 'This email already has a pending invitation. Use "Resend" to send it again.' });
    }

    // An expired invitation for the same email is reused with a fresh token.
    const invitation = existing || Invitation.build({ organizationId: req.user.organizationId, email });
    invitation.orgRole = orgRole;
    invitation.invitedById = req.user.id;
    const token = invitation.issueToken();
    await invitation.save();

    const delivery = await deliverInvitation(req, invitation, token);
    res.status(201).json({ invitation: toInvitation(invitation), ...delivery });
  } catch (error) {
    sendServerError(res, error, 'Failed to create invitation');
  }
};

const resendInvitation = async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      where: { id: req.params.id, organizationId: req.user.organizationId, acceptedAt: null },
    });
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    // A new token invalidates the previous link.
    const token = invitation.issueToken();
    invitation.invitedById = req.user.id;
    await invitation.save();

    const delivery = await deliverInvitation(req, invitation, token);
    res.json({ invitation: toInvitation(invitation), ...delivery });
  } catch (error) {
    sendServerError(res, error, 'Failed to resend invitation');
  }
};

const revokeInvitation = async (req, res) => {
  try {
    const deleted = await Invitation.destroy({
      where: { id: req.params.id, organizationId: req.user.organizationId, acceptedAt: null },
    });
    if (!deleted) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    res.json({ message: 'Invitation revoked' });
  } catch (error) {
    sendServerError(res, error, 'Failed to revoke invitation');
  }
};

module.exports = {
  toMember,
  toInvitation,
  getOrganization,
  updateOrganization,
  listMembers,
  addMember,
  updateMember,
  removeMember,
  listInvitations,
  createInvitation,
  resendInvitation,
  revokeInvitation,
};
