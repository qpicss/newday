const express = require('express');
const router = express.Router();
const { issueToken } = require('../controllers/oauthController');
const { createRateLimiter } = require('../middleware/rateLimit');

// Failed client authentications count towards the limit.
const tokenLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.TOKEN_RATE_LIMIT_MAX) || 30,
  message: 'Too many failed token requests. Please try again later.',
  skipSuccessful: true,
});

// OAuth 2.0 client credentials for calling APIs through gateways.
router.post('/token', tokenLimiter, issueToken);

module.exports = router;
