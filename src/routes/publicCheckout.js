const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const prisma  = require('../utils/prisma');
const { generateOrderId } = require('../utils/generateId');
const { EXCLUDE_SANDBOX_TEMPLATE } = require('../utils/testFilters');
const { getCouponDiscount, listDisplayedCoupons } = require('../services/coupon.service');
const { checkoutLimiter, lookupLimiter } = require('../middleware/rateLimits');
const {
  buildPaymentParams,
  verifyResponseHash,
  payuPaymentUrl,
} = require('../services/payu.service');
const razorpay = require('../services/razorpay.service');
const { gatewayFor, PAYU, RAZORPAY } = require('../services/paymentGateway.service');
// Every route that finishes a purchase goes through this one helper, so the
// four ways a payment can complete cannot drift apart again.
const { markPaymentPaid, markPaymentFailed } = require('../services/payment.service');
const {
  sendPurchaseConfirmationEmail,
  sendOnboardingCompleteEmail,
} = require('../services/email.service');
const siteUrls = require('../config/siteUrls');
const { validateNewPassword } = require('../utils/authSecurity');
const { POLICY_VERSION } = require('../lib/constants');
const { trialIdForOrder, applyTrialPrefill } = require('../services/trialDemo.service');
const {
  storefrontFromRequest,
  resolveStorefrontForOrder,
  currencyFor,
  landingUrlFor,
} = require('../utils/storefront');
const { countryFromRequest } = require('../utils/geo');
const { getPricingSettings, computeBreakup } = require('../services/pricing.service');
const { normalizePhone, normalizePhoneForGateway } = require('../utils/phone');

const router = express.Router();
router.use(checkoutLimiter);
const DUMMY_PAYMENT_MODE = String(process.env.DUMMY_PAYMENT_MODE || '').toLowerCase() === 'true';

/** Lowercase login handle for couple dashboard */
function normalizeUsername(raw) {
  return String(raw || '').trim().toLowerCase();
}

/** 3–32 chars: [a-z0-9] then [a-z0-9._-] */
function isValidUsername(u) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u);
}

function slugifyBase(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function ensureUniqueEventSlug(wanted) {
  const base = slugifyBase(wanted) || 'event';
  let slug = base;
  let i = 1;
  while (await prisma.event.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

function inferEventTypeFromTemplate(template) {
  const first = String(template?.bestFor || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .find(Boolean);
  return first || 'wedding';
}


// GET /api/checkout/coupons?templateSlug=...&customerEmail=...
//
// Every coupon an admin has marked `isDisplayed`, judged against this order by
// the same rules /coupon-preview applies. Each carries `eligible` and, when it
// does not apply, an `unlockMessage` -- so anything marked eligible will succeed
// when applied, and the rest can be shown locked instead of hidden.
//
// customerEmail is optional: the page renders before it is typed. Passing it
// locks coupons that customer has already used up.
router.get('/coupons', async (req, res) => {
  try {
    const { templateSlug, customerEmail } = req.query || {};
    if (!templateSlug) return res.status(400).json({ message: 'templateSlug is required' });

    const template = await prisma.template.findUnique({
      where:  { slug: String(templateSlug), isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
      select: { id: true, slug: true, price: true, gstPercent: true, markupMultiplier: true },
    });
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const storefront = storefrontFromRequest(req);
    const settings   = await getPricingSettings();
    // Offers are sized against the price this visitor actually sees, so a
    // percentage-off figure on the dollar site is a dollar figure.
    const breakup = computeBreakup({ template, storefront, coupon: null, settings });

    const coupons = await listDisplayedCoupons({
      baseAmount:    breakup.baseAmount,
      customerEmail: customerEmail || null,
      storefront,
      currency:      breakup.currency,
    });

    // An empty list is an ordinary outcome, not an error -- most orders will
    // have no running campaign.
    return res.json({ coupons });
  } catch {
    // Never break checkout over the offers strip; the code input still works.
    return res.json({ coupons: [] });
  }
});

// POST /api/checkout/coupon-preview
router.post('/coupon-preview', async (req, res) => {
  try {
    const { templateSlug, couponCode, customerEmail } = req.body || {};
    if (!templateSlug) return res.status(400).json({ message: 'templateSlug is required' });

    const template = await prisma.template.findUnique({
      where: { slug: templateSlug, isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
      select: { id: true, slug: true, price: true, gstPercent: true, markupMultiplier: true },
    });
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const storefront = storefrontFromRequest(req);
    const settings   = await getPricingSettings();

    // The coupon is evaluated against the price for THIS storefront, so a
    // percentage comes off dollars on the global site and rupees on the India
    // one. Passing the storefront also refuses codes scoped to the other site.
    const base   = computeBreakup({ template, storefront, coupon: null, settings });
    const coupon = await getCouponDiscount(base.baseAmount, couponCode, customerEmail, storefront);
    const breakup = computeBreakup({ template, storefront, coupon, settings });

    return res.json({
      valid: coupon.discountPct > 0,
      code: coupon.code,
      reason: coupon.reason || null,
      priceBreakup: {
        baseAmount:     breakup.baseAmount,
        discountAmount: breakup.discountAmount,
        discountPct:    breakup.discountPct,
        gstPercent:     breakup.gstPercent,
        gstAmount:      breakup.gstAmount,
        finalAmount:    breakup.finalAmount,
        currency:       breakup.currency,
      },
    });
  } catch {
    return res.status(500).json({ message: 'Failed to preview coupon' });
  }
});

// POST /api/checkout/order — creates pending payment, returns PayU form params
router.post('/order', async (req, res) => {
  try {
    const { templateSlug, couponCode, customerEmail, customerContact, customerContactCountryCode, consent, marketingOptIn, trialToken } = req.body || {};
    if (!templateSlug) return res.status(400).json({ message: 'templateSlug is required' });
    // DPDP: specific, informed consent must be recorded before personal data is processed
    if (consent !== true) {
      return res.status(400).json({ message: 'Please accept the Terms of Service and Privacy Policy to continue' });
    }

    const template = await prisma.template.findUnique({
      where: { slug: templateSlug, isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
      select: { id: true, slug: true, name: true, price: true, gstPercent: true, markupMultiplier: true },
    });
    if (!template) return res.status(404).json({ message: 'Template not found' });

    // Checked against Origin, not merely taken from the body: this is the one
    // request where the answer decides what someone is charged and whether GST
    // is collected, so a browser on the India site cannot ask for international
    // treatment.
    const storefront = resolveStorefrontForOrder(req);

    // Which gateway takes this order: PayU or Razorpay, per storefront, as the
    // admin has it set. Resolved on every order and re-checked against the
    // credentials actually present, so a setting saved before a key was removed
    // is refused here rather than failing at the gateway -- and is never
    // silently rerouted to the other gateway, which would settle the money into
    // an account nobody chose.
    const chosen = await gatewayFor(storefront);

    // Refuse before writing anything.
    //
    // The gateway asserts the same thing further down, but by then the Payment
    // row exists -- so an unconfigured storefront used to leave a stranded
    // `pending` order behind on every attempt, and the customer got the generic
    // "Failed to create checkout order". Nothing should reach the database until
    // the request is known to be fulfillable.
    //
    // Skipped in DUMMY_PAYMENT_MODE, which returns before any gateway is called.
    if (!DUMMY_PAYMENT_MODE && !chosen.configured) {
      console.error(`[checkout] ${chosen.gateway} is not configured for storefront ${storefront} (needs ${chosen.missing}); refusing order`);
      return res.status(503).json({
        message: 'Payments are temporarily unavailable for your region. Please contact support.',
      });
    }

    const settings   = await getPricingSettings();

    const base    = computeBreakup({ template, storefront, coupon: null, settings });
    const coupon  = await getCouponDiscount(base.baseAmount, couponCode, customerEmail, storefront);
    const breakup = computeBreakup({ template, storefront, coupon, settings });

    const { discountPct, discountAmount, gstPercent, gstAmount, finalAmount } = breakup;

    const txnid   = uuidv4().replace(/-/g, '').slice(0, 25);
    const orderId = generateOrderId();
    // A "try it with your names" demo of this design, if the buyer came from one.
    // Ignored, never refused, when it is for another design or has expired.
    const trialDemoId = await trialIdForOrder(trialToken, template.id).catch(() => null);

    // Razorpay's order is created BEFORE our row, deliberately: the browser
    // cannot open the payment sheet without it, so a gateway outage should leave
    // no `pending` row behind at all. The reverse order would.
    let razorpayOrder = null;
    if (!DUMMY_PAYMENT_MODE && chosen.gateway === RAZORPAY) {
      try {
        razorpayOrder = await razorpay.createOrder({
          amountMinor: finalAmount,
          currency:    breakup.currency,
          // Our own order id, so a Razorpay dashboard row is traceable to a Payment.
          receipt:     orderId,
          notes:       { templateSlug: template.slug, storefront },
        });
      } catch (err) {
        console.error('[checkout] Razorpay order creation failed:', err?.error?.description || err.message);
        return res.status(502).json({ message: 'Payments are temporarily unavailable. Please try again in a moment.' });
      }
    }

    const payment = await prisma.payment.create({
      data: {
        templateId:    template.id,
        orderId,
        // PayU is looked up by its own txnid on every callback and IPN; Razorpay
        // by its order id. The generic column mirrors whichever applies.
        ...(razorpayOrder
          ? { gatewayOrderId: razorpayOrder.id }
          : { payuTxnId: txnid, gatewayOrderId: txnid }),
        gateway:       chosen.gateway,
        customerEmail: customerEmail ? String(customerEmail).trim().toLowerCase() : null,
        couponCode:    coupon.discountPct > 0 ? coupon.code : null,
        discountAmount,
        // Minor units of `currency`: paise for INR, cents for USD.
        amount:        finalAmount,
        currency:      breakup.currency,
        storefront,
        // Evidence of where the sale happened, which is what zero-rating GST on
        // an export rests on. Trustworthy here because the checkout page calls
        // this endpoint from the buyer's own browser.
        countryCode:   countryFromRequest(req),
        // Frozen so this order stays explainable after the global rate moves.
        fxRate:           breakup.fxRate,
        markupMultiplier: breakup.markupMultiplier,
        gstAmount,
        status:        'pending',
        consentAt:     new Date(),
        policyVersion: POLICY_VERSION,
        marketingOptIn: marketingOptIn === true,
        ...(trialDemoId ? { trialDemoId } : {}),
      },
      select: { id: true, orderId: true },
    });

    if (DUMMY_PAYMENT_MODE) {
      return res.json({
        paymentId: payment.id,
        orderId:   payment.orderId,
        amount:    finalAmount,
        dummy:     true,
        priceBreakup: { baseAmount: breakup.baseAmount, discountAmount, gstPercent, gstAmount, finalAmount, discountPct, currency: breakup.currency },
      });
    }

    const apiBase   = siteUrls.apiBaseUrl();
    const firstname = String(customerEmail || '').split('@')[0].replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30) || 'Customer';

    // Razorpay: everything the browser needs to open Checkout.js, and nothing
    // more. keyId is the publishable key; RAZORPAY_KEY_SECRET never leaves this
    // process. The payment is not trusted until /razorpay-verify checks the
    // signature server-side.
    if (razorpayOrder) {
      return res.json({
        razorpay: {
          keyId:       razorpay.keyId(),
          orderId:     razorpayOrder.id,
          amount:      razorpayOrder.amount,
          currency:    razorpayOrder.currency,
          name:        'Aamantran',
          description: template.name,
          prefill: {
            name:    firstname,
            email:   customerEmail ? String(customerEmail).trim().toLowerCase() : '',
            contact: normalizePhoneForGateway(customerContactCountryCode, customerContact),
          },
        },
        paymentId:  payment.id,
        orderId:    payment.orderId,
        amount:     finalAmount,
        priceBreakup: { baseAmount: breakup.baseAmount, discountAmount, gstPercent, gstAmount, finalAmount, discountPct, currency: breakup.currency },
      });
    }

    const payuParams = buildPaymentParams({
      txnid,
      amountMinor:  finalAmount,
      productinfo:  `Aamantran - ${template.name}`,
      firstname,
      email:        customerEmail ? String(customerEmail).trim().toLowerCase() : '',
      // Digits only, but NOT truncated: the old .slice(0, 10) assumed an Indian
      // number and silently mangled every international one (+1 415 555 0123
      // reached PayU as 1415555012).
      phone:        normalizePhoneForGateway(customerContactCountryCode, customerContact),
      successUrl:   `${apiBase}/api/checkout/payu-success`,
      failureUrl:   `${apiBase}/api/checkout/payu-failure`,
      storefront,
    });

    return res.json({
      payuUrl:    payuPaymentUrl(),
      payuParams,
      paymentId:  payment.id,
      orderId:    payment.orderId,
      amount:     finalAmount,
      priceBreakup: { baseAmount: breakup.baseAmount, discountAmount, gstPercent, gstAmount, finalAmount, discountPct, currency: breakup.currency },
    });
  } catch {
    return res.status(500).json({ message: 'Failed to create checkout order' });
  }
});

// POST /api/checkout/razorpay-verify
//
// Razorpay's Checkout.js is a modal, not a redirect: when it closes it hands the
// PAGE three fields and the page sends them here. They arrive from the buyer's
// own browser and are worth nothing on their own -- this signature check, with
// the secret that never leaves the server, is the entire security of the flow.
// A mismatch leaves the order exactly as it was: unpaid.
//
// This is not the only path to `paid`. Razorpay's webhook does the same job for
// a buyer who closes the tab before the page can call this, and whichever
// arrives first wins (see markPaymentPaid).
router.post('/razorpay-verify', async (req, res) => {
  const body = req.body || {};
  const orderRef   = String(body.razorpay_order_id   || '');
  const paymentRef = String(body.razorpay_payment_id || '');
  const signature  = String(body.razorpay_signature  || '');

  if (!orderRef || !paymentRef || !signature) {
    return res.status(400).json({ message: 'Incomplete payment confirmation' });
  }

  if (!razorpay.verifyCheckoutSignature({ orderId: orderRef, paymentId: paymentRef, signature })) {
    console.error('[checkout] Razorpay signature mismatch for order', orderRef.slice(0, 40));
    return res.status(400).json({
      message: 'We could not verify this payment. If your account has been charged, contact support with your order id.',
    });
  }

  try {
    const payment = await prisma.payment.findFirst({
      where:   { gatewayOrderId: orderRef, gateway: RAZORPAY },
      include: { template: { select: { name: true, slug: true } } },
    });
    if (!payment) return res.status(404).json({ message: 'Order not found' });

    const updated = payment.status === 'paid' ? payment : await markPaymentPaid(payment, paymentRef);

    return res.json({
      ok:           true,
      paymentId:    updated.id,
      orderId:      updated.orderId,
      templateSlug: updated.template.slug,
      templateName: updated.template.name,
      amount:       updated.amount,
      currency:     updated.currency,
    });
  } catch (err) {
    console.error('[checkout] razorpay-verify failed:', err.message);
    // The signature was good, so the money is real even though this failed. The
    // webhook is the backstop, and the buyer is told to wait rather than to pay
    // again.
    return res.status(500).json({
      message: 'Your payment went through but we could not finish setting up your order. Give it a minute, then check your email — or contact support with your order id.',
    });
  }
});

// POST /api/checkout/payu-success — PayU redirects here on successful payment
// ─── Payment recovery ───────────────────────────────────────────────────────
//
// A buyer whose payment failed used to land on the homepage, with the template
// they had chosen and the form they had filled in both gone. A definite failure
// now returns them to that template's checkout, on their own storefront, so a
// retry is one step instead of a fresh search.
//
// Only a verified, definite failure goes to a retry. A PENDING result is still
// being settled by the bank and may yet succeed; inviting a second attempt
// there risks charging the buyer twice, so pending keeps its old destination.

/**
 * Short, URL-safe failure code from a PayU response. Prefers PayU's detailed
 * `unmappedstatus` (e.g. userCancelled, bounced) over the coarse `status`.
 * Free-text gateway messages are deliberately never copied into the URL.
 */
function failureReasonFrom(params) {
  const raw = String(params?.unmappedstatus || params?.status || 'unknown');
  const clean = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return clean || 'unknown';
}

/** True when PayU says the outcome is not final yet. */
function isPendingResult(params) {
  return String(params?.status || '').toLowerCase() === 'pending';
}

/** The template's own checkout with a failure notice, or null if the template is unknown. */
function retryCheckoutUrl(landing, templateSlug, reason) {
  if (!templateSlug) return null;
  return `${landing}/checkout/${encodeURIComponent(templateSlug)}?payment=failed&reason=${encodeURIComponent(reason)}`;
}

router.post('/payu-success', async (req, res) => {
  const params = req.body || {};

  const { txnid, mihpayid, status } = params;

  // The order is loaded BEFORE the signature is checked, because with two
  // merchant accounts the signature cannot be checked without first knowing
  // which salt signed it. udf1 also carries the storefront, but udf1 is only
  // trustworthy once the hash verifies -- so the stored row, the one input PayU
  // did not supply, is what decides. Every redirect from here on goes to that
  // storefront's own site: a buyer who paid on the global site must not land on
  // the India one.
  let payment = null;
  try {
    if (txnid) {
      payment = await prisma.payment.findFirst({
        where: { payuTxnId: String(txnid) },
        include: { template: { select: { name: true, slug: true } } },
      });
    }
  } catch (err) {
    console.error('[PayU] payu-success lookup failed:', err.message);
  }

  const storefront = (payment && payment.storefront) || 'IN';
  const landing    = landingUrlFor(storefront);

  try {
    if (!verifyResponseHash(params, storefront)) {
      return res.redirect(`${landing}/?payment=failed&reason=invalid_signature`);
    }

    if (status !== 'success') {
      // The hash has verified, so this outcome is genuine. Pending may still
      // settle, so it never gets a retry link (see "Payment recovery" above).
      const reason = failureReasonFrom(params);
      const retry  = isPendingResult(params) ? null : retryCheckoutUrl(landing, payment?.template?.slug, reason);
      return res.redirect(retry || `${landing}/?payment=failed&reason=${encodeURIComponent(status || 'unknown')}`);
    }

    if (!payment) {
      return res.redirect(`${landing}/?payment=failed&reason=not_found`);
    }

    if (payment.status !== 'paid') {
      await markPaymentPaid(payment, mihpayid);
    }

    const onboardingUrl = `${landing}/onboarding?paymentId=${encodeURIComponent(payment.id)}&slug=${encodeURIComponent(payment.template.slug)}&template=${encodeURIComponent(payment.template.name)}${payment.orderId ? `&orderId=${encodeURIComponent(payment.orderId)}` : ''}&amount=${payment.amount}&currency=${encodeURIComponent(payment.currency || 'INR')}`;
    return res.redirect(onboardingUrl);
  } catch (err) {
    console.error('[PayU] payu-success error:', err.message);
    return res.redirect(`${landing}/?payment=failed&reason=server_error`);
  }
});

// POST /api/checkout/payu-failure — PayU redirects here on failed payment
router.post('/payu-failure', async (req, res) => {
  const params   = req.body || {};
  const { txnid } = params;

  let storefront = 'IN';
  let templateSlug = null;
  try {
    if (txnid) {
      const failed = await prisma.payment.findFirst({
        where:  { payuTxnId: String(txnid) },
        select: { storefront: true, template: { select: { slug: true } } },
      });
      if (failed && failed.storefront) storefront = failed.storefront;
      if (failed && failed.template) templateSlug = failed.template.slug;

      await markPaymentFailed({ payuTxnId: String(txnid) });
    }
  } catch {
    // best-effort
  }

  // Back to the site they were buying from, not whichever one is primary --
  // and, for a definite failure, straight back to the template they chose.
  const landing = landingUrlFor(storefront);
  const retry = isPendingResult(params) ? null : retryCheckoutUrl(landing, templateSlug, failureReasonFrom(params));
  return res.redirect(retry || `${landing}/?payment=failed`);
});

// GET /api/checkout/payment-status/:paymentId
//
// Lets the onboarding page tell "still confirming" from "failed" from "already
// registered" instead of assuming every arrival is a finished purchase. The
// paymentId is the unguessable UUID already carried in the onboarding link.
// Deliberately returns no personal data: no email, name, amount or order id.
router.get('/payment-status/:paymentId', lookupLimiter, async (req, res) => {
  const { paymentId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(String(paymentId || ''))) {
    return res.status(400).json({ message: 'Invalid payment id' });
  }
  try {
    const payment = await prisma.payment.findUnique({
      where:  { id: paymentId },
      select: { status: true, userId: true, template: { select: { slug: true } } },
    });
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    return res.json({
      status:       payment.status,
      registered:   Boolean(payment.userId),
      templateSlug: payment.template?.slug || null,
    });
  } catch (err) {
    console.error('[checkout] payment-status failed:', err.message);
    return res.status(500).json({ message: 'Could not read payment status' });
  }
});

// ─── Swap payment auto-submit page ───────────────────────────────────────────

// GET /api/checkout/payu-swap-link/:txnid — auto-submitting HTML form for swap balance payment
router.get('/payu-swap-link/:txnid', async (req, res) => {
  const { txnid } = req.params;

  try {
    const swap = await prisma.templateSwapRequest.findFirst({
      where:   { payuLinkId: txnid, status: 'pending' },
      include: { user: { select: { username: true, email: true, phone: true, phoneCountryCode: true } } },
    });

    if (!swap) {
      return res.status(404).send('<h2>Payment link not found or already used.</h2>');
    }

    const apiBase  = siteUrls.apiBaseUrl();
    const email    = swap.user?.email || '';
    const phone    = swap.user?.phone || '';
    const firstname = String(email).split('@')[0].replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30) || 'Customer';

    // Swaps top up an existing India-priced purchase, so they settle on the
    // India account -- storefront defaults to 'IN'.
    const params = buildPaymentParams({
      txnid,
      amountMinor:  swap.balanceAmount,
      productinfo:  'Aamantran - Template Upgrade',
      firstname,
      email,
      // Not truncated: the couple may well hold a foreign number even though
      // the invite itself was bought in rupees.
      phone:        normalizePhoneForGateway(swap.user?.phoneCountryCode, phone),
      successUrl:   `${apiBase}/api/checkout/payu-swap-success`,
      failureUrl:   `${apiBase}/api/checkout/payu-swap-failure`,
    });

    const fields = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}" />`)
      .join('\n      ');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Redirecting to payment…</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9f5f1;}</style>
</head>
<body>
<p>Redirecting to secure payment page…</p>
<form id="payuForm" method="POST" action="${payuPaymentUrl()}">
      ${fields}
</form>
<script>document.getElementById('payuForm').submit();</script>
</body>
</html>`;

    return res.send(html);
  } catch (err) {
    console.error('[PayU] payu-swap-link error:', err.message);
    return res.status(500).send('<h2>Could not load payment page. Please try again later.</h2>');
  }
});

// POST /api/checkout/payu-swap-success — PayU redirects here after swap payment success
router.post('/payu-swap-success', async (req, res) => {
  const params = req.body || {};

  try {
    // Signed by the India account above, so verified against it here.
    if (!verifyResponseHash(params, 'IN')) {
      return res.redirect(`${siteUrls.coupleDashboardUrl()}/?payment=failed&reason=invalid_signature`);
    }

    const { txnid, mihpayid, status } = params;

    if (status !== 'success') {
      return res.redirect(`${siteUrls.coupleDashboardUrl()}/?payment=failed&reason=${encodeURIComponent(status || 'unknown')}`);
    }

    const swap = await prisma.templateSwapRequest.findFirst({
      where: { payuLinkId: txnid, status: 'pending' },
    });

    if (!swap) {
      // Already processed — redirect to dashboard
      return res.redirect(`${siteUrls.coupleDashboardUrl()}/?payment=already_processed`);
    }

    // Apply the template swap to the event(s) — pin the version so the invite
    // renders against a frozen snapshot even if the new template gets re-published.
    const toTemplate = await prisma.template.findUnique({
      where:  { id: swap.toTemplateId },
      select: { currentVersionId: true },
    });
    const swapData = {
      templateId:        swap.toTemplateId,
      templateVersionId: toTemplate?.currentVersionId || null,
    };
    await prisma.event.update({ where: { id: swap.eventId }, data: swapData });
    if (swap.pairedEventId) {
      await prisma.event.update({ where: { id: swap.pairedEventId }, data: swapData });
    }

    await prisma.templateSwapRequest.update({
      where: { id: swap.id },
      data:  { status: 'paid' },
    });

    // Create a payment record for the swap
    if (mihpayid) {
      await prisma.payment.create({
        data: {
          orderId:     generateOrderId(),
          userId:      swap.userId,
          eventId:     swap.eventId,
          templateId:  swap.toTemplateId,
          // Template upgrades stay on the India PayU account (see payu-swap-link),
          // whatever the storefront gateway setting says.
          gateway:     PAYU,
          payuTxnId:   txnid,
          payuMihpayid: mihpayid,
          gatewayOrderId:   txnid,
          gatewayPaymentId: mihpayid,
          amount:      swap.balanceAmount,
          status:      'paid',
        },
      });
    }

    await prisma.template.update({
      where: { id: swap.toTemplateId },
      data:  { buyerCount: { increment: 1 } },
    });

    return res.redirect(`${siteUrls.coupleDashboardUrl()}/?payment=success`);
  } catch (err) {
    console.error('[PayU] payu-swap-success error:', err.message);
    return res.redirect(`${siteUrls.coupleDashboardUrl()}/?payment=failed&reason=server_error`);
  }
});

// POST /api/checkout/payu-swap-failure
router.post('/payu-swap-failure', async (req, res) => {
  return res.redirect(`${siteUrls.coupleDashboardUrl()}/?payment=failed`);
});

// POST /api/checkout/mock-success
// For staging/dev flow testing without real gateway payment.
router.post('/mock-success', async (req, res) => {
  if (!DUMMY_PAYMENT_MODE || process.env.NODE_ENV === 'production') {
    return res.status(403).json({ message: 'Mock payment is disabled' });
  }
  try {
    const { paymentId } = req.body || {};
    if (!paymentId) return res.status(400).json({ message: 'paymentId is required' });

    const existing = await prisma.payment.findUnique({
      where:  { id: paymentId },
      select: { gateway: true },
    });
    // A test order records the gateway that would really have taken it, so the
    // mock ids go in the columns that gateway uses.
    const mockIsPayu = String(existing?.gateway || PAYU) === PAYU;
    const mockOrderRef   = `mock_txn_${Date.now()}`;
    const mockPaymentRef = `mock_pay_${Date.now()}`;

    const payment = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status:           'paid',
        gatewayOrderId:   mockOrderRef,
        gatewayPaymentId: mockPaymentRef,
        ...(mockIsPayu ? { payuTxnId: mockOrderRef, payuMihpayid: mockPaymentRef } : {}),
      },
      include: { template: { select: { name: true, slug: true } } },
    });

    await prisma.template.update({
      where: { id: payment.templateId },
      data:  { buyerCount: { increment: 1 } },
    });

    if (payment.customerEmail) {
      // Same storefront-aware link as the real PayU path above.
      const landing = landingUrlFor(payment.storefront);
      const onboardingUrl = `${landing}/onboarding?paymentId=${encodeURIComponent(payment.id)}&slug=${encodeURIComponent(payment.template.slug)}&template=${encodeURIComponent(payment.template.name)}${payment.orderId ? `&orderId=${encodeURIComponent(payment.orderId)}` : ''}&amount=${payment.amount}&currency=${encodeURIComponent(payment.currency || 'INR')}`;
      sendPurchaseConfirmationEmail({
        to: payment.customerEmail,
        templateName: payment.template.name,
        amount: payment.amount,
        currency: payment.currency,
        orderId: payment.orderId || null,
        onboardingUrl,
      }).catch(err => console.error('[Email Error]', err.message));
    }

    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ message: 'Mock payment failed' });
  }
});

// GET /api/checkout/lookup-email?email= — public
router.get('/lookup-email', lookupLimiter, async (req, res) => {
  try {
    const emailLower = String(req.query.email || '').trim().toLowerCase();
    if (!emailLower) return res.json({ ok: true, exists: false });

    const user = await prisma.user.findFirst({
      where:   { email: emailLower },
      select:  { username: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!user) return res.json({ ok: true, exists: false });
    return res.json({ ok: true, exists: true, username: user.username });
  } catch {
    return res.status(500).json({ message: 'Could not look up email' });
  }
});

// GET /api/checkout/check-username?username= — public
router.get('/check-username', lookupLimiter, async (req, res) => {
  try {
    const usernameNorm = normalizeUsername(req.query.username);
    if (!usernameNorm) {
      return res.json({ ok: true, available: false, reason: 'empty' });
    }
    if (!isValidUsername(usernameNorm)) {
      return res.json({ ok: true, available: false, reason: 'invalid' });
    }
    const taken = await prisma.user.findFirst({ where: { username: usernameNorm } });
    return res.json({ ok: true, available: !taken, normalized: usernameNorm });
  } catch {
    return res.status(500).json({ message: 'Could not check username' });
  }
});

// POST /api/checkout/register
router.post('/register', async (req, res) => {
  try {
    const { paymentId, templateSlug, username, email, contact, contactCountryCode, password } = req.body || {};
    if (!paymentId || !templateSlug || !username || !email || !contact) {
      return res.status(400).json({ message: 'paymentId, templateSlug, username, email, and contact are required' });
    }

    // Validated here rather than trusted from the form, because this number is
    // effectively permanent: updateProfile refuses to change a phone once set
    // and sends the couple to a support ticket instead.
    const parsedPhone = normalizePhone(contactCountryCode, contact);
    if (!parsedPhone.valid) {
      return res.status(400).json({ message: parsedPhone.reason });
    }

    const emailLower   = String(email).toLowerCase().trim();
    const usernameNorm = normalizeUsername(username);

    if (!isValidUsername(usernameNorm)) {
      return res.status(400).json({
        message: 'Username must be 3–32 characters: start with a letter or number; only letters, numbers, dots, underscores, hyphens',
      });
    }
    // Existing accounts link a purchase without a password; only validate when one is supplied.
    if (password != null && password !== '') {
      const passwordError = validateNewPassword(password);
      if (passwordError) {
        return res.status(400).json({ message: passwordError });
      }
    }

    const payment = await prisma.payment.findUnique({
      where:   { id: paymentId },
      include: { template: true },
    });
    if (!payment || payment.status !== 'paid') {
      return res.status(400).json({ message: 'Payment not completed' });
    }
    if (payment.template.slug !== templateSlug) {
      return res.status(400).json({ message: 'Payment-template mismatch' });
    }

    if (payment.userId) {
      return res.status(400).json({ message: 'This purchase has already been registered' });
    }

    const existingUser = await prisma.user.findFirst({ where: { username: usernameNorm } });

    if (existingUser) {
      // Binding a real paid purchase to the testing account would put it back
      // into every analytic the test flag exists to keep it out of.
      if (existingUser.isTestAccount) {
        return res.status(403).json({ message: 'This username cannot be used for a purchase.' });
      }
      if (existingUser.email !== emailLower) {
        return res.status(409).json({ message: 'This username belongs to a different account. Choose a different username or use your original email.' });
      }
      const eventSlug = await ensureUniqueEventSlug(`${usernameNorm}-${payment.template.slug}`);
      const eventType = inferEventTypeFromTemplate(payment.template);
      const event = await prisma.event.create({
        data: {
          slug:       eventSlug,
          ownerId:    existingUser.id,
          templateId: payment.templateId,
          templateVersionId: payment.template.currentVersionId || null,
          community:  payment.template.community || 'universal',
          eventType,
          language:   'en',
        },
        select: { id: true },
      });
      await prisma.payment.update({
        where: { id: paymentId },
        data:  { userId: existingUser.id, eventId: event.id, isOnboarded: true, onboardedAt: new Date() },
      });
      const prefilledLinked = await applyTrialPrefill(event.id, payment.trialDemoId);
      sendOnboardingCompleteEmail({
        to:           existingUser.email,
        username:     existingUser.username,
        dashboardUrl: siteUrls.coupleDashboardUrl(),
      }).catch(err => console.error('[Email Error]', err.message));
      return res.json({ ok: true, linked: true, eventCreated: true, prefilled: prefilledLinked, dashboardUrl: siteUrls.coupleDashboardUrl() });
    }

    const newAccountPasswordError = !password
      ? 'Password is required for a new account'
      : validateNewPassword(password);
    if (newAccountPasswordError) {
      return res.status(400).json({ message: newAccountPasswordError });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);
    const user = await prisma.user.create({
      data: {
        email:        emailLower,
        username:     usernameNorm,
        phone:            parsedPhone.national,
        phoneCountryCode: parsedPhone.countryCode,
        passwordHash,
        // DPDP: carry the checkout consent record onto the account
        consentAt:     payment.consentAt || new Date(),
        policyVersion: payment.policyVersion || POLICY_VERSION,
      },
      select: { id: true },
    });

    const eventSlug = await ensureUniqueEventSlug(`${usernameNorm}-${payment.template.slug}`);
    const eventType = inferEventTypeFromTemplate(payment.template);
    const event = await prisma.event.create({
      data: {
        slug:       eventSlug,
        ownerId:    user.id,
        templateId: payment.templateId,
        templateVersionId: payment.template.currentVersionId || null,
        community:  payment.template.community || 'universal',
        eventType,
        language:   'en',
      },
      select: { id: true },
    });

    await prisma.payment.update({
      where: { id: paymentId },
      data:  { userId: user.id, eventId: event.id, isOnboarded: true, onboardedAt: new Date() },
    });
    // After the purchase is bound to the account, so a failed prefill can never
    // cost the couple their registration.
    const prefilled = await applyTrialPrefill(event.id, payment.trialDemoId);
    sendOnboardingCompleteEmail({
      to:           emailLower,
      username:     usernameNorm,
      dashboardUrl: siteUrls.coupleDashboardUrl(),
    }).catch(err => console.error('[Email Error]', err.message));

    return res.json({ ok: true, linked: false, eventCreated: true, prefilled, dashboardUrl: siteUrls.coupleDashboardUrl() });
  } catch (err) {
    console.error(err);
    if (err.code === 'P2002') {
      return res.status(409).json({ message: 'This username is already taken' });
    }
    return res.status(500).json({ message: 'Registration failed' });
  }
});

module.exports = router;
