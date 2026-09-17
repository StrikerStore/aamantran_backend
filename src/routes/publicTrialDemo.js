/**
 * Public API for "try it with your names".
 *
 * No account, no payment, no contact details: the visitor sends the names,
 * date, venue and ceremonies they want to see, and gets back a link that works
 * for a few minutes. Deliberately the only public endpoint that writes personal
 * data without a login, so it is rate-limited twice (requests per hour by the
 * limiter, demos per hour and per day inside the service) and validates every
 * field rather than trimming it into shape.
 */
const express = require('express');
const { trialDemoLimiter } = require('../middleware/rateLimits');
const { storefrontFromRequest } = require('../utils/storefront');
const {
  TrialDemoError,
  TRIAL_CEREMONIES,
  LINK_MINUTES,
  createTrialDemo,
  validateTrialPayload,
} = require('../services/trialDemo.service');

const router = express.Router();

/** The caller's address, honouring the proxy Express is configured to trust. */
function callerIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

// GET /api/trial-demo/options — what the form may offer.
// Lets the storefront render the ceremony choices without hard-coding a list
// that must then be kept in step with the validator.
router.get('/options', (_req, res) => {
  res.json({ ceremonies: TRIAL_CEREMONIES, expiresInMinutes: LINK_MINUTES });
});

// POST /api/trial-demo — create a personal demo of one design.
router.post('/', trialDemoLimiter, async (req, res) => {
  try {
    const payload = validateTrialPayload(req.body);
    const demo = await createTrialDemo({
      slug: req.body?.slug,
      payload,
      ip: callerIp(req),
      storefront: storefrontFromRequest(req),
    });
    return res.status(201).json(demo);
  } catch (error) {
    if (error instanceof TrialDemoError) {
      // A cap is "too many requests"; everything else is the payload's fault.
      const status = error.field === 'cap' ? 429 : 400;
      return res.status(status).json({ message: error.message, field: error.field });
    }
    console.error('[trial-demo] create failed:', error.message);
    return res.status(500).json({ message: 'Could not create the demo. Please try again.' });
  }
});

module.exports = router;
