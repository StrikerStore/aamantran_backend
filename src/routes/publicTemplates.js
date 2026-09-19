// Public-facing API used by the landing page (no auth required)
const express = require('express');
const prisma  = require('../utils/prisma');
const { publicInviteLimiter } = require('../middleware/rateLimits');
const { EXCLUDE_SANDBOX_TEMPLATE } = require('../utils/testFilters');
const { getPricingSettings, withUsdPrices } = require('../services/pricing.service');
const {
  VISIBLE_REVIEW_WHERE, withSource, genuineAggregate, countCurated,
} = require('../utils/reviewAggregates');
const { parseHighlights, excerptWords } = require('../utils/templateMarketing');
const { getTemplateCapabilities } = require('../services/templateCapabilities.service');
const { canTryTemplate, TRY_ELIGIBILITY_SELECT } = require('../services/trialDemo.service');

/**
 * "Try it with your names" eligibility by template id.
 *
 * A separate query on purpose: the rule reads fieldSchema and demo data, and
 * keeping those out of the main `select` means they can never leak through a
 * response spread. Never throws — on failure every design reports false and
 * the storefront simply hides the button.
 */
async function loadTryWithNames(ids) {
  if (!ids.length) return new Map();
  try {
    const rows = await prisma.template.findMany({
      where:  { id: { in: ids } },
      select: { id: true, ...TRY_ELIGIBILITY_SELECT },
    });
    return new Map(rows.map((row) => [row.id, canTryTemplate(row)]));
  } catch {
    return new Map();
  }
}

const router = express.Router();
router.use(publicInviteLimiter);

/* ── Query parsing ──────────────────────────────────────────────────────────
 * The gallery is public and linkable, so bad input is ignored rather than
 * rejected: a hand-edited or stale URL should still show a catalogue.
 */

const LIMIT_DEFAULT = 20;
// 100, not lower: the sitemap requests limit=100 and must not be truncated.
const LIMIT_MAX     = 100;
const Q_MAX_LENGTH  = 60;

/** Whole number within [min, max], or `fallback` when missing or not a number. */
function intParam(value, { min, max, fallback }) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Non-negative price in paise, or undefined so the bound is simply not applied. */
function priceParam(value) {
  if (value == null || value === '') return undefined;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Checkout's price for an order with no coupon — same arithmetic as
 * routes/publicCheckout.js, including its 100-paise taxable floor — so a
 * "From ₹X incl. GST" figure can never disagree with the amount charged.
 */
function totalWithGst(price, gstPercent) {
  const taxable = Math.max(100, Number(price) || 0);
  return taxable + Math.round((taxable * Number(gstPercent || 0)) / 100);
}

// GET /api/templates — template listing for the gallery page
// Query params:
//   community, eventType, exclude           exact / bestFor-contains / slug-not filters
//   q                                       name contains (case-insensitive under the MySQL collation)
//   minPrice, maxPrice                      bounds on the base price in paise, before GST
//   sort                                    popular | new | price-asc | price-desc
//   limit (1–100, default 20), page (≥ 1)
router.get('/', async (req, res) => {
  const { community, eventType, exclude, sort = 'popular' } = req.query;

  const limit = intParam(req.query.limit, { min: 1, max: LIMIT_MAX, fallback: LIMIT_DEFAULT });
  const page  = intParam(req.query.page,  { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 });
  const skip  = (page - 1) * limit;

  const q = String(req.query.q ?? '').replace(/\s+/g, ' ').trim().slice(0, Q_MAX_LENGTH);

  let minPrice = priceParam(req.query.minPrice);
  let maxPrice = priceParam(req.query.maxPrice);
  // A reversed range is almost always a UI slip; honour the intent.
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    [minPrice, maxPrice] = [maxPrice, minPrice];
  }
  const priceWhere = {
    ...(minPrice !== undefined && { gte: minPrice }),
    ...(maxPrice !== undefined && { lte: maxPrice }),
  };

  const where = {
    isActive: true,
    ...EXCLUDE_SANDBOX_TEMPLATE,
    ...(community  && { community }),
    ...(eventType  && { bestFor: { contains: eventType } }),
    ...(exclude    && { slug: { not: exclude } }),
    ...(q          && { name: { contains: q } }),
    ...(Object.keys(priceWhere).length && { price: priceWhere }),
  };

  const orderBy =
    sort === 'popular'    ? { buyerCount: 'desc' } :
    sort === 'new'        ? { releasedAt: 'desc' } :
    sort === 'price-asc'  ? { price: 'asc'  } :
    sort === 'price-desc' ? { price: 'desc' } :
    { buyerCount: 'desc' };

  const [templates, total] = await Promise.all([
    prisma.template.findMany({
      where,
      skip,
      take:    Number(limit),
      orderBy,
      select: {
        id: true, slug: true, name: true,
        thumbnailUrl: true, desktopThumbnailUrl: true, mobileThumbnailUrl: true, community: true,
        desktopEntryFile: true, mobileEntryFile: true,
        bestFor: true, languages: true, badge: true,
        shortDescription: true, highlights: true, aboutText: true,
        price: true, originalPrice: true, gstPercent: true, markupMultiplier: true,
        buyerCount: true, avgRating: true, releasedAt: true,
      },
    }),
    prisma.template.count({ where }),
  ]);

  // Both currencies go out on every row, and the deployment picks. One cached
  // response is then correct for either storefront, which is what keeps the
  // catalogue statically cacheable now that there are two of them.
  const [settings, tryable] = await Promise.all([
    getPricingSettings(),
    loadTryWithNames(templates.map((t) => t.id)),
  ]);

  res.json({
    // highlights is stored comma-separated like bestFor; the storefront wants chips.
    // aboutText goes out only as a short excerpt: gallery cards need a sentence
    // for templates with no shortDescription, and nothing lists the full prose.
    templates: templates.map(({ aboutText, ...t }) => withUsdPrices(
      {
        ...t,
        highlights: parseHighlights(t.highlights),
        aboutExcerpt: excerptWords(aboutText),
        tryWithNames: tryable.get(t.id) === true,
      },
      settings,
    )),
    total,
    page,
    limit,
  });
});

// GET /api/templates/stats — catalogue facts for the storefront shell.
// Must be declared before /:slug, or "stats" would be captured as a slug.
// Returns:
//   total      active catalogue templates
//   lowest     { price, gstPercent, total } of the template with the lowest
//              payable total (GST included, checkout arithmetic), or null
//   occasions  { "Wedding": 12, "Birthday": 3, ... } counted per exact bestFor
//              term. Note the list filter's eventType is a *contains* match, so
//              eventType=Birthday also returns "First Birthday" templates that
//              are counted under their own term here.
router.get('/stats', async (_req, res) => {
  const rows = await prisma.template.findMany({
    where:  { isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
    select: { price: true, gstPercent: true, bestFor: true },
  });

  let lowest = null;
  const occasions = {};
  for (const row of rows) {
    const total = totalWithGst(row.price, row.gstPercent);
    // Compared on the payable total, not the base price: a cheaper base with a
    // higher GST rate can cost the buyer more.
    if (!lowest || total < lowest.total) {
      lowest = { price: row.price, gstPercent: Number(row.gstPercent || 0), total };
    }
    const terms = new Set(String(row.bestFor || '').split(',').map((s) => s.trim()).filter(Boolean));
    for (const term of terms) occasions[term] = (occasions[term] || 0) + 1;
  }

  res.json({ total: rows.length, lowest, occasions });
});

// GET /api/reviews/featured — must be before /:slug to avoid slug capture
// (mounted at /api/reviews in index.js → resolves to /api/reviews/featured)
// Returns { reviews, avgRating, totalCount, curatedCount }. The list holds every
// visible review, each tagged `source: 'customer' | 'curated'` so the storefront
// can label team-written ones; avgRating/totalCount count genuine customer
// reviews across the platform, so curated copy never inflates the rating.
router.get('/featured', async (req, res) => {
  const { limit = 50 } = req.query;
  const where = { reviewText: { not: null }, ...VISIBLE_REVIEW_WHERE };

  const [reviews, aggregate, curatedCount] = await Promise.all([
    prisma.templateReview.findMany({
      where,
      take:    Number(limit),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, rating: true, reviewText: true,
        coupleNames: true, location: true, createdAt: true,
        couplePhotoUrl: true, isAdminCreated: true,
        template: { select: { name: true, slug: true } },
      },
    }),
    genuineAggregate(),
    countCurated(),
  ]);

  res.json({ reviews: reviews.map(withSource), ...aggregate, curatedCount });
});

/**
 * Capabilities are loaded through their own query on purpose. folderPath,
 * fieldSchema and version data are internal; keeping them out of the main
 * `select` means they can never leak through the `...template` spread below.
 * Never throws — a failure reports null and the product page omits the section.
 */
async function loadCapabilities(templateId) {
  try {
    const internal = await prisma.template.findUnique({
      where:  { id: templateId },
      select: {
        slug: true, folderPath: true, fieldSchema: true, languages: true,
        desktopEntryFile: true, mobileEntryFile: true, updatedAt: true,
        currentVersion: {
          select: { id: true, folderPath: true, fieldSchema: true, desktopEntryFile: true, mobileEntryFile: true },
        },
      },
    });
    return internal ? await getTemplateCapabilities(internal) : null;
  } catch {
    return null;
  }
}

// GET /api/templates/:slug — single template detail for product page
router.get('/:slug', async (req, res) => {
  const template = await prisma.template.findUnique({
    where: { slug: req.params.slug, isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
    select: {
      id: true, slug: true, name: true,
      thumbnailUrl: true, desktopThumbnailUrl: true, mobileThumbnailUrl: true, community: true,
      desktopEntryFile: true, mobileEntryFile: true,
      bestFor: true, languages: true, badge: true, style: true, colourPalette: true, animations: true,
      shortDescription: true, highlights: true,
      price: true, originalPrice: true, gstPercent: true, markupMultiplier: true, aboutText: true,
      buyerCount: true, avgRating: true, releasedAt: true,
    },
  });

  if (!template) return res.status(404).json({ message: 'Template not found' });

  // Opt-in: checkout also calls this endpoint and must not pay for an R2 read
  // it never uses. Only the product page sends ?include=capabilities.
  const wantsCapabilities = String(req.query.include || '')
    .split(',')
    .map((s) => s.trim())
    .includes('capabilities');

  // reviewCount drives the product page's rating line and the AggregateRating in
  // JSON-LD, so it counts genuine reviews only. Curated ones are reported
  // separately and shown as labelled cards.
  const [settings, { totalCount: reviewCount }, curatedReviewCount, capabilities, tryable] = await Promise.all([
    getPricingSettings(),
    genuineAggregate({ templateId: template.id }),
    countCurated({ templateId: template.id }),
    wantsCapabilities ? loadCapabilities(template.id) : undefined,
    loadTryWithNames([template.id]),
  ]);
  res.json({
    ...withUsdPrices(template, settings),
    highlights: parseHighlights(template.highlights),
    reviewCount,
    curatedReviewCount,
    tryWithNames: tryable.get(template.id) === true,
    ...(wantsCapabilities && { capabilities }),
  });
});

// GET /api/templates/:slug/reviews
// Returns { reviews, avgRating, totalCount, curatedCount } scoped to this
// template, on the same rule as /featured: every visible review is listed and
// tagged, but only genuine customer reviews are counted.
router.get('/:slug/reviews', async (req, res) => {
  const { limit = 50 } = req.query;
  const template = await prisma.template.findUnique({ where: { slug: req.params.slug } });
  if (!template) return res.json({ reviews: [], avgRating: 0, totalCount: 0, curatedCount: 0 });

  const scope = { templateId: template.id };

  const [reviews, aggregate, curatedCount] = await Promise.all([
    prisma.templateReview.findMany({
      where:   { ...scope, ...VISIBLE_REVIEW_WHERE },
      take:    Number(limit),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, rating: true, reviewText: true,
        coupleNames: true, location: true, createdAt: true,
        couplePhotoUrl: true, isAdminCreated: true,
      },
    }),
    genuineAggregate(scope),
    countCurated(scope),
  ]);

  res.json({ reviews: reviews.map(withSource), ...aggregate, curatedCount });
});

module.exports = router;
