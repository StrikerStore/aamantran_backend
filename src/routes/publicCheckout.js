const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const prisma = require('../utils/prisma');
const { checkoutLimiter, lookupLimiter } = require('../middleware/rateLimits');
const { createOrder } = require('../services/razorpay.service');
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
  } catch (err) {
    return res.status(500).json({ message: 'Failed to preview coupon' });
  }
});

// POST /api/checkout/order
router.post('/order', async (req, res) => {
  try {
    const { templateSlug, couponCode, customerEmail } = req.body || {};
    if (!templateSlug) return res.status(400).json({ message: 'templateSlug is required' });

    const template = await prisma.template.findUnique({
      where: { slug: templateSlug, isActive: true },
      select: { id: true, slug: true, name: true, price: true, gstPercent: true },
    });
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const coupon = await getCouponDiscount(template.price, couponCode, customerEmail);
    const discountPct = coupon.discountPct;
    const discountAmount = coupon.discountAmount;
    const taxableAmount = Math.max(100, template.price - discountAmount);
    const gstPercent = Number(template.gstPercent || 0);
    const gstAmount = Math.round((taxableAmount * gstPercent) / 100);
    const finalAmount = taxableAmount + gstAmount;

    const order = DUMMY_PAYMENT_MODE
      ? { id: `mock_order_${Date.now()}` }
      : await createOrder({
          amountPaise: finalAmount,
          receipt: `tpl_${template.slug}_${Date.now()}`,
          notes: { templateSlug: template.slug },
        });

    const payment = await prisma.payment.create({
      data: {
        templateId: template.id,
        razorpayOrderId: order.id,
        customerEmail: customerEmail ? String(customerEmail).trim().toLowerCase() : null,
        couponCode: coupon.discountPct > 0 ? coupon.code : null,
        discountAmount,
        amount: finalAmount,
        currency: 'INR',
        status: 'pending',
      },
      select: { id: true },
    });

    return res.json({
      key: process.env.RAZORPAY_KEY_ID,
      amount: finalAmount,
      currency: 'INR',
      paymentId: payment.id,
      orderId: order.id,
      priceBreakup: {
        baseAmount: template.price,
        discountAmount,
        gstPercent,
        gstAmount,
        finalAmount,
        discountPct,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to create checkout order' });
  }
});

// POST /api/checkout/verify
router.post('/verify', async (req, res) => {
  try {
    const { paymentId, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};
    if (!paymentId || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ message: 'Missing payment verification fields' });
    }

    const paymentRow = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { template: { select: { name: true, slug: true } } },
    });
    if (!paymentRow) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    if (paymentRow.status === 'paid') {
      return res.json({ ok: true });
    }
    if (paymentRow.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ message: 'Order does not match this payment' });
    }

    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(payload)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ message: 'Invalid payment signature' });
    }

    const payment = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'paid',
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
      },
      include: { template: { select: { name: true, slug: true } } },
    });

    if (payment.customerEmail) {
      const onboardingUrl = `${siteUrls.landingUrl()}/onboarding?paymentId=${encodeURIComponent(payment.id)}&slug=${encodeURIComponent(payment.template.slug)}&template=${encodeURIComponent(payment.template.name)}`;
      sendPurchaseConfirmationEmail({
        to: payment.customerEmail,
        templateName: payment.template.name,
        amount: payment.amount,
        onboardingUrl,
      }).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Payment verification failed' });
  }
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
        status: 'paid',
        razorpayOrderId: `mock_order_${Date.now()}`,
        razorpayPaymentId: `mock_payment_${Date.now()}`,
      },
      include: { template: { select: { name: true, slug: true } } },
    });

    if (payment.customerEmail) {
      const onboardingUrl = `${siteUrls.landingUrl()}/onboarding?paymentId=${encodeURIComponent(payment.id)}&slug=${encodeURIComponent(payment.template.slug)}&template=${encodeURIComponent(payment.template.name)}`;
      sendPurchaseConfirmationEmail({
        to: payment.customerEmail,
        templateName: payment.template.name,
        amount: payment.amount,
        onboardingUrl,
      }).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Mock payment failed' });
  }
});

// GET /api/checkout/lookup-email?email= — public
// Returns { exists, username } — used on onboarding page to autofill username
router.get('/lookup-email', lookupLimiter, async (req, res) => {
  try {
    const emailLower = String(req.query.email || '').trim().toLowerCase();
    if (!emailLower) return res.json({ ok: true, exists: false });

    const user = await prisma.user.findFirst({
      where: { email: emailLower },
      select: { username: true },
      orderBy: { createdAt: 'desc' }, // most recent account for this email
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
// Smart: if username already exists and email matches → link payment to existing user
//        if username is new → create fresh account (password required)
router.post('/register', async (req, res) => {
  try {
    const { paymentId, templateSlug, username, email, contact, password } = req.body || {};
    if (!paymentId || !templateSlug || !username || !email || !contact) {
      return res.status(400).json({ message: 'paymentId, templateSlug, username, email, and contact are required' });
    }

    const emailLower = String(email).toLowerCase().trim();
    const usernameNorm = normalizeUsername(username);

    if (!isValidUsername(usernameNorm)) {
      return res.status(400).json({
        message:
          'Username must be 3–32 characters: start with a letter or number; only letters, numbers, dots, underscores, hyphens',
      });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
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

    // Check if username already exists
    const existingUser = await prisma.user.findFirst({ where: { username: usernameNorm } });

    if (existingUser) {
      // Username exists — link only if email matches (same person buying again)
      if (existingUser.email !== emailLower) {
        return res.status(409).json({ message: 'This username belongs to a different account. Choose a different username or use your original email.' });
      }
      // Link payment to existing user — no new user created, no password needed
      const eventSlug = await ensureUniqueEventSlug(`${usernameNorm}-${payment.template.slug}`);
      const eventType = inferEventTypeFromTemplate(payment.template);
      const event = await prisma.event.create({
        data: {
          slug: eventSlug,
          ownerId: existingUser.id,
          templateId: payment.templateId,
          community: payment.template.community || 'universal',
          eventType,
          language: 'en',
        },
        select: { id: true },
      });
      await prisma.payment.update({
        where: { id: paymentId },
        data: { userId: existingUser.id, eventId: event.id, isOnboarded: true, onboardedAt: new Date() },
      });
      sendOnboardingCompleteEmail({
        to: existingUser.email,
        username: existingUser.username,
        dashboardUrl: siteUrls.coupleDashboardUrl(),
      }).catch(() => {});
      return res.json({
        ok: true,
        linked: true,
        eventCreated: true,
        dashboardUrl: siteUrls.coupleDashboardUrl(),
      });
    }

    // Username is new — create fresh account (password required)
    if (!password || String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters for a new account' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = await prisma.user.create({
      data: {
        email: emailLower,
        username: usernameNorm,
        phone: String(contact).trim(),
        passwordHash,
      },
      select: { id: true },
    });

    const eventSlug = await ensureUniqueEventSlug(`${usernameNorm}-${payment.template.slug}`);
    const eventType = inferEventTypeFromTemplate(payment.template);
    const event = await prisma.event.create({
      data: {
        slug: eventSlug,
        ownerId: user.id,
        templateId: payment.templateId,
        community: payment.template.community || 'universal',
        eventType,
        language: 'en',
      },
      select: { id: true },
    });

    await prisma.payment.update({
      where: { id: paymentId },
      data: { userId: user.id, eventId: event.id, isOnboarded: true, onboardedAt: new Date() },
    });
    sendOnboardingCompleteEmail({
      to: user.email,
      username: user.username,
      dashboardUrl: siteUrls.coupleDashboardUrl(),
    }).catch(() => {});

    return res.json({
      ok: true,
      linked: false,
      eventCreated: true,
      dashboardUrl: siteUrls.coupleDashboardUrl(),
    });
  } catch (err) {
    console.error(err);
    if (err.code === 'P2002') {
      return res.status(409).json({ message: 'This username is already taken' });
    }
    return res.status(500).json({ message: 'Registration failed' });
  }
});

module.exports = router;
