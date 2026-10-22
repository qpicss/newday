const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const me = require('../controllers/meController');

// The signed-in user's organizations.
router.use(authenticate);

router.get('/organizations', me.listOrganizations);
router.post('/organizations', me.createOrganization);
router.delete('/organizations/:id', me.leaveOrganization);
router.put('/organization', me.switchOrganization);

module.exports = router;
