const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const prisma  = require('../utils/prisma');
const verifyUserJWT = require('../middleware/userAuth');
const { sendAccountRecoveryCodeEmail, sendPasswordChangedEmail } = require('../services/email.service');
const { authLoginLimiter, recoveryLimiter } = require('../middleware/rateLimits');
const { userJwtSecret, passwordVersion, timingSafeEqualStr, validateNewPassword } = require('../utils/authSecurity');
const { logAuthEvent } = require('../utils/authAudit');

const router = express.Router();
const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;
const RECOVERY_RESET_TTL_MS = 15 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const accountRecoveryStore = new Map();

// Compared against when the username doesn't exist, so response timing is the
// same for unknown and known usernames (prevents account enumeration).
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('aamantran-timing-dummy', 12);

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
// Body: { username, password, rememberMe? }
router.post('/login', authLoginLimiter, async (req, res) => {
  const { username, password, rememberMe = true } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, message: 'Username and password required' });
  }

  const user = await prisma.user.findFirst({
    where: { username: String(username).trim().toLowerCase() },
    select: { id: true, username: true, email: true, phone: true, passwordHash: true },
  });

  // Run bcrypt even when the user doesn't exist so timing doesn't reveal
  // whether a username is registered.
  const valid = await bcrypt.compare(String(password), user ? user.passwordHash : DUMMY_BCRYPT_HASH);

  if (!user || !valid) {
    logAuthEvent('user_login_failed', req, { username: String(username).slice(0, 80) });
    return res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }

  const expiresIn = rememberMe ? '7d' : '1d';
  const token = jwt.sign(
    {
      role: 'user',
      id: user.id,
      username: user.username,
      email: user.email,
      pv: passwordVersion(user.passwordHash),
    },
    userJwtSecret(),
    { expiresIn, issuer: 'aamantran:user' }
  );

  logAuthEvent('user_login_success', req, { userId: user.id });

  return res.json({
    ok: true,
    token,
    expiresIn,
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
      attempts: 0,
      resetNonce: null,
    });
    logAuthEvent('recovery_code_sent', req, { userId: user.id });
    await sendAccountRecoveryCodeEmail({ to: email, code });
  } else {
    logAuthEvent('recovery_requested_unknown_email', req, {});
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
  if (!entry || entry.expiresAt < Date.now()) {
    accountRecoveryStore.delete(email);
    return res.status(400).json({ ok: false, message: 'Invalid or expired recovery code' });
  }

  if (!timingSafeEqualStr(entry.codeHash, hashCode(code))) {
    entry.attempts += 1;
    // Burn the code after too many wrong guesses so a 6-digit code can't be
    // brute-forced within its TTL.
    if (entry.attempts >= RECOVERY_MAX_ATTEMPTS) {
      accountRecoveryStore.delete(email);
      logAuthEvent('recovery_code_burned', req, {});
      return res.status(400).json({ ok: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }
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

  // Single-use handshake: the nonce lives in the store and inside the reset
  // token; reset-password requires both to match and then deletes the entry,
  // so a captured/replayed token can't reset the password twice.
  entry.resetNonce = crypto.randomUUID();
  entry.expiresAt = Date.now() + RECOVERY_RESET_TTL_MS;

  const resetToken = jwt.sign(
    { role: 'user', id: user.id, purpose: 'account_recovery', nonce: entry.resetNonce },
    userJwtSecret(),
    { expiresIn: '15m', issuer: 'aamantran:recovery' },
  );

  logAuthEvent('recovery_code_verified', req, { userId: user.id });

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
  const passwordError = validateNewPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ ok: false, message: passwordError });
  }

  let payload;
  try {
    payload = jwt.verify(resetToken, userJwtSecret(), { issuer: 'aamantran:recovery' });
  } catch {
    return res.status(401).json({ ok: false, message: 'Invalid or expired reset session' });
  }

  if (!payload?.id || payload?.purpose !== 'account_recovery') {
    return res.status(401).json({ ok: false, message: 'Invalid reset session' });
  }

  const entry = accountRecoveryStore.get(email);
  if (!entry || !entry.resetNonce || !payload.nonce || entry.resetNonce !== payload.nonce) {
    return res.status(401).json({ ok: false, message: 'This reset session has already been used or has expired' });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: { id: true, email: true, username: true },
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

  logAuthEvent('password_reset', req, { userId: user.id });

  // Best-effort notification — the reset itself already succeeded.
  sendPasswordChangedEmail({ to: user.email, username: user.username }).catch(err =>
    console.error('[auth] password-changed email failed:', err.message)
  );

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
