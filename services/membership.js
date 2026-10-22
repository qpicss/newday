// Organizations a user belongs to, the one they work in, and their role there.
//
// User.organizationId holds the selected organization. On every authenticated request
// resolveActiveOrganization() checks it against the user's memberships and sets, on the user
// instance (never saved): organizationId, orgRole ('admin' | 'member'), organization and
// memberships. Platform admins may select any organization and act as its admin.
const { Op } = require('sequelize');
const { Membership, Organization, User } = require('../models');

const membershipsOf = (userId) => Membership.findAll({
  where: { userId },
  include: [{ association: 'organization', attributes: ['id', 'name'] }],
  order: [['createdAt', 'ASC']],
});

const resolveActiveOrganization = async (user) => {
  const memberships = (await membershipsOf(user.id)).filter((membership) => membership.organization);
  let organizationId = user.organizationId;
  let membership = memberships.find((item) => item.organizationId === organizationId);
  let organization = membership?.organization || null;
  let actingAsPlatformAdmin = false;

  if (!membership && organizationId && user.role === 'admin') {
    organization = await Organization.findByPk(organizationId, { attributes: ['id', 'name'] });
    actingAsPlatformAdmin = Boolean(organization);
  }
  if (!membership && !actingAsPlatformAdmin) {
    // The selection is gone (removed from the organization): fall back to the first membership.
    membership = memberships[0] || null;
    organization = membership?.organization || null;
    organizationId = organization?.id || null;
    if (organizationId !== user.organizationId) {
      await User.update({ organizationId }, { where: { id: user.id } });
    }
  }

  user.setDataValue('organizationId', organization ? organization.id : null);
  user.setDataValue('orgRole', actingAsPlatformAdmin ? 'admin' : membership?.role || 'member');
  user.organization = organization;
  user.memberships = memberships.map((item) => ({ organizationId: item.organizationId, name: item.organization.name, role: item.role }));
  user.actingAsPlatformAdmin = actingAsPlatformAdmin;
  user.changed('organizationId', false);
  user.changed('orgRole', false);
  return user;
};

// Who may create organizations: org admins, platform admins and people who belong to none yet.
const canCreateOrganizations = (user) => user.role === 'admin'
  || user.memberships.length === 0
  || user.memberships.some((membership) => membership.role === 'admin');

const countAdmins = (organizationId, transaction) => Membership.count({ where: { organizationId, role: 'admin' }, transaction });

// Removes a membership; users who had it selected move to another of their organizations.
const removeMembership = async (membership, transaction) => {
  await membership.destroy({ transaction });
  const user = await User.findByPk(membership.userId, { transaction });
  if (user && user.organizationId === membership.organizationId) {
    const next = await Membership.findOne({
      where: { userId: user.id, organizationId: { [Op.ne]: membership.organizationId } },
      order: [['createdAt', 'ASC']],
      transaction,
    });
    await user.update({ organizationId: next ? next.organizationId : null }, { transaction });
  }
};

module.exports = {
  membershipsOf,
  resolveActiveOrganization,
  canCreateOrganizations,
  countAdmins,
  removeMembership,
};
