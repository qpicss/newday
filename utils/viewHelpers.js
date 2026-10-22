// Helpers available in every template (registered on app.locals).
const initials = (name = '') => (
  String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?'
);

const formatDate = (value) => (
  value
    ? new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : ''
);

const formatMoney = (cents, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

// Products reach templates either as models or serialized ({ billing, rateLimit }).
const billingOf = (product) => product.billing || {
  plan: product.billingPlan,
  priceCents: product.billingPriceCents,
  currency: product.billingCurrency,
  interval: product.billingInterval,
};

const rateLimitOf = (product) => product.rateLimit || {
  enabled: product.rateLimitEnabled,
  requests: product.rateLimitRequests,
  period: product.rateLimitPeriod,
};

// "Free", "$49.00 / month" or "$0.50 per 1,000 requests"
const formatBilling = (product) => {
  const billing = billingOf(product);
  if (billing.plan === 'flat') {
    return `${formatMoney(billing.priceCents, billing.currency)} / ${billing.interval}`;
  }
  if (billing.plan === 'usage') {
    return `${formatMoney(billing.priceCents, billing.currency)} per 1,000 requests`;
  }
  return 'Free';
};

const formatRateLimit = (product) => {
  const rateLimit = rateLimitOf(product);
  return rateLimit.enabled
    ? `${Number(rateLimit.requests).toLocaleString('en-US')} requests / ${rateLimit.period}`
    : 'Unlimited';
};

const SUBSCRIPTION_STATUSES = {
  pending: { label: 'Pending approval', className: 'badge-warning' },
  approved: { label: 'Approved', className: 'badge-success' },
  rejected: { label: 'Rejected', className: 'badge-danger' },
  revoked: { label: 'Revoked', className: 'badge-danger' },
};

// Label and badge class for an access request status.
const subscriptionStatus = (status) => SUBSCRIPTION_STATUSES[status] || { label: status, className: '' };

const GATEWAY_STATES = {
  deployed: { label: 'Deployed', className: 'badge-success' },
  warning: { label: 'Deployed with warnings', className: 'badge-warning' },
  outdated: { label: 'Changes not deployed', className: 'badge-warning' },
  not_deployed: { label: 'Not deployed yet', className: '' },
  no_nodes: { label: 'No nodes', className: '' },
  error: { label: 'Push failed', className: 'badge-danger' },
};

// Label and badge class for a gateway's deployment state (services/gatewayConfig.js).
const gatewayState = (state) => GATEWAY_STATES[state] || { label: state, className: '' };

const NODE_STATUSES = {
  ok: { label: 'In sync', className: 'badge-success' },
  warning: { label: 'Warning', className: 'badge-warning' },
  error: { label: 'Failed', className: 'badge-danger' },
};

const nodeStatus = (status) => NODE_STATUSES[status] || { label: 'Never pushed', className: '' };

module.exports = {
  gatewayState,
  nodeStatus,
  initials,
  formatDate,
  formatMoney,
  formatBilling,
  formatRateLimit,
  subscriptionStatus,
};
