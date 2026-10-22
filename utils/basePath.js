// Gateway base paths: the prefix an API is served under, e.g. /orders or /acme/orders/v2.
const { Op } = require('sequelize');

const BASE_PATH = /^(\/[a-z0-9][a-z0-9._~-]*)+$/;

const slugify = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^\w\s-]/g, '')
  .trim()
  .replace(/[\s_]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 60) || 'api';

const normalizeBasePath = (value) => `/${String(value || '').split('/').filter(Boolean).join('/')}`.toLowerCase();

const validateBasePath = (value) => {
  if (typeof value !== 'string') return 'Base path is required, for example /orders';
  const normalized = normalizeBasePath(value);
  if (normalized === '/' || normalized.length > 200 || !BASE_PATH.test(normalized)) {
    return 'Base paths start with "/" and use lowercase letters, digits, "-", "_", "." or "~" (for example /orders/v2)';
  }
  return null;
};

// First free /name, /name-2, /name-3 ... within the organization.
const uniqueBasePath = async (Api, organizationId, name, excludeId = null) => {
  const base = `/${slugify(name)}`;
  const taken = new Set((await Api.findAll({
    where: {
      organizationId,
      basePath: { [Op.like]: `${base}%` },
      ...(excludeId && { id: { [Op.ne]: excludeId } }),
    },
    attributes: ['basePath'],
  })).map((api) => api.basePath));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
};

module.exports = { slugify, normalizeBasePath, validateBasePath, uniqueBasePath };
