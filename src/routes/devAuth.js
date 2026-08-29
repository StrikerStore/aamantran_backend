const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const prisma  = require('../utils/prisma');
const verifyDevJWT = require('../middleware/devAuth');
const { authLoginLimiter } = require('../middleware/rateLimits');
const { devJwtSecret, passwordVersion } = require('../utils/authSecurity');
const { logAuthEvent } = require('../utils/authAudit');

const router = express.Router();

// Compared against when the handle doesn't exist, so response timing is the
// same for unknown and known handles (prevents account enumeration).
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('aamantran-timing-dummy', 12);

// POST /api/dev/auth/login
// Body: { handle, password }  — `handle` also accepts the account email.
router.post('/login', authLoginLimiter, async (req, res) => {
  const { handle, password } = req.body || {};
  if (!handle || !password) {
    return res.status(400).json({ ok: false, message: 'Handle and password required' });
  }

  const key = String(handle).trim().toLowerCase();
  const dev = await prisma.developerAccount.findFirst({
    where:  { OR: [{ handle: key }, { email: key }] },
    select: { id: true, handle: true, name: true, email: true, isActive: true, passwordHash: true },
  });

  // Run bcrypt even when the account doesn't exist so timing doesn't reveal
  // whether a handle is registered.
  const valid = await bcrypt.compare(String(password), dev ? dev.passwordHash : DUMMY_BCRYPT_HASH);

  if (!dev || !valid) {
    logAuthEvent('dev_login_failed', req, { handle: key.slice(0, 80) });
    return res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }
  // Checked after the password so a disabled account can't be distinguished
  // from a wrong password by anyone who doesn't already know the password.
  if (!dev.isActive) {
    logAuthEvent('dev_login_disabled', req, { developerId: dev.id });
    return res.status(403).json({ ok: false, message: 'This developer account has been disabled.' });
  }

  const expiresIn = '12h';
  const token = jwt.sign(
    {
      role: 'dev',
      id: dev.id,
      handle: dev.handle,
      email: dev.email,
      pv: passwordVersion(dev.passwordHash),
    },
    devJwtSecret(),
    { expiresIn, issuer: 'aamantran:dev' }
  );

  await prisma.developerAccount.update({
    where: { id: dev.id },
    data:  { lastLoginAt: new Date() },
  });

  logAuthEvent('dev_login_success', req, { developerId: dev.id });

  return res.json({
    ok: true,
    token,
    expiresIn,
    developer: { id: dev.id, handle: dev.handle, name: dev.name, email: dev.email },
  });
});

// GET /api/dev/auth/me
router.get('/me', verifyDevJWT, async (req, res) => {
  const dev = await prisma.developerAccount.findUnique({
    where:  { id: req.dev.id },
    select: { id: true, handle: true, name: true, email: true, templateLimit: true, createdAt: true },
  });
  res.json({ ok: true, developer: dev });
});

module.exports = router;
