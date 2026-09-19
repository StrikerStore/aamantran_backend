/**
 * One definition of which reviews count toward a public rating.
 *
 * EVERY VISIBLE REVIEW COUNTS. `isAdminCreated` records how a review reached
 * the database — typed into the admin panel rather than submitted through the
 * site — and NOT whether a customer wrote it. The owner collects reviews by
 * hand, from messages and calls, and enters them; every one is a real
 * customer's words.
 *
 * That is why the flag no longer excludes a review from the average, the count
 * or the AggregateRating in structured data. How a review arrived is still
 * recorded, because it is worth knowing, but it is not a claim about who wrote
 * it.
 *
 * If a review is ever written as an illustration rather than quoted from a
 * customer, it must not be published at all — presenting invented copy as
 * customer evidence is what this module exists to prevent.
 *
 * Every rating writer and public aggregate goes through here, so the rule
 * cannot drift between the admin panel, the couple dashboard and the store.
 */
const prisma = require('./prisma');
const { EXCLUDE_TEST_OWNER } = require('./testFilters');

/** Counts toward ratings: visible, and not owned by a test account. */
const GENUINE_REVIEW_WHERE = { isHidden: false, ...EXCLUDE_TEST_OWNER };

/** Shown publicly, whatever wrote it — customer reviews plus curated ones. */
const VISIBLE_REVIEW_WHERE = { isHidden: false, ...EXCLUDE_TEST_OWNER };

/**
 * Swap the internal `isAdminCreated` flag for a public `source` value, so the
 * storefront can label a card without learning how the admin panel works.
 */
function withSource(review) {
  if (!review || typeof review !== 'object') return review;
  const { isAdminCreated, ...rest } = review;
  return { ...rest, source: isAdminCreated ? 'curated' : 'customer' };
}

/** `{ avgRating, totalCount }` over genuine reviews only. `scope` narrows it, e.g. { templateId }. */
async function genuineAggregate(scope = {}) {
  const agg = await prisma.templateReview.aggregate({
    where:  { ...GENUINE_REVIEW_WHERE, ...scope },
    _avg:   { rating: true },
    _count: { _all: true },
  });
  return {
    avgRating:  agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : 0,
    totalCount: agg._count._all,
  };
}

/**
 * How many visible reviews were entered through the admin panel.
 *
 * Kept because the API has always returned it and the admin finds it useful. It
 * no longer means "does not count", and the storefront no longer shows it.
 */
function countCurated(scope = {}) {
  return prisma.templateReview.count({
    where: { ...VISIBLE_REVIEW_WHERE, isAdminCreated: true, ...scope },
  });
}

/** Recompute and store `Template.avgRating` from genuine reviews. Returns the new value. */
async function recalcTemplateRating(templateId) {
  const agg = await prisma.templateReview.aggregate({
    where: { templateId, ...GENUINE_REVIEW_WHERE },
    _avg:  { rating: true },
  });
  const avgRating = agg._avg.rating || 0;
  await prisma.template.update({ where: { id: templateId }, data: { avgRating } });
  return avgRating;
}

module.exports = {
  GENUINE_REVIEW_WHERE,
  VISIBLE_REVIEW_WHERE,
  withSource,
  genuineAggregate,
  countCurated,
  recalcTemplateRating,
};
