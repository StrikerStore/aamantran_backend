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

/**
 * Grouped figure, no symbol, in the minor units of `currency`.
 *
 * Dollars keep their cents because international prices are deliberately .99;
 * rupees are rounded to whole units, which is how coupon copy has always read.
 */
function moneyAmount(minor, currency = 'INR') {
  const value = Number(minor || 0) / 100;
  if (String(currency).toUpperCase() === 'USD') {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return Math.round(value).toLocaleString('en-IN');
}

/**
 * Money string for customer-facing coupon copy.
 *
 * Takes a currency because these strings reach the INTERNATIONAL checkout too:
 * `listDisplayedCoupons` is storefront-scoped, and a coupon's `minOrderAmount`
 * is denominated in its own storefront's currency. Hardcoding rupees here
 * printed a dollar threshold with a ₹ in front of it.
 */
function money(minor, currency = 'INR') {
  const symbol = String(currency).toUpperCase() === 'USD' ? '$' : '₹';
  return `${symbol}${moneyAmount(minor, currency)}`;
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
 * `reasonCode` names the rule that refused the coupon, so callers can write
 * their own copy for it without re-deciding which rule applied.
 *
 * @returns {{ eligible: boolean, discountPct: number, discountAmount: number, reason?: string, reasonCode?: string }}
 */
function evaluateCoupon(coupon, { baseAmount, globalUses = 0, perUserUses = 0, currency = 'INR' } = {}) {
  const no = (reason, reasonCode) => ({
    eligible: false, discountPct: 0, discountAmount: 0, ...(reason ? { reason, reasonCode } : {}),
  });

  if (!coupon || !coupon.isActive) return no();

  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) {
    return no('Coupon expired', 'expired');
  }
  if ((coupon.minOrderAmount || 0) > baseAmount) {
    // Shown when a customer TYPES a code, so it has to read in their currency —
    // this one is reached from getCouponDiscount, not just the offers strip.
    const code = String(currency).toUpperCase() === 'USD' ? 'USD' : 'INR';
    return no(`Minimum order is ${code} ${moneyAmount(coupon.minOrderAmount, currency)}`, 'minOrder');
  }
  if (coupon.maxGlobalUses && globalUses >= coupon.maxGlobalUses) {
    return no('Coupon usage limit reached', 'globalLimit');
  }
  if (coupon.maxUsesPerUser && perUserUses >= coupon.maxUsesPerUser) {
    return no('Per-user usage limit reached', 'perUserLimit');
  }

  const discountPct = Math.max(0, Math.min(100, Number(coupon.discountPercent || 0)));
  return {
    eligible: discountPct > 0,
    discountPct,
    discountAmount: Math.round((baseAmount * discountPct) / 100),
  };
}

/**
 * Whether a coupon may be redeemed on a given storefront.
 *
 * 'BOTH' is the explicit opt-in; anything else must match exactly. Rows written
 * before the international storefront existed default to 'IN', so an old India
 * campaign cannot leak abroad and give away the markup it exists for.
 */
function couponAppliesTo(coupon, storefront) {
  const scope = String(coupon.storefront || 'IN').toUpperCase();
  return scope === 'BOTH' || scope === String(storefront || 'IN').toUpperCase();
}

/**
 * Resolve a single coupon code for an order.
 *
 * Behaviour and return shape are unchanged from the original in
 * routes/publicCheckout.js — including returning the normalised code even when
 * the coupon does not apply, which the checkout UI echoes back to the customer.
 */
async function getCouponDiscount(baseAmount, couponCodeRaw, customerEmailRaw, storefront = 'IN') {
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
      storefront: true,
    },
  });
  if (!coupon || !coupon.isActive) return { code, discountPct: 0, discountAmount: 0 };
  // A code scoped to the other storefront is refused as if it did not exist.
  // minOrderAmount is denominated in ITS storefront currency, so honouring an
  // India code against a dollar order would compare paise to cents and hand out
  // a discount roughly fifty times too large.
  if (!couponAppliesTo(coupon, storefront)) return { code, discountPct: 0, discountAmount: 0 };

  // Only counted when a limit actually exists — an unlimited coupon should not
  // pay for a COUNT on every checkout keystroke.
  const globalUses = coupon.maxGlobalUses
    ? await prisma.payment.count({ where: { couponCode: code, status: 'paid' } })
    : 0;
  const perUserUses = coupon.maxUsesPerUser && customerEmail
    ? await prisma.payment.count({ where: { couponCode: code, customerEmail, status: 'paid' } })
    : 0;

  const currency = String(storefront || 'IN').toUpperCase() === 'INTL' ? 'USD' : 'INR';
  const verdict = evaluateCoupon(coupon, { baseAmount, globalUses, perUserUses, currency });
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

/**
 * Supporting line: the conditions worth knowing before clicking Apply.
 *
 * `currency` is the storefront's, because `minOrderAmount` is denominated in it
 * — cents for an INTL coupon, paise for an India one.
 */
function couponCondition(coupon, currency = 'INR') {
  const parts = [];
  if (coupon.minOrderAmount > 0) parts.push(`on orders over ${money(coupon.minOrderAmount, currency)}`);
  if (coupon.expiresAt) {
    const locale = String(currency).toUpperCase() === 'USD' ? 'en-US' : 'en-IN';
    parts.push(`expires ${new Date(coupon.expiresAt).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`);
  }
  return parts.join(' · ');
}

/** Copy for the rules whose message does not depend on the order. */
const UNLOCK_MESSAGES = {
  expired:      'This offer has expired',
  globalLimit:  'This offer is no longer available',
  perUserLimit: 'You have already used this offer',
};

/**
 * What the customer would have to change for a coupon to apply, or null when
 * there is nothing actionable to say.
 *
 * Keyed off the verdict rather than re-testing the rules, so this copy can
 * never claim a different reason than the one that actually refused the coupon.
 */
function couponUnlockMessage(coupon, verdict, baseAmount, currency = 'INR') {
  if (verdict.reasonCode === 'minOrder') {
    // Currency code rather than a symbol, matching how this line has always
    // read — but the code itself has to follow the storefront.
    const code = String(currency).toUpperCase() === 'USD' ? 'USD' : 'INR';
    return `Add ${code} ${moneyAmount((coupon.minOrderAmount || 0) - baseAmount, currency)} more to unlock this offer`;
  }
  return UNLOCK_MESSAGES[verdict.reasonCode] || null;
}

/**
 * Every coupon an admin advertises, whether or not it applies to this order.
 *
 * Ones that do not apply are still returned, flagged `eligible: false` with an
 * `unlockMessage`, so the checkout page can show them faded rather than hide
 * them: a coupon the customer is INR 200 short of is a reason to spend more,
 * whereas a coupon they never see is not.
 *
 * Usage counts for the whole candidate set are resolved in two groupBy queries
 * rather than two per coupon.
 *
 * `customerEmail` is optional because the checkout page renders before the
 * customer has typed one. Without it the per-user cap cannot be evaluated, so a
 * coupon they have already exhausted still reads as eligible; the page
 * re-requests once the email is valid and it locks then.
 */
async function listDisplayedCoupons({ baseAmount, customerEmail, storefront = 'IN', currency = 'INR' } = {}) {
  const email = String(customerEmail || '').trim().toLowerCase();
  const scope = String(storefront || 'IN').toUpperCase();

  const candidates = await prisma.couponCode.findMany({
    where:   { isDisplayed: true, isActive: true, storefront: { in: [scope, 'BOTH'] } },
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
        currency,
      }),
    }))
    // Usable offers first; `candidates` is already ordered by discount, and
    // sort() keeps that order within each group.
    .sort((a, b) => Number(b.verdict.eligible) - Number(a.verdict.eligible))
    // Deliberately narrow: usage caps and remaining-use counts are campaign
    // sizing and must not reach the browser.
    .map(({ coupon, verdict }) => ({
      code:            coupon.code,
      discountPercent: coupon.discountPercent,
      discountAmount:  verdict.discountAmount,
      currency,
      label:           couponLabel(coupon),
      condition:       couponCondition(coupon, currency),
      expiresAt:       coupon.expiresAt,
      eligible:        verdict.eligible,
      unlockMessage:   verdict.eligible ? null : couponUnlockMessage(coupon, verdict, baseAmount, currency),
    }));
}

module.exports = {
  evaluateCoupon,
  couponAppliesTo,
  getCouponDiscount,
  listDisplayedCoupons,
  couponLabel,
  couponCondition,
  couponUnlockMessage,
};
