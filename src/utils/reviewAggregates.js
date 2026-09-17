/**
 * One definition of which reviews count toward a public rating.
 *
 * Admin-created reviews are seeded by the team, not submitted by customers.
 * They stay visible on the store — labelled as curated — but they must never
 * move an average, a review count or the AggregateRating in structured data,
 * because that would present team-authored copy as customer evidence.
 *
 * Every rating writer and public aggregate goes through here, so the rule
 * cannot drift between the admin panel, the couple dashboard and the store.
 */
const prisma = require('./prisma');
const { EXCLUDE_TEST_OWNER } = require('./testFilters');

/** Counts toward ratings: visible, customer-submitted, not owned by a test account. */
const GENUINE_REVIEW_WHERE = { isHidden: false, isAdminCreated: false, ...EXCLUDE_TEST_OWNER };

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

/** How many visible reviews are curated — shown, but excluded from the average above. */
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
