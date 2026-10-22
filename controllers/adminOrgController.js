// Platform admin: every organization, its members and its catalogs. To manage an organization's
// catalogs, products, APIs and gateways, a platform admin switches into it (PUT /api/me/organization)
// and uses the organization pages as its admin.
const sequelize = require('../config/database');
const {
  Api,
  ApiProduct,
  Application,
  Catalog,
  Connection,
  DictionaryField,
  DictionaryObject,
  DictionaryProperty,
  Gateway,
  Invitation,
  Membership,
  Organization,
  Policy,
  User,
} = require('../models');
const { sendServerError } = require('../utils/http');
const { normalizeEmail, validateEmail, validateOrganizationName, validateOrgRole } = require('../utils/validation');
const { countAdmins, removeMembership } = require('../services/membership');

const countBy = async (Model, organizationIds) => {
  const rows = await Model.findAll({
    where: { organizationId: organizationIds },
    attributes: ['organizationId', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
    group: ['organizationId'],
    raw: true,
  });
  return new Map(rows.map((row) => [row.organizationId, Number(row.count)]));
};

const organizationCounts = async (organizationIds) => {
  const [members, catalogs, products, apis, gateways, applications] = await Promise.all(
    [Membership, Catalog, ApiProduct, Api, Gateway, Application].map((Model) => countBy(Model, organizationIds))
  );
  return (id) => ({
    members: members.get(id) || 0,
    catalogs: catalogs.get(id) || 0,
    products: products.get(id) || 0,
    apis: apis.get(id) || 0,
    gateways: gateways.get(id) || 0,
    applications: applications.get(id) || 0,
  });
};

const toMember = (membership) => ({
  id: membership.user.id,
  name: membership.user.name,
  email: membership.user.email,
  role: membership.user.role,
  orgRole: membership.role,
  joinedAt: membership.createdAt,
});

// Organizations with their members, catalogs (and what each holds) and gateways.
const describeOrganization = async (organization) => {
  const [memberships, catalogs, gateways, counts] = await Promise.all([
    Membership.findAll({
      where: { organizationId: organization.id },
      include: [{ association: 'user', attributes: ['id', 'name', 'email', 'role'] }],
      order: [['createdAt', 'ASC']],
    }),
    Catalog.findAll({
      where: { organizationId: organization.id },
      include: [
        { association: 'products', attributes: ['id', 'name', 'status'] },
        { association: 'apis', attributes: ['id', 'name'] },
        { association: 'gateways', attributes: ['id', 'name'] },
      ],
      order: [['name', 'ASC']],
    }),
    Gateway.findAll({
      where: { organizationId: organization.id },
      include: [{ association: 'catalog', attributes: ['id', 'name'] }, { association: 'nodes', attributes: ['id'] }],
      order: [['name', 'ASC']],
    }),
    organizationCounts([organization.id]),
  ]);
  return {
    id: organization.id,
    name: organization.name,
    createdAt: organization.createdAt,
    counts: counts(organization.id),
    members: memberships.filter((membership) => membership.user).map(toMember),
    catalogs: catalogs.map((catalog) => ({
      id: catalog.id,
      name: catalog.name,
      description: catalog.description,
      products: catalog.products.map((product) => ({ id: product.id, name: product.name, status: product.status })),
      apis: catalog.apis.map((api) => ({ id: api.id, name: api.name })),
      gateways: catalog.gateways.map((gateway) => ({ id: gateway.id, name: gateway.name })),
    })),
    gateways: gateways.map((gateway) => ({
      id: gateway.id,
      name: gateway.name,
      publicUrl: gateway.publicUrl,
      nodes: gateway.nodes.length,
      catalog: gateway.catalog ? { id: gateway.catalog.id, name: gateway.catalog.name } : null,
    })),
  };
};

const listOrganizations = async (req, res) => {
  try {
    const organizations = await Organization.findAll({ order: [['name', 'ASC']] });
    const counts = await organizationCounts(organizations.map((organization) => organization.id));
    res.json({
      organizations: organizations.map((organization) => ({
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        counts: counts(organization.id),
      })),
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to load organizations');
  }
};

const getOrganization = async (req, res) => {
  try {
    const organization = await Organization.findByPk(req.params.id);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    res.json({ organization: await describeOrganization(organization) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load organization');
  }
};

// Optionally with a first admin, an existing account given by email.
const createOrganization = async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const nameError = validateOrganizationName(name);
    if (nameError) return res.status(400).json({ error: nameError });
    let admin = null;
    if (req.body?.adminEmail) {
      admin = await User.findOne({ where: { email: normalizeEmail(req.body.adminEmail) } });
      if (!admin) return res.status(400).json({ error: 'No account uses that email' });
    }
    const organization = await sequelize.transaction(async (transaction) => {
      const created = await Organization.create({ name: name.trim() }, { transaction });
      if (admin) {
        await Membership.create({ userId: admin.id, organizationId: created.id, role: 'admin' }, { transaction });
        if (!admin.organizationId) await admin.update({ organizationId: created.id }, { transaction });
      }
      return created;
    });
    res.status(201).json({ organization: { id: organization.id, name: organization.name } });
  } catch (error) {
    sendServerError(res, error, 'Failed to create organization');
  }
};

const updateOrganization = async (req, res) => {
  try {
    const organization = await Organization.findByPk(req.params.id);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    const nameError = validateOrganizationName(req.body?.name);
    if (nameError) return res.status(400).json({ error: nameError });
    await organization.update({ name: req.body.name.trim() });
    res.json({ organization: { id: organization.id, name: organization.name } });
  } catch (error) {
    sendServerError(res, error, 'Failed to update organization');
  }
};

// Only an organization without catalogs, APIs, products, gateways or applications can be deleted.
const deleteOrganization = async (req, res) => {
  try {
    const organization = await Organization.findByPk(req.params.id);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    const counts = (await organizationCounts([organization.id]))(organization.id);
    const blocking = ['catalogs', 'apis', 'products', 'gateways', 'applications'].filter((key) => counts[key]);
    if (blocking.length) {
      return res.status(409).json({ error: `Delete its ${blocking.join(', ')} first`, counts });
    }
    await sequelize.transaction(async (transaction) => {
      const memberships = await Membership.findAll({ where: { organizationId: organization.id }, transaction });
      for (const membership of memberships) await removeMembership(membership, transaction);
      await Invitation.destroy({ where: { organizationId: organization.id }, transaction });
      await Policy.destroy({ where: { organizationId: organization.id }, transaction });
      await Connection.destroy({ where: { organizationId: organization.id }, transaction });
      const objects = await DictionaryObject.findAll({ where: { organizationId: organization.id }, attributes: ['id'], transaction });
      if (objects.length) await DictionaryProperty.destroy({ where: { objectId: objects.map((object) => object.id) }, transaction });
      await DictionaryObject.destroy({ where: { organizationId: organization.id }, transaction });
      await DictionaryField.destroy({ where: { organizationId: organization.id }, transaction });
      await organization.destroy({ transaction });
    });
    res.json({ message: `${organization.name} was deleted` });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete organization');
  }
};

const findOrganization = (req) => Organization.findByPk(req.params.id);

// Adds an existing account to the organization.
const addMember = async (req, res) => {
  try {
    const organization = await findOrganization(req);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    const email = normalizeEmail(req.body?.email);
    const orgRole = req.body?.orgRole || 'member';
    const validationError = validateEmail(email) || validateOrgRole(orgRole);
    if (validationError) return res.status(400).json({ error: validationError });
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: 'No account uses that email. Create the user first.' });
    const [membership, created] = await Membership.findOrCreate({
      where: { userId: user.id, organizationId: organization.id },
      defaults: { role: orgRole },
    });
    if (!created) return res.status(409).json({ error: `${user.name} is already a member` });
    if (!user.organizationId) await user.update({ organizationId: organization.id });
    membership.user = user;
    res.status(201).json({ member: toMember(membership) });
  } catch (error) {
    sendServerError(res, error, 'Failed to add member');
  }
};

const findMembership = (req) => Membership.findOne({
  where: { organizationId: req.params.id, userId: req.params.userId },
  include: [{ association: 'user', attributes: ['id', 'name', 'email', 'role'] }],
});

// An organization with members always keeps at least one admin.
const updateMember = async (req, res) => {
  try {
    const membership = await findMembership(req);
    if (!membership) return res.status(404).json({ error: 'Member not found' });
    const roleError = validateOrgRole(req.body?.orgRole);
    if (roleError) return res.status(400).json({ error: roleError });
    if (membership.role === 'admin' && req.body.orgRole !== 'admin' && await countAdmins(membership.organizationId) <= 1) {
      return res.status(409).json({ error: `${membership.user.name} is the only admin. Make another member an admin first.` });
    }
    await membership.update({ role: req.body.orgRole });
    res.json({ member: toMember(membership) });
  } catch (error) {
    sendServerError(res, error, 'Failed to update member');
  }
};

const removeMember = async (req, res) => {
  try {
    const membership = await findMembership(req);
    if (!membership) return res.status(404).json({ error: 'Member not found' });
    const members = await Membership.count({ where: { organizationId: membership.organizationId } });
    if (membership.role === 'admin' && members > 1 && await countAdmins(membership.organizationId) <= 1) {
      return res.status(409).json({ error: `${membership.user.name} is the only admin. Make another member an admin first.` });
    }
    await sequelize.transaction((transaction) => removeMembership(membership, transaction));
    res.json({ message: `${membership.user.name} was removed from the organization` });
  } catch (error) {
    sendServerError(res, error, 'Failed to remove member');
  }
};

module.exports = {
  describeOrganization,
  listOrganizations,
  getOrganization,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  addMember,
  updateMember,
  removeMember,
};
