/**
 * Public API for "try it with your names".
 *
 * No account, no payment, no contact details: the visitor sends the names,
 * date, venue and events they want to see, and gets back a link that works
 * for a few minutes. What they may send is decided per design — see
 * trialOptionsFor — so the same form serves a wedding, a birthday or a
 * housewarming. Deliberately the only public endpoint that writes personal
 * data without a login, so it is rate-limited twice (requests per hour by the
 * limiter, demos per hour and per day inside the service) and validates every
 * field rather than trimming it into shape.
 */
const express = require('express');
const prisma = require('../utils/prisma');
const { trialDemoLimiter, publicInviteLimiter } = require('../middleware/rateLimits');
const { EXCLUDE_SANDBOX_TEMPLATE } = require('../utils/testFilters');
const { storefrontFromRequest } = require('../utils/storefront');
const {
  TrialDemoError,
  WEDDING_CEREMONIES,
  LINK_MINUTES,
  TRY_ELIGIBILITY_SELECT,
  createTrialDemo,
  trialOptionsFor,
} = require('../services/trialDemo.service');

const router = express.Router();

/** The caller's address, honouring the proxy Express is configured to trust. */
function callerIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

// GET /api/trial-demo/options?slug=… — what the form may ask for this design.
// { people: [{ role, label, required }], ceremonies: [name], dateLabel,
//   expiresInMinutes }. Comes from the same function the validator uses, so the
// form can never offer something the server then refuses.
//
// Without a slug it answers in the old shape — the wedding ceremonies — so a
// browser still running the previous form keeps working through a deploy.
router.get('/options', publicInviteLimiter, async (req, res) => {
  const slug = String(req.query.slug || '').trim();
  if (!slug) return res.json({ ceremonies: WEDDING_CEREMONIES, expiresInMinutes: LINK_MINUTES });
  try {
    const template = await prisma.template.findFirst({
      where: { slug, isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
      select: { id: true, ...TRY_ELIGIBILITY_SELECT },
    });
    const options = trialOptionsFor(template);
    if (!options) return res.status(404).json({ message: 'That design cannot be previewed yet.' });
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ ...options, expiresInMinutes: LINK_MINUTES });
  } catch (error) {
    console.error('[trial-demo] options failed:', error.message);
    return res.status(500).json({ message: 'Could not load the demo form. Please try again.' });
  }
});

// POST /api/trial-demo — create a personal demo of one design.
router.post('/', trialDemoLimiter, async (req, res) => {
  try {
    // Validated inside, against the design being asked for.
    const demo = await createTrialDemo({
      slug: req.body?.slug,
      body: req.body,
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
