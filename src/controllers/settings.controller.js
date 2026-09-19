/**
 * Admin-editable runtime settings.
 *
 * Currently just the two pricing inputs -- the USD reference rate and the
 * default markup multiplier -- which together reposition the entire
 * international catalogue. They live in AppSetting rather than env vars so an
 * admin can change a rate without a redeploy.
 */
const prisma = require('../utils/prisma');
const { EXCLUDE_SANDBOX_TEMPLATE } = require('../utils/testFilters');
const {
  KEY_USD_INR_RATE,
  KEY_DEFAULT_MARKUP,
  getPricingSettings,
  invalidatePricingSettings,
  deriveUsdCents,
} = require('../services/pricing.service');
const { getGatewayStatus, setGatewayFor } = require('../services/paymentGateway.service');

// Guard rails, not policy. Wide enough that a legitimate rate never trips them,
// narrow enough that a typo -- a rate of 9 instead of 96, or a fat-fingered
// multiplier of 18 instead of 1.8 -- is refused rather than silently
// repricing the whole catalogue by an order of magnitude.
const RATE_MIN = 1;
const RATE_MAX = 1000;
const MARKUP_MIN = 0.1;
const MARKUP_MAX = 20;

function parseBounded(raw, { min, max, label }) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: label + ' must be a number' };
  if (n < min || n > max) return { error: label + ' must be between ' + min + ' and ' + max };
  return { value: n };
}

/** GET /api/v1/settings/pricing */
async function getPricing(req, res) {
  const settings = await getPricingSettings({ force: true });
  return res.json({ ok: true, data: settings });
}

/**
 * PUT /api/v1/settings/pricing
 *
 * Both values are written together in one transaction: a half-applied change
 * would price the catalogue off a new rate at the old markup, which is a real
 * price nobody chose.
 */
async function updatePricing(req, res) {
  const { usdInrRate, defaultMarkupMultiplier } = req.body || {};

  const rate = parseBounded(usdInrRate, { min: RATE_MIN, max: RATE_MAX, label: 'USD rate' });
  if (rate.error) return res.status(400).json({ ok: false, message: rate.error });

  const markup = parseBounded(defaultMarkupMultiplier, {
    min: MARKUP_MIN, max: MARKUP_MAX, label: 'Default multiplier',
  });
  if (markup.error) return res.status(400).json({ ok: false, message: markup.error });

  const write = (key, value) =>
    prisma.appSetting.upsert({
      where:  { key },
      create: { key, value: String(value) },
      update: { value: String(value) },
    });

  await prisma.$transaction([
    write(KEY_USD_INR_RATE, rate.value),
    write(KEY_DEFAULT_MARKUP, markup.value),
  ]);

  // Otherwise the storefront keeps serving the old rate for up to the cache TTL
  // and the admin thinks the save did not take.
  invalidatePricingSettings();

  const settings = await getPricingSettings({ force: true });
  return res.json({ ok: true, data: settings });
}

/**
 * GET /api/v1/settings/pricing/preview?usdInrRate=&defaultMarkupMultiplier=
 *
 * What the proposed numbers would do to every live template, beside what they
 * cost today.
 *
 * This exists because the rounding makes prices sticky and then jumpy: at
 * INR 2999 x 3 every rate from 90 to 99 yields the same $99.99, so most edits
 * change nothing at all -- and then one more rupee moves a template a full $10
 * tier. Without a preview an admin cannot tell those two cases apart before
 * saving.
 */
async function previewPricing(req, res) {
  const current = await getPricingSettings({ force: true });

  const rate = parseBounded(
    req.query.usdInrRate != null ? req.query.usdInrRate : current.usdInrRate,
    { min: RATE_MIN, max: RATE_MAX, label: 'USD rate' }
  );
  if (rate.error) return res.status(400).json({ ok: false, message: rate.error });

  const markup = parseBounded(
    req.query.defaultMarkupMultiplier != null
      ? req.query.defaultMarkupMultiplier
      : current.defaultMarkupMultiplier,
    { min: MARKUP_MIN, max: MARKUP_MAX, label: 'Default multiplier' }
  );
  if (markup.error) return res.status(400).json({ ok: false, message: markup.error });

  const templates = await prisma.template.findMany({
    where:  { isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
    select: { id: true, slug: true, name: true, price: true, markupMultiplier: true },
    orderBy: { name: 'asc' },
  });

  const multOf = (t, fallback) => {
    const own = Number(t.markupMultiplier);
    return Number.isFinite(own) && own > 0 ? own : fallback;
  };

  const rows = templates.map((t) => {
    const before = deriveUsdCents(t.price, current.usdInrRate, multOf(t, current.defaultMarkupMultiplier));
    const after  = deriveUsdCents(t.price, rate.value,         multOf(t, markup.value));
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      price: t.price,
      markupMultiplier: t.markupMultiplier,
      usesDefaultMultiplier: !(Number(t.markupMultiplier) > 0),
      priceUsdBefore: before,
      priceUsdAfter:  after,
      changed: before !== after,
    };
  });

  return res.json({
    ok: true,
    data: {
      current,
      proposed: { usdInrRate: rate.value, defaultMarkupMultiplier: markup.value },
      changedCount: rows.filter((r) => r.changed).length,
      templates: rows,
    },
  });
}

/**
 * GET /api/v1/settings/gateway
 *
 * Which gateway each storefront pays through, and which it could. Includes the
 * gateways that are NOT selectable and why, because "PayU is greyed out for the
 * global site" is only useful next to "set PAYU_INTL_MERCHANT_KEY".
 */
async function getGateway(req, res) {
  const data = await getGatewayStatus();
  return res.json({ ok: true, data });
}

/**
 * PUT /api/v1/settings/gateway  { storefront, gateway }
 *
 * Refuses a gateway with no credentials for that storefront: saving it would
 * make every subsequent order on that site fail with a 503.
 */
async function updateGateway(req, res) {
  const { storefront, gateway } = req.body || {};
  if (!storefront || !gateway) {
    return res.status(400).json({ ok: false, message: 'storefront and gateway are required' });
  }

  const result = await setGatewayFor(storefront, gateway);
  if (result.error) return res.status(400).json({ ok: false, message: result.error });

  const data = await getGatewayStatus();
  return res.json({ ok: true, data });
}

module.exports = { getPricing, updatePricing, previewPricing, getGateway, updateGateway };
