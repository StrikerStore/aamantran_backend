const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const prisma  = require('../utils/prisma');
const verifyUserJWT = require('../middleware/userAuth');
const { sendAccountRecoveryCodeEmail } = require('../services/email.service');
const { authLoginLimiter, recoveryLimiter } = require('../middleware/rateLimits');

const router = express.Router();
const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;
const RECOVERY_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const accountRecoveryStore = new Map();

// Periodic cleanup of expired recovery codes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of accountRecoveryStore) {
    if (entry.expiresAt < now) accountRecoveryStore.delete(key);
  }
}, RECOVERY_CLEANUP_INTERVAL_MS).unref();

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

// POST /api/user/auth/login
router.post('/login', authLoginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, message: 'Username and password required' });
  }

  const user = await prisma.user.findFirst({
    where: { username: String(username).trim().toLowerCase() },
    select: { id: true, username: true, email: true, phone: true, passwordHash: true },
  });

  if (!user) {
    return res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(String(password), user.passwordHash);
  if (!valid) {
    return res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { role: 'user', id: user.id, username: user.username, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d', issuer: 'aamantran:user' }
  );

  return res.json({
    ok: true,
    token,
    user: { id: user.id, username: user.username, email: user.email, phone: user.phone },
  });
});

// POST /api/user/auth/recovery/request
router.post('/recovery/request', recoveryLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ ok: false, message: 'Email is required' });
  }

  const user = await prisma.user.findFirst({
    where: { email },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, username: true },
  });

  if (user) {
    const code = String(crypto.randomInt(100000, 1000000));
    accountRecoveryStore.set(email, {
      userId: user.id,
      codeHash: hashCode(code),
      expiresAt: Date.now() + RECOVERY_CODE_TTL_MS,
    });
    await sendAccountRecoveryCodeEmail({ to: email, code });
  }

  return res.json({
    ok: true,
    message: 'If this email exists, a recovery code has been sent.',
  });
});

// POST /api/user/auth/recovery/verify
router.post('/recovery/verify', recoveryLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();
  if (!email || !code) {
    return res.status(400).json({ ok: false, message: 'Email and code are required' });
  }

  const entry = accountRecoveryStore.get(email);
  if (!entry || entry.expiresAt < Date.now() || entry.codeHash !== hashCode(code)) {
    return res.status(400).json({ ok: false, message: 'Invalid or expired recovery code' });
  }

  const user = await prisma.user.findUnique({
    where: { id: entry.userId },
    select: { id: true, username: true, email: true },
  });
  if (!user) {
    accountRecoveryStore.delete(email);
    return res.status(404).json({ ok: false, message: 'User not found' });
  }

  const resetToken = jwt.sign(
    { role: 'user', id: user.id, purpose: 'account_recovery' },
    process.env.JWT_SECRET,
    { expiresIn: '15m', issuer: 'aamantran:recovery' },
  );

  return res.json({
    ok: true,
    username: user.username,
    resetToken,
    message: 'Code verified. You can now reset your password.',
  });
});

// POST /api/user/auth/recovery/reset-password
router.post('/recovery/reset-password', recoveryLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const resetToken = String(req.body?.resetToken || '');
  const newPassword = String(req.body?.newPassword || '');

  if (!email || !resetToken || !newPassword) {
    return res.status(400).json({ ok: false, message: 'Email, reset token, and new password are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ ok: false, message: 'Password must be at least 8 characters' });
  }

  let payload;
  try {
    payload = jwt.verify(resetToken, process.env.JWT_SECRET, { issuer: 'aamantran:recovery' });
  } catch {
    return res.status(401).json({ ok: false, message: 'Invalid or expired reset session' });
  }

  if (!payload?.id || payload?.purpose !== 'account_recovery') {
    return res.status(401).json({ ok: false, message: 'Invalid reset session' });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: { id: true, email: true },
  });
  if (!user || normalizeEmail(user.email) !== email) {
    return res.status(404).json({ ok: false, message: 'User not found for this recovery session' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });
  accountRecoveryStore.delete(email);

  return res.json({ ok: true, message: 'Password reset successfully. Please sign in.' });
});

// GET /api/user/auth/me
router.get('/me', verifyUserJWT, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      username: true,
      email: true,
      phone: true,
      createdAt: true,
      events: {
        select: {
          id: true,
          slug: true,
          subdomain: true,
          community: true,
          eventType: true,
          isPublished: true,
          namesAreFrozen: true,
          language: true,
          createdAt: true,
          template: {
            select: { id: true, name: true, slug: true, thumbnailUrl: true, fieldSchema: true },
          },
          _count: {
            select: { functions: true, guests: true, media: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!user) return res.status(404).json({ ok: false, message: 'User not found' });

  return res.json({ ok: true, user });
});

module.exports = router;
