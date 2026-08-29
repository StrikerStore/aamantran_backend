const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

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

// Website analytics beacon — every visitor fires this on each page view,
// so the window is short and the cap generous per IP.
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_TRACK_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false },
});

/**
 * Template Lab ZIP uploads.
 *
 * Keyed on the developer, not the IP: a studio behind one office NAT would
 * otherwise share a single budget and throttle each other.
 *
 * The cap is deliberately loose. Re-uploading is the loop a template developer
 * repeats all day, so a limiter tight enough to interrupt honest work would be
 * worse than none at all — this exists to bound a runaway script (each upload
 * extracts an archive and rewrites asset paths), not to ration the workflow.
 * The per-developer template cap bounds total storage separately.
 */
const labUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_LAB_UPLOAD_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false,
  // req.dev is set by middleware/devAuth.js, which always runs first on these
  // routes. Falling back to the IP keeps the limiter safe if that ever changes.
  keyGenerator: (req) => (req.dev?.id ? `dev:${req.dev.id}` : ipKeyGenerator(req)),
  message: {
    ok: false,
    message: 'Too many uploads in a short window. Wait a few minutes and try again.',
  },
});

module.exports = {
  globalLimiter,
  authLoginLimiter,
  labUploadLimiter,
  recoveryLimiter,
  checkoutLimiter,
  publicInviteLimiter,
  lookupLimiter,
  trackLimiter,
};
