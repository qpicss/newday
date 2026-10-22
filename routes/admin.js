const express = require('express');
const router = express.Router();
const { authenticate, authorizeAdmin } = require('../middleware/auth');
const {
  createUser,
  getAllUsers,
  getUser,
  updateUser,
  deleteUser,
  setUserPassword,
  getAllApplications,
  getUserApplications,
  generateToken
} = require('../controllers/adminController');
const {
  getApplication,
  updateApplication,
  deleteApplication,
  listCredentials,
  createCredential,
  deleteCredential,
} = require('../controllers/applicationController');
const organizations = require('../controllers/adminOrgController');

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(authorizeAdmin);

// Lets the shared application handlers act on any user's application
const allApplications = (req, res, next) => {
  req.applicationScope = 'all';
  next();
};

// Get all users
router.get('/users', getAllUsers);

// Create a user
router.post('/users', createUser);

// Get a specific user
router.get('/users/:id', getUser);

// Update a user
router.put('/users/:id', updateUser);
router.post('/users/:id', updateUser);

// Delete a user
router.delete('/users/:id', deleteUser);

// Set a new password for a user
router.put('/users/:id/password', setUserPassword);

// Applications owned by a user
router.get('/users/:id/applications', getUserApplications);

// Manage any user's applications
router.get('/applications', getAllApplications);
router.get('/applications/:id', allApplications, getApplication);
router.put('/applications/:id', allApplications, updateApplication);
router.delete('/applications/:id', allApplications, deleteApplication);
router.get('/applications/:id/credentials', allApplications, listCredentials);
router.post('/applications/:id/credentials', allApplications, createCredential);
router.delete('/applications/:id/credentials/:credentialId', allApplications, deleteCredential);

// Organizations, their members and catalogs
router.get('/organizations', organizations.listOrganizations);
router.post('/organizations', organizations.createOrganization);
router.get('/organizations/:id', organizations.getOrganization);
router.put('/organizations/:id', organizations.updateOrganization);
router.delete('/organizations/:id', organizations.deleteOrganization);
router.post('/organizations/:id/members', organizations.addMember);
router.put('/organizations/:id/members/:userId', organizations.updateMember);
router.delete('/organizations/:id/members/:userId', organizations.removeMember);

// Generate a bearer token for a user
router.post('/token', generateToken);

module.exports = router;
