/**
 * Which designs people are actually drawn to.
 *
 * "Popular" used to mean `buyerCount desc` — every sale the design has ever
 * made. That has two problems: it is frozen history, so a design that sold well
 * a year ago outranks one selling well this week and keeps the top spot it was
 * given; and it ignores browsing entirely, so a design people keep opening but
 * have not yet bought looks like a design nobody wants.
 *
 * Popularity here is both signals, over the SAME recent window:
 *
 *   score = purchases × PURCHASE_WEIGHT + people who opened its page
 *
 * WHY PEOPLE, NOT VIEWS. Views are counted per session, not per page load, so a
 * design does not climb because one person refreshed it forty times, or because
 * it happens to be the one someone left open in a tab.
 *
 * WHY A WINDOW. Thirty days, both signals. Mixing all-time sales with recent
 * browsing would be incoherent — the two numbers would not be about the same
 * period — and a rolling window is what lets the ordering respond to what is
 * selling now.
 *
 * THE WEIGHT IS A DECISION, NOT A MEASUREMENT. A purchase is a far stronger
 * signal than a look, and 50 is the chosen exchange rate: a design needs about
 * fifty more people looking at it to match one more sale. Raise it to let sales
 * dominate, lower it to let interest carry more weight.
 *
 * NOTHING HERE CAN BREAK THE CATALOGUE. Every failure path returns an empty
 * ranking, and an empty ranking means the caller falls back to the old
 * buyerCount order. A fresh deployment with no analytics yet behaves exactly as
 * before, which is also why the fallback has to be a real order and not chance.
 */
const prisma = require('./../utils/prisma');
const { EXCLUDE_TEST_OWNER } = require('../utils/testFilters');

const WINDOW_DAYS = 30;
const PURCHASE_WEIGHT = 50;

// Long enough that the catalogue is not doing analytics work on every request,
// short enough that a design selling today climbs within the hour.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null; // { at: number, value: { bySlug: Map, byTemplateId: Map } }

function windowStart(now = new Date()) {
  return new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Recent interest and recent sales.
 *
 * @returns {Promise<{ bySlug: Map<string, number>, byTemplateId: Map<string, number>, isEmpty: boolean }>}
 *   viewers per design slug, and purchases per template id.
 */
async function getPopularitySignals({ force = false, now = new Date() } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const since = windowStart(now);
  let viewRows = [];
  let buyRows = [];

  try {
    [viewRows, buyRows] = await Promise.all([
      // The slug rides in the event's metadata; the path would need parsing and
      // would count the gallery's own URLs too.
      prisma.$queryRaw`
        SELECT JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.slug')) AS slug,
               COUNT(DISTINCT e.sessionId) AS viewers
        FROM WebsiteEvent e
        WHERE e.type = 'view_template'
          AND e.createdAt >= ${since}
          AND JSON_EXTRACT(e.metadata, '$.slug') IS NOT NULL
        GROUP BY slug`,
      prisma.payment.groupBy({
        by: ['templateId'],
        where: { status: 'paid', createdAt: { gte: since }, ...EXCLUDE_TEST_OWNER },
        _count: { _all: true },
      }),
    ]);
  } catch (err) {
    // The catalogue must never fail because analytics did.
    console.error('[popularity] could not read recent activity:', err.message);
    const empty = { bySlug: new Map(), byTemplateId: new Map(), isEmpty: true };
    cache = { at: Date.now(), value: empty };
    return empty;
  }

  const bySlug = new Map();
  for (const row of viewRows) {
    if (row.slug) bySlug.set(String(row.slug), Number(row.viewers) || 0);
  }
  const byTemplateId = new Map();
  for (const row of buyRows) {
    byTemplateId.set(row.templateId, row._count._all);
  }

  const value = { bySlug, byTemplateId, isEmpty: bySlug.size === 0 && byTemplateId.size === 0 };
  cache = { at: Date.now(), value };
  return value;
}

function invalidatePopularity() {
  cache = null;
}

/** One design's score. `template` needs `id` and `slug`. */
function scoreFor(template, signals) {
  const viewers = signals.bySlug.get(template.slug) || 0;
  const purchases = signals.byTemplateId.get(template.id) || 0;
  return purchases * PURCHASE_WEIGHT + viewers;
}

/**
 * Sort designs by popularity, most first.
 *
 * Ties, and designs with no recent activity at all, fall through to lifetime
 * sales and then to the newest — so the order is always fully determined.
 * Two designs must never swap places between one page load and the next.
 *
 * Returns a new array; the input is not modified.
 */
function rankByPopularity(templates, signals) {
  return [...templates].sort((a, b) => {
    const diff = scoreFor(b, signals) - scoreFor(a, signals);
    if (diff !== 0) return diff;

    const lifetime = (b.buyerCount || 0) - (a.buyerCount || 0);
    if (lifetime !== 0) return lifetime;

    const aDate = a.releasedAt ? new Date(a.releasedAt).getTime() : 0;
    const bDate = b.releasedAt ? new Date(b.releasedAt).getTime() : 0;
    if (bDate !== aDate) return bDate - aDate;

    // Last resort, so the order is stable even for two designs that are
    // identical on every count above.
    return String(a.id).localeCompare(String(b.id));
  });
}

module.exports = {
  WINDOW_DAYS,
  PURCHASE_WEIGHT,
  getPopularitySignals,
  invalidatePopularity,
  scoreFor,
  rankByPopularity,
};
