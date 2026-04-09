const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { authLoginLimiter } = require('../middleware/rateLimits');

const router = express.Router();

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// POST /api/v1/auth/login
// Body: { email, password }
router.post('/login', authLoginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email and password required' });
  }

  const adminEmail    = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!timingSafeEqual(email, adminEmail || '')) {
    return res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }

  if (!timingSafeEqual(password, adminPassword || '')) {
    return res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { role: 'admin', email: adminEmail },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'aamantran:admin' }
  );

  res.json({
    ok: true,
    token,
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });
});

module.exports = router;
