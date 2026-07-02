const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { authLoginLimiter } = require('../middleware/rateLimits');
const { adminJwtSecret, timingSafeEqualStr } = require('../utils/authSecurity');
const { verifyTotp } = require('../utils/totp');
const { logAuthEvent } = require('../utils/authAudit');

const router = express.Router();

// Compared against when the email doesn't match, so response timing is the
// same whether or not the email is the real admin address.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('aamantran-timing-dummy', 10);

if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD_HASH) {
  console.warn(
    '[auth] ADMIN_PASSWORD is stored in plaintext. Set ADMIN_PASSWORD_HASH ' +
    '(bcrypt hash, e.g. via: node -e "console.log(require(\'bcrypt\').hashSync(process.argv[1], 12))" <password>) ' +
    'and remove ADMIN_PASSWORD.'
  );
}

// POST /api/v1/auth/login
// Body: { email, password, otp? }
router.post('/login', authLoginLimiter, async (req, res) => {
  const { email, password, otp } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email and password required' });
  }

  const adminEmail        = process.env.ADMIN_EMAIL;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
  const adminPassword     = process.env.ADMIN_PASSWORD;

  const emailOk = timingSafeEqualStr(email, adminEmail || '');

  // Always run the same comparison work regardless of whether the email
  // matched, so failures don't leak which field was wrong.
  let passwordOk;
  if (adminPasswordHash) {
    passwordOk = await bcrypt.compare(String(password), emailOk ? adminPasswordHash : DUMMY_BCRYPT_HASH);
  } else {
    passwordOk = timingSafeEqualStr(password, adminPassword || '');
  }

  if (!emailOk || !passwordOk) {
    logAuthEvent('admin_login_failed', req, { email: String(email).slice(0, 120) });
    return res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }

  // Optional second factor — enforced when ADMIN_TOTP_SECRET (base32) is set.
  const totpSecret = process.env.ADMIN_TOTP_SECRET;
  if (totpSecret) {
    if (!otp) {
      return res.status(401).json({ ok: false, code: 'OTP_REQUIRED', message: 'Enter your authenticator code' });
    }
    if (!verifyTotp(otp, totpSecret)) {
      logAuthEvent('admin_login_otp_failed', req, {});
      return res.status(401).json({ ok: false, code: 'OTP_INVALID', message: 'Invalid authenticator code' });
    }
  }

  const token = jwt.sign(
    { role: 'admin', email: adminEmail },
    adminJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'aamantran:admin' }
  );

  logAuthEvent('admin_login_success', req, {});

  res.json({
    ok: true,
    token,
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });
});

module.exports = router;
