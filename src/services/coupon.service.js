/**
 * Coupon eligibility — the single place the rules live.
 *
 * These rules used to sit inside `getCouponDiscount` in routes/publicCheckout.js
 * and were only ever asked about one code at a time. The checkout page now also
 * *lists* the coupons a customer could use, which asks the same questions about
 * many codes at once. Two implementations would drift, and the failure that
 * produces is nasty: an offer advertised on the page that is then refused when
 * the customer clicks it. So both paths go through `evaluateCoupon` here.
 *
 * `getCouponDiscount` keeps its original signature and return shapes exactly —
 * `/coupon-preview` and `/order` read `.reason` and `.discountAmount` and must
 * not notice this move.
 */
const prisma = require('../utils/prisma');

/** Rupee string for customer-facing copy. Amounts are stored in paise. */
function rupees(paise) {
  return `₹${Math.round(Number(paise || 0) / 100).toLocaleString('en-IN')}`;
}

/**
 * Decide whether one already-loaded coupon applies.
 *
 * Pure: every count it needs is passed in, so a listing can resolve usage for
 * many coupons in one query instead of one query per coupon.
 *
 * @param {object} coupon                Row from CouponCode.
 * @param {number} opts.baseAmount       Order value in paise, before discount.
 * @param {number} [opts.globalUses]     Paid redemptions of this code, all customers.
 * @param {number} [opts.perUserUses]    Paid redemptions of this code by this customer.
 * @returns {{ eligible: boolean, discountPct: number, discountAmount: number, reason?: string }}
 */
function evaluateCoupon(coupon, { baseAmount, globalUses = 0, perUserUses = 0 } = {}) {
  const no = (reason) => ({ eligible: false, discountPct: 0, discountAmount: 0, ...(reason ? { reason } : {}) });

  if (!coupon || !coupon.isActive) return no();

  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) {
    return no('Coupon expired');
  }
  if ((coupon.minOrderAmount || 0) > baseAmount) {
    return no(`Minimum order is INR ${(coupon.minOrderAmount / 100).toLocaleString('en-IN')}`);
  }
  if (coupon.maxGlobalUses && globalUses >= coupon.maxGlobalUses) {
    return no('Coupon usage limit reached');
  }
  if (coupon.maxUsesPerUser && perUserUses >= coupon.maxUsesPerUser) {
    return no('Per-user usage limit reached');
  }

  const discountPct = Math.max(0, Math.min(100, Number(coupon.discountPercent || 0)));
  return {
    eligible: discountPct > 0,
    discountPct,
    discountAmount: Math.round((baseAmount * discountPct) / 100),
  };
}

/**
 * Resolve a single coupon code for an order.
 *
 * Behaviour and return shape are unchanged from the original in
 * routes/publicCheckout.js — including returning the normalised code even when
 * the coupon does not apply, which the checkout UI echoes back to the customer.
 */
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

  // Only counted when a limit actually exists — an unlimited coupon should not
  // pay for a COUNT on every checkout keystroke.
  const globalUses = coupon.maxGlobalUses
    ? await prisma.payment.count({ where: { couponCode: code, status: 'paid' } })
    : 0;
  const perUserUses = coupon.maxUsesPerUser && customerEmail
    ? await prisma.payment.count({ where: { couponCode: code, customerEmail, status: 'paid' } })
    : 0;

  const verdict = evaluateCoupon(coupon, { baseAmount, globalUses, perUserUses });
  return {
    code: verdict.eligible ? coupon.code : code,
    discountPct: verdict.discountPct,
    discountAmount: verdict.discountAmount,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}

/** Customer-facing headline, generated so it can never contradict the rules. */
function couponLabel(coupon) {
  return `${coupon.discountPercent}% off`;
}

/** Supporting line: the conditions worth knowing before clicking Apply. */
function couponCondition(coupon) {
  const parts = [];
  if (coupon.minOrderAmount > 0) parts.push(`on orders over ${rupees(coupon.minOrderAmount)}`);
  if (coupon.expiresAt) {
    parts.push(`expires ${new Date(coupon.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
  }
  return parts.join(' · ');
}

/**
 * Every displayed coupon that would actually apply to this order.
 *
 * Usage counts for the whole candidate set are resolved in two groupBy queries
 * rather than two per coupon.
 *
 * `customerEmail` is optional because the checkout page renders before the
 * customer has typed one. Without it the per-user cap cannot be evaluated, so a
 * coupon they have already exhausted is still listed; the page re-requests once
 * the email is valid and it drops out then.
 */
async function listEligibleCoupons({ baseAmount, customerEmail } = {}) {
  const email = String(customerEmail || '').trim().toLowerCase();

  const candidates = await prisma.couponCode.findMany({
    where:   { isDisplayed: true, isActive: true },
    orderBy: { discountPercent: 'desc' },
  });
  if (!candidates.length) return [];

  const codes = candidates.map((c) => c.code);
  const [globalRows, perUserRows] = await Promise.all([
    prisma.payment.groupBy({
      by: ['couponCode'],
      where: { couponCode: { in: codes }, status: 'paid' },
      _count: { _all: true },
    }),
    email
      ? prisma.payment.groupBy({
          by: ['couponCode'],
          where: { couponCode: { in: codes }, customerEmail: email, status: 'paid' },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const globalUses  = Object.fromEntries(globalRows.map((r) => [r.couponCode, r._count._all]));
  const perUserUses = Object.fromEntries(perUserRows.map((r) => [r.couponCode, r._count._all]));

  return candidates
    .map((coupon) => ({
      coupon,
      verdict: evaluateCoupon(coupon, {
        baseAmount,
        globalUses:  globalUses[coupon.code] || 0,
        perUserUses: perUserUses[coupon.code] || 0,
      }),
    }))
    .filter(({ verdict }) => verdict.eligible)
    // Deliberately narrow: usage caps and remaining-use counts are campaign
    // sizing and must not reach the browser.
    .map(({ coupon, verdict }) => ({
      code:            coupon.code,
      discountPercent: verdict.discountPct,
      discountAmount:  verdict.discountAmount,
      label:           couponLabel(coupon),
      condition:       couponCondition(coupon),
      expiresAt:       coupon.expiresAt,
    }));
}

module.exports = {
  evaluateCoupon,
  getCouponDiscount,
  listEligibleCoupons,
  couponLabel,
  couponCondition,
};
