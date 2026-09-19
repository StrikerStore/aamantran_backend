const express = require('express');
const router = express.Router();
const verifyAdminJWT = require('../middleware/auth');
const { getSummary, getLive } = require('../controllers/websiteAnalytics.controller');
const { getBusiness } = require('../controllers/businessMetrics.controller');

router.use(verifyAdminJWT);

router.get('/summary', getSummary);
router.get('/live', getLive);
// What was sold, rather than who visited. Behind the same range and storefront
// rules as /summary.
router.get('/business', getBusiness);

module.exports = router;
