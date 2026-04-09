const rateLimit = require('express-rate-limit');

/** Skip rate limiting for health checks */
function skipHealth(req) {
  return req.path === '/health';
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GLOBAL_MAX || 600),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => skipHealth(req) || req.path.startsWith('/webhooks'),
  message: { ok: false, message: 'Too many requests. Please try again later.' },
});

const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many login attempts. Try again later.' },
});

const recoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_RECOVERY_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many recovery attempts. Try again later.' },
});

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_CHECKOUT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many checkout requests. Please try again later.' },
});

const publicInviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PUBLIC_INVITE_MAX || 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' },
});

const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_LOOKUP_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many lookups. Please try again later.' },
});

module.exports = {
  globalLimiter,
  authLoginLimiter,
  recoveryLimiter,
  checkoutLimiter,
  publicInviteLimiter,
  lookupLimiter,
};
