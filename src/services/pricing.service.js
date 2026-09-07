/**
 * Template pricing, in both currencies.
 *
 * Only the INR price is ever maintained by hand. The USD price is DERIVED from
 * it on every read -- price / usdInrRate * markupMultiplier, rounded up to the
 * next whole $10 minus a cent -- and is never stored on Template. That is the
 * whole point: changing the global rate repositions the entire catalogue with no
 * migration, no backfill, and no rows left stale because an update failed
 * halfway. USD only reaches disk on Payment, where the figure must be frozen at
 * what was actually charged.
 *
 * The multiplier is what lifts international pricing above a straight FX
 * conversion -- converting alone would sell abroad at the India price, which is
 * the opposite of the intent.
 */
const prisma = require('../utils/prisma');
const { INTL, currencyFor } = require('../utils/storefront');

const KEY_USD_INR_RATE   = 'usdInrRate';
const KEY_DEFAULT_MARKUP = 'defaultMarkupMultiplier';

// Used only if AppSetting is empty or holds something unparseable. Never a
// silent substitute for a real rate: getPricingSettings reports when it falls
// back, so a misconfigured deploy is visible in the logs rather than quietly
// selling at guessed prices.
// These MUST match the values seeded by migration 20260906120000, or a database
// hiccup would silently reprice the entire international catalogue.
const FALLBACK_RATE   = 96;
const FALLBACK_MARKUP = 3;

// Two rows read on nearly every catalogue request and changed a few times a
// year. A short TTL keeps an admin edit visible almost immediately without
// putting a query in front of every price.
const CACHE_TTL_MS = 60 * 1000;
let cache = null; // { at: number, value: object }

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The global USD rate and default markup.
 *
 * @returns {Promise<{usdInrRate: number, defaultMarkupMultiplier: number, usingFallback: boolean}>}
 */
async function getPricingSettings({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let rows = [];
  try {
    rows = await prisma.appSetting.findMany({
      where: { key: { in: [KEY_USD_INR_RATE, KEY_DEFAULT_MARKUP] } },
    });
  } catch (err) {
    // A pricing read must never take the catalogue down. Fall back loudly.
    console.error('[pricing] AppSetting read failed:', err.message);
  }

  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const usdInrRate = positiveNumber(raw[KEY_USD_INR_RATE], FALLBACK_RATE);
  const defaultMarkupMultiplier = positiveNumber(raw[KEY_DEFAULT_MARKUP], FALLBACK_MARKUP);
  const usingFallback =
    positiveNumber(raw[KEY_USD_INR_RATE], null) === null ||
    positiveNumber(raw[KEY_DEFAULT_MARKUP], null) === null;

  if (usingFallback) {
    console.warn(
      '[pricing] usdInrRate/defaultMarkupMultiplier missing or invalid in AppSetting; ' +
      'using fallbacks ' + FALLBACK_RATE + ' / ' + FALLBACK_MARKUP
    );
  }

  const value = { usdInrRate, defaultMarkupMultiplier, usingFallback };
  cache = { at: Date.now(), value };
  return value;
}

/** Drop the cache so the next read sees an admin edit immediately. */
function invalidatePricingSettings() {
  cache = null;
}

/**
 * INR minor units -> USD minor units, at a .99 price point.
 *
 *   dollars = (paise / 100) / rate * multiplier
 *   cents   = paise * multiplier / rate
 *
 * The conversion is collapsed to an integer number of cents FIRST, so the
 * tiering below is integer arithmetic and cannot flip a whole $10 tier because a
 * float landed on 59.999999999 instead of 60.
 *
 * Rounding is a strict ceiling to the next whole $10, then a cent off:
 * 5623c -> 6000c -> 5999c ($59.99). A value already sitting exactly on a tier
 * boundary moves up to the next one -- $60.00 becomes $69.99, by decision.
 *
 * Note this makes prices sticky: at INR 2999 x 3, every rate from 90 to 99
 * yields $99.99, so ordinary FX drift changes nothing and a price only ever
 * moves a full tier at a time. The band narrows as the multiplier grows -- it
 * spanned rates 90-107 back when the default was 1.8 -- so a bigger multiplier
 * means rate edits reprice the catalogue more often.
 *
 * @returns {number|null} cents, or null if any input is unusable.
 */
function deriveUsdCents(inrPaise, usdInrRate, multiplier) {
  const paise = Number(inrPaise);
  const rate  = Number(usdInrRate);
  const mult  = Number(multiplier);

  if (!Number.isFinite(paise) || paise <= 0) return null;
  if (!Number.isFinite(rate)  || rate  <= 0) return null;
  if (!Number.isFinite(mult)  || mult  <= 0) return null;

  const rawCents  = Math.round((paise * mult) / rate);
  const tierCents = (Math.floor(rawCents / 1000) + 1) * 1000;
  return tierCents - 1;
}

/** The multiplier this template prices at: its own, else the global default. */
function multiplierFor(template, settings) {
  return positiveNumber(template && template.markupMultiplier, settings.defaultMarkupMultiplier);
}

/**
 * { priceUsd, originalPriceUsd } for one template.
 *
 * The struck-through original is derived with the same rate and multiplier as
 * the price.
 *
 * That does NOT make the discount percentage match across storefronts, and an
 * earlier version of this comment wrongly claimed it did. Price and MRP are each
 * rounded up to their own $10 tier, which breaks the ratio between them: Royal
 * reads 50% off in India (INR 2,999 from 5,999) but 47% off abroad ($99.99 from
 * $189.99). Both figures are real derived prices and each side is internally
 * consistent; the percentages simply differ, which is accepted.
 */
function usdPricesFor(template, settings) {
  const mult = multiplierFor(template, settings);
  return {
    priceUsd: deriveUsdCents(template && template.price, settings.usdInrRate, mult),
    originalPriceUsd:
      template && template.originalPrice != null
        ? deriveUsdCents(template.originalPrice, settings.usdInrRate, mult)
        : null,
  };
}

/**
 * A template row with both currencies attached.
 *
 * Catalogue endpoints return BOTH prices rather than one chosen per request, so
 * a single cached response is correct for either deployment.
 */
function withUsdPrices(template, settings) {
  if (!template) return template;
  return { ...template, ...usdPricesFor(template, settings) };
}

/**
 * The order total, itemised, for one storefront.
 *
 * Reproduces the India math exactly as it has always run -- base, minus coupon,
 * floored at 100 minor units, plus GST -- and changes only two things for the
 * international storefront: the base is the derived USD price, and GST is zero
 * because export of services is zero-rated.
 *
 * Every figure is in the minor units of `currency`: paise for INR, cents for
 * USD. coupon.discountAmount must therefore have been computed against the same
 * base this call uses -- a coupon minOrderAmount is in the minor units of its
 * own storefront currency, which is why coupons are storefront-scoped rather
 * than shared.
 *
 * Throws rather than falling back if an international price cannot be derived:
 * silently billing the INR figure in dollars would charge a customer roughly
 * fifty times the intended price.
 */
function computeBreakup({ template, storefront, coupon, settings }) {
  const intl = storefront === INTL;

  let baseAmount = template.price;
  let fxRate = null;
  let markupMultiplier = null;

  if (intl) {
    markupMultiplier = multiplierFor(template, settings);
    fxRate = settings.usdInrRate;
    baseAmount = deriveUsdCents(template.price, fxRate, markupMultiplier);
    if (baseAmount == null) {
      throw new Error('Cannot derive a USD price for template ' + (template.slug || template.id));
    }
  }

  const discountPct    = Number((coupon && coupon.discountPct) || 0);
  const discountAmount = Number((coupon && coupon.discountAmount) || 0);

  // The 100-minor-unit floor is the pre-existing India rule (never bill under
  // INR 1); in dollars it reads as never billing under $1.
  const taxableAmount = Math.max(100, baseAmount - discountAmount);
  const gstPercent    = intl ? 0 : Number(template.gstPercent || 0);
  const gstAmount     = Math.round((taxableAmount * gstPercent) / 100);
  const finalAmount   = taxableAmount + gstAmount;

  return {
    baseAmount,
    discountAmount,
    discountPct,
    gstPercent,
    gstAmount,
    finalAmount,
    currency: currencyFor(storefront),
    fxRate,
    markupMultiplier,
  };
}

module.exports = {
  KEY_USD_INR_RATE,
  KEY_DEFAULT_MARKUP,
  getPricingSettings,
  invalidatePricingSettings,
  deriveUsdCents,
  usdPricesFor,
  withUsdPrices,
  computeBreakup,
};
