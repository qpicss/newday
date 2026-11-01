// Admin UI sign-in tickets: the console signs a short-lived ticket for an org admin who opens this
// node's admin UI from the gateway page. The node checks it with the token keys of its configuration,
// so signing in needs no connection from the node to the console (push nodes have none).
const jwt = require('jsonwebtoken');

const ADMIN_AUDIENCE = 'oauth-server-gateway-admin';
// Console and node clocks often differ (an office PC and a cloud server). A ticket still works once
// only, so a few minutes of tolerance cost nothing.
const CLOCK_TOLERANCE_SECONDS = 300;

class TicketError extends Error {}

// Returns verify(ticket, runtime) -> { id, name, email, organization }. A ticket names the gateway
// (every node of a gateway shares its certificate and admins) and works once on each node.
const createTicketVerifier = ({ gatewayId }) => {
  const used = new Map(); // jti -> expiry (ms)

  return (ticket, runtime) => {
    if (!runtime) throw new TicketError('This node has no configuration yet. Push the configuration from the console, then open the admin UI again.');
    const decoded = jwt.decode(ticket, { complete: true });
    if (!decoded || typeof decoded.payload !== 'object') {
      throw new TicketError('This sign-in link is invalid. Open the admin UI from the gateway page in the console again.');
    }
    const key = runtime.tokenKeys.get(decoded.header.kid);
    if (!key || (decoded.payload.aud === ADMIN_AUDIENCE && decoded.payload.iss !== runtime.issuer)) {
      // Signed by the console, but not with what this node's configuration knows: it is out of date.
      throw new TicketError("This node's configuration is out of date, so it can't check the sign-in link. Push the configuration from the console, then open the admin UI again.");
    }
    let payload;
    try {
      payload = jwt.verify(ticket, key, {
        algorithms: ['RS256'], audience: ADMIN_AUDIENCE, issuer: runtime.issuer, clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new TicketError("This sign-in link has expired. Open the admin UI from the console again. If this keeps happening, the clocks of this server and the console's computer differ by more than 5 minutes: turn on time sync (NTP) on both.");
      }
      throw new TicketError('This sign-in link is invalid. Open the admin UI from the gateway page in the console again.');
    }
    if (payload.gatewayId !== gatewayId || !payload.jti) {
      throw new TicketError("This sign-in link was issued for another gateway. Open the admin UI from this gateway's page in the console.");
    }
    const now = Date.now();
    for (const [jti, expiresAt] of used) if (expiresAt < now) used.delete(jti);
    if (used.has(payload.jti)) throw new TicketError('This sign-in link was already used. Open the admin UI from the console again.');
    used.set(payload.jti, (payload.exp + CLOCK_TOLERANCE_SECONDS) * 1000);
    return { id: payload.sub, name: payload.name, email: payload.email, organization: payload.organization || '' };
  };
};

module.exports = { ADMIN_AUDIENCE, TicketError, createTicketVerifier };
