/**
 * Recompute every Template.avgRating from genuine reviews only.
 *
 * Ratings used to include admin-created (curated) reviews, so stored averages
 * are wrong for any template that has one. Run once after deploying the
 * reviewAggregates change; safe to re-run at any time.
 *
 * Usage: node scripts/backfill-review-ratings.js
 */
const prisma = require('../src/utils/prisma');
const { recalcTemplateRating } = require('../src/utils/reviewAggregates');

async function main() {
  const templates = await prisma.template.findMany({
    select: { id: true, name: true, slug: true, avgRating: true },
    orderBy: { name: 'asc' },
  });

  let changed = 0;
  for (const t of templates) {
    const before = Number(t.avgRating) || 0;
    const after  = Number(await recalcTemplateRating(t.id)) || 0;
    if (before.toFixed(2) !== after.toFixed(2)) {
      changed++;
      console.log(`${t.name} (${t.slug}): ${before.toFixed(2)} -> ${after.toFixed(2)}`);
    }
  }

  console.log(`\n${changed} of ${templates.length} template ratings updated.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
