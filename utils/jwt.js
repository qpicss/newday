const jwt = require('jsonwebtoken');

const generateJWT = (payload, expiresIn = '1h') => {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};

const verifyJWT = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

const generateUserToken = (user, expiresIn = '1h') => {
  return generateJWT({ userId: user.id, role: user.role }, expiresIn);
};

module.exports = { generateJWT, verifyJWT, generateUserToken };
