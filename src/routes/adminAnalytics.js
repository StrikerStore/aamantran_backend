const express = require('express');
const router = express.Router();
const verifyAdminJWT = require('../middleware/auth');
const { getSummary, getLive } = require('../controllers/websiteAnalytics.controller');

router.use(verifyAdminJWT);

router.get('/summary', getSummary);
router.get('/live', getLive);

module.exports = router;
