const express = require('express');
const router = express.Router();
const { register, login, logout, acceptInvitation } = require('../controllers/authController');
const { createRateLimiter } = require('../middleware/rateLimit');

// Only failed logins count towards the limit.
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
  message: 'Too many failed login attempts. Please try again later.',
  skipSuccessful: true,
});

const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.REGISTER_RATE_LIMIT_MAX) || 20,
  message: 'Too many registration attempts. Please try again later.',
});

router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/logout', logout);
router.post('/accept-invite', registerLimiter, acceptInvitation);

module.exports = router;
