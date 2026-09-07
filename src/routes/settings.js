const express = require('express');
const auth = require('../middleware/auth');
const controller = require('../controllers/settings.controller');

const router = express.Router();
router.use(auth);

router.get('/pricing',          controller.getPricing);
router.put('/pricing',          controller.updatePricing);
router.get('/pricing/preview',  controller.previewPricing);

module.exports = router;
