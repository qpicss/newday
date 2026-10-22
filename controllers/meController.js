// The signed-in user's organizations: list them, create one, switch the one being worked in, leave one.
const sequelize = require('../config/database');
const { Membership, Organization } = require('../models');
const { sendServerError } = require('../utils/http');
const { validateOrganizationName } = require('../utils/validation');
const { canCreateOrganizations, countAdmins, removeMembership } = require('../services/membership');

const summary = (user) => ({
  current: user.organization ? { id: user.organization.id, name: user.organization.name, role: user.orgRole } : null,
  actingAsPlatformAdmin: Boolean(user.actingAsPlatformAdmin),
  organizations: user.memberships.map((membership) => ({ id: membership.organizationId, name: membership.name, role: membership.role })),
  canCreate: canCreateOrganizations(user),
});

const listOrganizations = (req, res) => res.json(summary(req.user));

// The creator becomes its admin and starts working in it.
const createOrganization = async (req, res) => {
  try {
    if (!canCreateOrganizations(req.user)) {
      return res.status(403).json({ error: 'Only organization admins can create organizations' });
    }
    const { name } = req.body ?? {};
    const nameError = validateOrganizationName(name);
    if (nameError) return res.status(400).json({ error: nameError });

    const organization = await sequelize.transaction(async (transaction) => {
      const created = await Organization.create({ name: name.trim() }, { transaction });
      await Membership.create({ userId: req.user.id, organizationId: created.id, role: 'admin' }, { transaction });
      await req.user.update({ organizationId: created.id }, { transaction });
      return created;
    });
    res.status(201).json({ organization: { id: organization.id, name: organization.name, role: 'admin' } });
  } catch (error) {
    sendServerError(res, error, 'Failed to create the organization');
  }
};

// Members switch between their organizations; platform admins may open any organization.
const switchOrganization = async (req, res) => {
  try {
    const organizationId = req.body?.organizationId;
    if (typeof organizationId !== 'string' || !organizationId) {
      return res.status(400).json({ error: 'Choose an organization' });
    }
    const membership = await Membership.findOne({ where: { userId: req.user.id, organizationId } });
    const organization = await Organization.findByPk(organizationId, { attributes: ['id', 'name'] });
    if (!organization || (!membership && req.user.role !== 'admin')) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    await req.user.update({ organizationId: organization.id });
    res.json({ organization: { id: organization.id, name: organization.name, role: membership ? membership.role : 'admin' } });
  } catch (error) {
    sendServerError(res, error, 'Failed to switch organization');
  }
};

// An organization always keeps at least one admin.
const leaveOrganization = async (req, res) => {
  try {
    const membership = await Membership.findOne({ where: { userId: req.user.id, organizationId: req.params.id } });
    if (!membership) return res.status(404).json({ error: 'You are not a member of this organization' });
    if (membership.role === 'admin' && await countAdmins(membership.organizationId) <= 1) {
      return res.status(409).json({ error: 'You are its only admin. Make another member an admin first.' });
    }
    await sequelize.transaction((transaction) => removeMembership(membership, transaction));
    res.json({ message: 'You left the organization' });
  } catch (error) {
    sendServerError(res, error, 'Failed to leave the organization');
  }
};

module.exports = { listOrganizations, createOrganization, switchOrganization, leaveOrganization };
