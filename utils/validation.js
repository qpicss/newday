const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const validateEmail = (email) => {
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return 'A valid email address is required';
  }
  return null;
};

const validatePassword = (password) => {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  // bcrypt only uses the first 72 bytes of a password.
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return 'Password must be at most 72 bytes';
  }
  return null;
};

const validateName = (name) => {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return 'Name is required (max 100 characters)';
  }
  return null;
};

const ORG_ROLES = ['admin', 'member'];

const validateOrganizationName = (name) => {
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
    return 'Organization name is required (2 to 100 characters)';
  }
  return null;
};

const validateOrgRole = (role) => (ORG_ROLES.includes(role) ? null : 'Role must be "admin" or "member"');

// Optional free text: returns { value } (null when empty) or { error }.
const optionalText = (value, label, maxLength) => {
  if (value === undefined || value === null || value === '') {
    return { value: null };
  }
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    return { error: `${label} must be text of at most ${maxLength} characters` };
  }
  return { value: value.trim() || null };
};

// Accepts an array, a JSON-encoded array, or a newline/comma separated string.
const toUriList = (input) => {
  if (Array.isArray(input)) {
    return input;
  }
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return trimmed.split(/[\r\n,]+/);
};

const validateRedirectUri = (uri) => {
  if (typeof uri !== 'string' || uri.length > MAX_REDIRECT_URI_LENGTH) {
    return 'Redirect URIs must be strings of at most 2048 characters';
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return `Invalid redirect URI: ${uri}`;
  }

  if (parsed.hash) {
    return `Redirect URIs must not contain a fragment: ${uri}`;
  }
  if (parsed.protocol === 'https:') {
    return null;
  }
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return null;
  }
  return `Redirect URIs must use https (http is only allowed for localhost): ${uri}`;
};

const parseRedirectUris = (input) => {
  const list = toUriList(input);
  if (!list) {
    return { error: 'Redirect URIs must be a list of URLs' };
  }

  const uris = [...new Set(list.map((uri) => (typeof uri === 'string' ? uri.trim() : uri)).filter(Boolean))];
  if (uris.length === 0) {
    return { error: 'At least one redirect URI is required' };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return { error: `At most ${MAX_REDIRECT_URIS} redirect URIs are allowed` };
  }

  for (const uri of uris) {
    const error = validateRedirectUri(uri);
    if (error) {
      return { error };
    }
  }
  return { uris };
};

module.exports = {
  normalizeEmail,
  validateEmail,
  validatePassword,
  validateName,
  validateOrganizationName,
  validateOrgRole,
  optionalText,
  parseRedirectUris,
  ORG_ROLES,
};
