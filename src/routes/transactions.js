const express    = require('express');
const auth       = require('../middleware/auth');
const controller = require('../controllers/transactions.controller');

const router = express.Router();
router.use(auth);

router.get ('/',           controller.list);
// Before '/:id', or 'export' is read as a payment id.
router.get ('/export',     controller.exportCsv);
router.get ('/:id',        controller.get);
router.post('/:id/refund', controller.refund);

module.exports = router;
