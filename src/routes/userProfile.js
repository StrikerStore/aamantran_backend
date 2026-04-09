const express = require('express');
const verifyUserJWT = require('../middleware/userAuth');
const c = require('../controllers/userDashboard.controller');

const router = express.Router();

// ── Profile (protected) ───────────────────────────────────────────────────────
router.patch('/profile', verifyUserJWT, c.updateProfile);

// ── Review (protected) ────────────────────────────────────────────────────────
router.post('/review', verifyUserJWT, c.submitReview);

module.exports = router;
