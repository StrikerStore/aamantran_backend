const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const prisma  = require('../utils/prisma');
const { checkoutLimiter, lookupLimiter } = require('../middleware/rateLimits');
const {
  buildPaymentParams,
  verifyResponseHash,
  payuPaymentUrl,
} = require('../services/payu.service');
const {
  sendPurchaseConfirmationEmail,
  sendOnboardingCompleteEmail,
} = require('../services/email.service');
const siteUrls = require('../config/siteUrls');

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

async function getCouponDiscount(baseAmount, couponCodeRaw, customerEmailRaw) {
  const code = String(couponCodeRaw || '').trim().toUpperCase();
  if (!code) return { code: '', discountPct: 0, discountAmount: 0 };
  const customerEmail = String(customerEmailRaw || '').trim().toLowerCase();

  const coupon = await prisma.couponCode.findUnique({
    where: { code },
    select: {
      code: true,
      discountPercent: true,
      isActive: true,
      expiresAt: true,
      maxGlobalUses: true,
      maxUsesPerUser: true,
      minOrderAmount: true,
    },
  });
  if (!coupon || !coupon.isActive) return { code, discountPct: 0, discountAmount: 0 };
  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) {
    return { code, discountPct: 0, discountAmount: 0, reason: 'Coupon expired' };
  }
  if ((coupon.minOrderAmount || 0) > baseAmount) {
    return { code, discountPct: 0, discountAmount: 0, reason: `Minimum order is INR ${(coupon.minOrderAmount / 100).toLocaleString('en-IN')}` };
  }

  if (coupon.maxGlobalUses) {
    const totalPaidUses = await prisma.payment.count({
      where: { couponCode: code, status: 'paid' },
    });
    if (totalPaidUses >= coupon.maxGlobalUses) {
      return { code, discountPct: 0, discountAmount: 0, reason: 'Coupon usage limit reached' };
    }
  }

  if (coupon.maxUsesPerUser && customerEmail) {
    const paidUsesByUser = await prisma.payment.count({
      where: { couponCode: code, customerEmail, status: 'paid' },
    });
    if (paidUsesByUser >= coupon.maxUsesPerUser) {
      return { code, discountPct: 0, discountAmount: 0, reason: 'Per-user usage limit reached' };
    }
  }

  const discountPct = Math.max(0, Math.min(100, Number(coupon.discountPercent || 0)));
  const discountAmount = Math.round((baseAmount * discountPct) / 100);
  return { code: coupon.code, discountPct, discountAmount };
}

// ─── Helper: mark a payment as paid and fire purchase email ──────────────────

async function markPaymentPaid(payment, mihpayid) {
  const [updated] = await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'paid', payuMihpayid: mihpayid || null },
      include: { template: { select: { name: true, slug: true } } },
    }),
    prisma.template.update({
      where: { id: payment.templateId },
      data:  { buyerCount: { increment: 1 } },
    }),
  ]);

  if (updated.customerEmail) {
    const onboardingUrl = `${siteUrls.landingUrl()}/onboarding?paymentId=${encodeURIComponent(updated.id)}&slug=${encodeURIComponent(updated.template.slug)}&template=${encodeURIComponent(updated.template.name)}`;
    sendPurchaseConfirmationEmail({
      to: updated.customerEmail,
      templateName: updated.template.name,
      amount: updated.amount,
      onboardingUrl,
    }).catch(err => console.error('[Email Error]', err.message));
  }

  return updated;
}

// POST /api/checkout/coupon-preview
router.post('/coupon-preview', async (req, res) => {
  try {
    const { templateSlug, couponCode, customerEmail } = req.body || {};
    if (!templateSlug) return res.status(400).json({ message: 'templateSlug is required' });

    const template = await prisma.template.findUnique({
      where: { slug: templateSlug, isActive: true },
      select: { price: true, gstPercent: true },
    });
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const coupon = await getCouponDiscount(template.price, couponCode, customerEmail);
    const taxableAmount = Math.max(100, template.price - coupon.discountAmount);
    const gstPercent = Number(template.gstPercent || 0);
    const gstAmount = Math.round((taxableAmount * gstPercent) / 100);
    const finalAmount = taxableAmount + gstAmount;

    return res.json({
      valid: coupon.discountPct > 0,
      code: coupon.code,
      reason: coupon.reason || null,
      priceBreakup: {
        baseAmount: template.price,
        discountAmount: coupon.discountAmount,
        discountPct: coupon.discountPct,
        gstPercent,
        gstAmount,
        finalAmount,
      },
    });
  } catch {
    return res.status(500).json({ message: 'Failed to preview coupon' });
  }
});

// POST /api/checkout/order — creates pending payment, returns PayU form params
router.post('/order', async (req, res) => {
  try {
    const { templateSlug, couponCode, customerEmail, customerContact } = req.body || {};
    if (!templateSlug) return res.status(400).json({ message: 'templateSlug is required' });

    const template = await prisma.template.findUnique({
      where: { slug: templateSlug, isActive: true },
      select: { id: true, slug: true, name: true, price: true, gstPercent: true },
    });
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const coupon = await getCouponDiscount(template.price, couponCode, customerEmail);
    const discountPct    = coupon.discountPct;
    const discountAmount = coupon.discountAmount;
    const taxableAmount  = Math.max(100, template.price - discountAmount);
    const gstPercent     = Number(template.gstPercent || 0);
    const gstAmount      = Math.round((taxableAmount * gstPercent) / 100);
    const finalAmount    = taxableAmount + gstAmount;

    const txnid = uuidv4().replace(/-/g, '').slice(0, 25);

    const payment = await prisma.payment.create({
      data: {
        templateId:    template.id,
        payuTxnId:     txnid,
        customerEmail: customerEmail ? String(customerEmail).trim().toLowerCase() : null,
        couponCode:    coupon.discountPct > 0 ? coupon.code : null,
        discountAmount,
        amount:        finalAmount,
        currency:      'INR',
        status:        'pending',
      },
      select: { id: true },
    });

    if (DUMMY_PAYMENT_MODE) {
      return res.json({
        paymentId: payment.id,
        amount:    finalAmount,
        dummy:     true,
        priceBreakup: { baseAmount: template.price, discountAmount, gstPercent, gstAmount, finalAmount, discountPct },
      });
    }

    const apiBase   = siteUrls.apiBaseUrl();
    const firstname = String(customerEmail || '').split('@')[0].replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30) || 'Customer';
    const payuParams = buildPaymentParams({
      txnid,
      amountPaise:  finalAmount,
      productinfo:  `Aamantran - ${template.name}`,
      firstname,
      email:        customerEmail ? String(customerEmail).trim().toLowerCase() : '',
      phone:        customerContact ? String(customerContact).replace(/\D/g, '').slice(0, 10) : '',
      successUrl:   `${apiBase}/api/checkout/payu-success`,
      failureUrl:   `${apiBase}/api/checkout/payu-failure`,
    });

    return res.json({
      payuUrl:    payuPaymentUrl(),
      payuParams,
      paymentId:  payment.id,
      amount:     finalAmount,
      priceBreakup: { baseAmount: template.price, discountAmount, gstPercent, gstAmount, finalAmount, discountPct },
    });
  } catch {
    return res.status(500).json({ message: 'Failed to create checkout order' });
  }
});

// POST /api/checkout/payu-success — PayU redirects here on successful payment
router.post('/payu-success', async (req, res) => {
  const params = req.body || {};

  try {
    if (!verifyResponseHash(params)) {
      return res.redirect(`${siteUrls.landingUrl()}/?payment=failed&reason=invalid_signature`);
    }

    const { txnid, mihpayid, status } = params;

    if (status !== 'success') {
      return res.redirect(`${siteUrls.landingUrl()}/?payment=failed&reason=${encodeURIComponent(status || 'unknown')}`);
    }

    const payment = await prisma.payment.findFirst({
      where: { payuTxnId: txnid },
      include: { template: { select: { name: true, slug: true } } },
    });

    if (!payment) {
      return res.redirect(`${siteUrls.landingUrl()}/?payment=failed&reason=not_found`);
    }

    if (payment.status !== 'paid') {
      await markPaymentPaid(payment, mihpayid);
    }

    const onboardingUrl = `${siteUrls.landingUrl()}/onboarding?paymentId=${encodeURIComponent(payment.id)}&slug=${encodeURIComponent(payment.template.slug)}&template=${encodeURIComponent(payment.template.name)}`;
    return res.redirect(onboardingUrl);
  } catch (err) {
    console.error('[PayU] payu-success error:', err.message);
    return res.redirect(`${siteUrls.landingUrl()}/?payment=failed&reason=server_error`);
  }
});

// POST /api/checkout/payu-failure — PayU redirects here on failed payment
router.post('/payu-failure', async (req, res) => {
  const params   = req.body || {};
  const { txnid } = params;

  try {
    if (txnid) {
      await prisma.payment.updateMany({
        where: { payuTxnId: txnid, status: 'pending' },
        data:  { status: 'failed' },
      });
    }
  } catch {
    // best-effort
  }

  return res.redirect(`${siteUrls.landingUrl()}/?payment=failed`);
});

// ─── Swap payment auto-submit page ───────────────────────────────────────────

// GET /api/checkout/payu-swap-link/:txnid — auto-submitting HTML form for swap balance payment
router.get('/payu-swap-link/:txnid', async (req, res) => {
  const { txnid } = req.params;

  try {
    const swap = await prisma.templateSwapRequest.findFirst({
      where:   { payuLinkId: txnid, status: 'pending' },
      include: { user: { select: { username: true, email: true, phone: true } } },
    });

    if (!swap) {
      return res.status(404).send('<h2>Payment link not found or already used.</h2>');
    }

    const apiBase  = siteUrls.apiBaseUrl();
    const email    = swap.user?.email || '';
    const phone    = swap.user?.phone || '';
    const firstname = String(email).split('@')[0].replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30) || 'Customer';

    const params = buildPaymentParams({
      txnid,
      amountPaise:  swap.balanceAmount,
      productinfo:  'Aamantran - Template Upgrade',
      firstname,
      email,
      phone:        phone.replace(/\D/g, '').slice(0, 10),
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
    if (!verifyResponseHash(params)) {
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
          userId:      swap.userId,
          eventId:     swap.eventId,
          templateId:  swap.toTemplateId,
          payuTxnId:   txnid,
          payuMihpayid: mihpayid,
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

    const payment = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status:      'paid',
        payuTxnId:   `mock_txn_${Date.now()}`,
        payuMihpayid: `mock_mihpay_${Date.now()}`,
      },
      include: { template: { select: { name: true, slug: true } } },
    });

    await prisma.template.update({
      where: { id: payment.templateId },
      data:  { buyerCount: { increment: 1 } },
    });

    if (payment.customerEmail) {
      const onboardingUrl = `${siteUrls.landingUrl()}/onboarding?paymentId=${encodeURIComponent(payment.id)}&slug=${encodeURIComponent(payment.template.slug)}&template=${encodeURIComponent(payment.template.name)}`;
      sendPurchaseConfirmationEmail({
        to: payment.customerEmail,
        templateName: payment.template.name,
        amount: payment.amount,
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
    const { paymentId, templateSlug, username, email, contact, password } = req.body || {};
    if (!paymentId || !templateSlug || !username || !email || !contact) {
      return res.status(400).json({ message: 'paymentId, templateSlug, username, email, and contact are required' });
    }

    const emailLower   = String(email).toLowerCase().trim();
    const usernameNorm = normalizeUsername(username);

    if (!isValidUsername(usernameNorm)) {
      return res.status(400).json({
        message: 'Username must be 3–32 characters: start with a letter or number; only letters, numbers, dots, underscores, hyphens',
      });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
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
      sendOnboardingCompleteEmail({
        to:           existingUser.email,
        username:     existingUser.username,
        dashboardUrl: siteUrls.coupleDashboardUrl(),
      }).catch(err => console.error('[Email Error]', err.message));
      return res.json({ ok: true, linked: true, eventCreated: true, dashboardUrl: siteUrls.coupleDashboardUrl() });
    }

    if (!password || String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters for a new account' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await prisma.user.create({
      data: {
        email:        emailLower,
        username:     usernameNorm,
        phone:        String(contact).trim(),
        passwordHash,
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
    sendOnboardingCompleteEmail({
      to:           emailLower,
      username:     usernameNorm,
      dashboardUrl: siteUrls.coupleDashboardUrl(),
    }).catch(err => console.error('[Email Error]', err.message));

    return res.json({ ok: true, linked: false, eventCreated: true, dashboardUrl: siteUrls.coupleDashboardUrl() });
  } catch (err) {
    console.error(err);
    if (err.code === 'P2002') {
      return res.status(409).json({ message: 'This username is already taken' });
    }
    return res.status(500).json({ message: 'Registration failed' });
  }
});

module.exports = router;
