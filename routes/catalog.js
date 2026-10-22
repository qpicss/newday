const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { listCatalog, getCatalogProduct } = require('../controllers/catalogController');

// Published API products from every organization.
router.use(authenticate);

router.get('/', listCatalog);
router.get('/:id', getCatalogProduct);

module.exports = router;
