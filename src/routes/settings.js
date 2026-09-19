const express = require('express');
const auth = require('../middleware/auth');
const controller = require('../controllers/settings.controller');

const router = express.Router();
router.use(auth);

router.get('/pricing',          controller.getPricing);
router.put('/pricing',          controller.updatePricing);
router.get('/pricing/preview',  controller.previewPricing);

router.get('/gateway',          controller.getGateway);
router.put('/gateway',          controller.updateGateway);

module.exports = router;
