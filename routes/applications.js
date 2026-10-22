const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  createApplication,
  getApplications,
  getApplication,
  updateApplication,
  deleteApplication,
  listCredentials,
  createCredential,
  deleteCredential,
} = require('../controllers/applicationController');
const {
  requestSubscription,
  listApplicationSubscriptions,
  cancelSubscription,
} = require('../controllers/catalogController');

router.use(authenticate);

router.post('/', createApplication);
router.get('/', getApplications);
router.get('/:id', getApplication);
router.put('/:id', updateApplication);
router.delete('/:id', deleteApplication);

// Extra client IDs and secrets
router.get('/:id/credentials', listCredentials);
router.post('/:id/credentials', createCredential);
router.delete('/:id/credentials/:credentialId', deleteCredential);

// Access requests to API products
router.get('/:id/subscriptions', listApplicationSubscriptions);
router.post('/:id/subscriptions', requestSubscription);
router.delete('/:id/subscriptions/:subscriptionId', cancelSubscription);

module.exports = router;
