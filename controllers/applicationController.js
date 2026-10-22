const { randomBytes, randomUUID } = require('crypto');
const sequelize = require('../config/database');
const { Application, ApplicationCredential, Token, Subscription } = require('../models');
const { scheduleAutoPush } = require('../services/autoPush');
const { sendServerError } = require('../utils/http');
const { parseRedirectUris } = require('../utils/validation');

// Never includes the client secret (or its hash).
const serializeApplication = (application) => ({
  id: application.id,
  name: application.name,
  description: application.description,
  clientId: application.clientId,
  redirectUris: application.redirectUris,
  publicKey: application.publicKey,
  organizationId: application.organizationId,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
  ...(application.owner && {
    owner: { id: application.owner.id, name: application.owner.name, email: application.owner.email },
  }),
});

const optionalText = (value, label, maxLength) => {
  if (value === null || value === '') {
    return { value: null };
  }
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    return { error: `${label} must be text of at most ${maxLength} characters` };
  }
  return { value: value.trim() || null };
};

// With partial = true only the provided fields are validated and returned.
const validateApplicationInput = (body = {}, { partial = false } = {}) => {
  const fields = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) {
      return { error: 'Application name is required (max 255 characters)' };
    }
    fields.name = name;
  }

  if (body.description !== undefined) {
    const { value, error } = optionalText(body.description, 'Description', 2000);
    if (error) return { error };
    fields.description = value;
  }

  if (!partial || body.redirectUris !== undefined) {
    const { uris, error } = parseRedirectUris(body.redirectUris);
    if (error) return { error };
    fields.redirectUris = uris;
  }

  if (body.publicKey !== undefined) {
    const { value, error } = optionalText(body.publicKey, 'Public key', 10000);
    if (error) return { error };
    fields.publicKey = value;
  }

  return { fields };
};

// Admin routes set req.applicationScope = 'all' to act on any user's application.
const findApplication = (req) => {
  const allUsers = req.applicationScope === 'all';
  return Application.findOne({
    where: allUsers ? { id: req.params.id } : { id: req.params.id, userId: req.user.id },
    include: allUsers ? [{ association: 'owner', attributes: ['id', 'name', 'email'] }] : [],
  });
};

const createApplication = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { fields, error } = validateApplicationInput(req.body);
    if (error) {
      return res.status(400).json({ error });
    }

    // Generate client ID and secret; only the secret's hash is stored.
    const clientId = randomUUID();
    const clientSecret = randomBytes(32).toString('base64url');

    // The application belongs to the organization the user is working in.
    const application = await Application.create({
      ...fields,
      userId,
      organizationId: req.user.organizationId || null,
      clientId,
      clientSecret: Application.hashSecret(clientSecret),
    });

    const applicationResponse = {
      ...serializeApplication(application),
      clientSecret,
    };

    if (req.renderApplicationResponse) {
      return res.status(201).render('application-created.html', {
        user: req.user,
        application: applicationResponse,
      });
    }

    res.status(201).json({
      message: 'Application created successfully',
      application: applicationResponse,
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to create application');
  }
};

const getApplications = async (req, res) => {
  try {
    // Only the applications of the organization the user is working in.
    const applications = await Application.findAll({
      where: { userId: req.user.id, organizationId: req.user.organizationId || null },
      order: [['createdAt', 'DESC']],
    });

    res.json({ applications: applications.map(serializeApplication) });
  } catch (error) {
    sendServerError(res, error, 'Failed to fetch applications');
  }
};

const getApplication = async (req, res) => {
  try {
    const application = await findApplication(req);

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({ application: serializeApplication(application) });
  } catch (error) {
    sendServerError(res, error, 'Failed to fetch application');
  }
};

const updateApplication = async (req, res) => {
  try {
    const application = await findApplication(req);

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const { fields, error } = validateApplicationInput(req.body, { partial: true });
    if (error) {
      return res.status(400).json({ error });
    }

    await application.update(fields);

    res.json({
      message: 'Application updated successfully',
      application: serializeApplication(application),
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to update application');
  }
};

const deleteApplication = async (req, res) => {
  try {
    const application = await findApplication(req);

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const approved = await Subscription.findAll({
      where: { applicationId: application.id, status: 'approved' },
      include: [{ association: 'product', attributes: ['organizationId'] }],
    });
    await sequelize.transaction(async (transaction) => {
      await Token.destroy({ where: { applicationId: application.id }, transaction });
      await Subscription.destroy({ where: { applicationId: application.id }, transaction });
      await ApplicationCredential.destroy({ where: { applicationId: application.id }, transaction });
      await application.destroy({ transaction });
    });
    // Remove its access from the publishers' gateways.
    new Set(approved.map((subscription) => subscription.product?.organizationId)).forEach(scheduleAutoPush);

    res.json({ message: 'Application deleted successfully' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete application');
  }
};

// ------------------------------------------------------------------ extra credentials

// Besides the client ID and secret it was created with, an application can have a few more, one
// per client or environment, each deleted on its own.
const MAX_CREDENTIALS = 10;

// Never includes the secret (or its hash).
const serializeCredential = (credential) => ({
  id: credential.id,
  name: credential.name,
  clientId: credential.clientId,
  createdAt: credential.createdAt,
  lastUsedAt: credential.lastUsedAt,
});

const listCredentials = async (req, res) => {
  try {
    const application = await findApplication(req);
    if (!application) return res.status(404).json({ error: 'Application not found' });
    const credentials = await ApplicationCredential.findAll({ where: { applicationId: application.id }, order: [['createdAt', 'ASC']] });
    res.json({ credentials: credentials.map(serializeCredential) });
  } catch (error) {
    sendServerError(res, error, 'Failed to fetch credentials');
  }
};

const createCredential = async (req, res) => {
  try {
    const application = await findApplication(req);
    if (!application) return res.status(404).json({ error: 'Application not found' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) {
      return res.status(400).json({ error: 'Name the credentials (max 100 characters), for example Production server' });
    }
    const existing = await ApplicationCredential.findAll({ where: { applicationId: application.id }, attributes: ['name'] });
    if (existing.length >= MAX_CREDENTIALS) {
      return res.status(400).json({ error: `An application can have at most ${MAX_CREDENTIALS} extra sets of credentials. Delete one you no longer use first.` });
    }
    if (existing.some((credential) => credential.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: `This application already has credentials named "${name}"` });
    }

    const clientSecret = randomBytes(32).toString('base64url');
    const credential = await ApplicationCredential.create({
      applicationId: application.id,
      name,
      clientId: randomUUID(),
      secretHash: Application.hashSecret(clientSecret),
      createdById: req.user.id,
    });
    // The secret is returned this once and only its hash is kept.
    res.status(201).json({ message: 'Credentials created', credential: { ...serializeCredential(credential), clientSecret } });
  } catch (error) {
    sendServerError(res, error, 'Failed to create credentials');
  }
};

const deleteCredential = async (req, res) => {
  try {
    const application = await findApplication(req);
    if (!application) return res.status(404).json({ error: 'Application not found' });
    const credential = await ApplicationCredential.findOne({ where: { id: req.params.credentialId, applicationId: application.id } });
    if (!credential) return res.status(404).json({ error: 'Credentials not found' });
    await credential.destroy();
    res.json({ message: 'Credentials deleted' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete credentials');
  }
};

module.exports = {
  createApplication,
  getApplications,
  getApplication,
  updateApplication,
  deleteApplication,
  serializeApplication,
  serializeCredential,
  listCredentials,
  createCredential,
  deleteCredential,
  MAX_CREDENTIALS,
};
