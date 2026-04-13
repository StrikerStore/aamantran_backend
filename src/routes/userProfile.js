const express = require('express');
const multer  = require('multer');
const path    = require('path');
const verifyUserJWT = require('../middleware/userAuth');
const c = require('../controllers/userDashboard.controller');

const router = express.Router();

// Image-only multer for review couple photo (5 MB max, images only)
const reviewImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.avif'].includes(ext)) return cb(null, true);
    cb(new Error('Only image files are allowed for review photos'));
  },
});

// ── Profile (protected) ───────────────────────────────────────────────────────
router.patch('/profile', verifyUserJWT, c.updateProfile);

// ── Review (protected) ────────────────────────────────────────────────────────
router.post('/review', verifyUserJWT, reviewImageUpload.single('couplePhoto'), c.submitReview);

module.exports = router;
