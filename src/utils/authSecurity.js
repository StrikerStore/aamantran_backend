const crypto = require('crypto');

/**
 * Per-audience JWT secrets. Fall back to the shared JWT_SECRET so existing
 * deployments (and already-issued tokens) keep working until the new env
 * vars are configured.
 */
function adminJwtSecret() {
  return process.env.JWT_SECRET_ADMIN || process.env.JWT_SECRET;
}

function userJwtSecret() {
  return process.env.JWT_SECRET_USER || process.env.JWT_SECRET;
}

/**
 * Short fingerprint of the stored bcrypt hash, embedded in user JWTs as `pv`.
 * Changing the password changes the fingerprint, which invalidates every
 * previously issued token without needing a schema change or a denylist.
 */
function passwordVersion(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 12);
}

/** Constant-time string comparison that doesn't leak length via early exit. */
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssword', 'p@ssw0rd',
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000',
  'qwertyui', 'qwerty123', 'asdfghjk', 'iloveyou', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'welcome1', 'welcome123', 'letmein1',
  'admin123', 'abc12345', 'abcd1234', 'aamantran', 'wedding123', 'india123',
]);

/**
 * Shared password policy for registration and reset.
 * Returns an error message, or null when the password is acceptable.
 */
function validateNewPassword(password) {
  const pw = String(password || '');
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 128) return 'Password must be at most 128 characters';
  if (/^(.)\1+$/.test(pw)) return 'Password cannot be a single repeated character';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) {
    return 'This password is too common — please choose a stronger one';
  }
  return null;
}

module.exports = {
  adminJwtSecret,
  userJwtSecret,
  passwordVersion,
  timingSafeEqualStr,
  validateNewPassword,
};
