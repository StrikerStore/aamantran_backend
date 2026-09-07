const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');

const RAW_RETENTION_DAYS = 90;
const MAX_DAYS_PER_RUN = 120;

function utcDayStart(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

function toCountMap(rows, labelFn) {
  const acc = {};
  for (const r of rows) {
    const label = labelFn(r);
    acc[label] = (acc[label] || 0) + r._count._all;
  }
  return acc;
}

// The two websites roll up separately so the admin filter can show either on
// its own or both together.
const STOREFRONTS = ['IN', 'INTL'];

/**
 * Sessions belonging to one storefront.
 *
 * Rows predating the global site have a NULL storefront and were all India
 * traffic, so 'IN' must include them -- otherwise every historical day would
 * roll up as zero visitors the moment this shipped.
 */
function sessionStorefrontWhere(storefront) {
  return storefront === 'INTL'
    ? { storefront: 'INTL' }
    : { OR: [{ storefront: 'IN' }, { storefront: null }] };
}

/** The same rule as raw SQL, for the conversion aggregate that needs a join. */
function sqlStorefrontClause(storefront) {
  return storefront === 'INTL'
    ? Prisma.sql`AND s.storefront = 'INTL'`
    : Prisma.sql`AND (s.storefront = 'IN' OR s.storefront IS NULL)`;
}

/** Aggregate one UTC day for one storefront into a WebsiteDailyStat row. */
async function rollupDayForStorefront(dayStart, storefront) {
  const dayEnd = new Date(addDays(dayStart, 1).getTime() - 1);
  const sfSession = sessionStorefrontWhere(storefront);
  const sessionWhere = { firstSeenAt: { gte: dayStart, lte: dayEnd }, ...sfSession };
  // WebsiteEvent has no storefront column; it inherits its session's.
  const eventWhere = { createdAt: { gte: dayStart, lte: dayEnd }, session: sfSession };
  const sfSql = sqlStorefrontClause(storefront);

  const [visitors, pageViews, sourceRows, deviceRows, countryRows, conversionRaw] = await Promise.all([
    prisma.websiteSession.count({ where: sessionWhere }),
    prisma.websiteEvent.count({ where: { type: 'pageview', ...eventWhere } }),
    prisma.websiteSession.groupBy({ by: ['utmSource', 'referrer'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['deviceType'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['country'], where: sessionWhere, _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT e.type, COUNT(DISTINCT e.sessionId) AS c
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.type <> 'pageview' AND e.createdAt >= ${dayStart} AND e.createdAt <= ${dayEnd} ${sfSql}
      GROUP BY e.type`,
  ]);

  const data = {
    visitors,
    pageViews,
    sources: toCountMap(sourceRows, (r) => r.utmSource || r.referrer || '(direct)'),
    devices: toCountMap(deviceRows, (r) => r.deviceType || 'Unknown'),
    countries: toCountMap(countryRows, (r) => r.country || 'Unknown'),
    conversions: Object.fromEntries(conversionRaw.map((r) => [r.type, Number(r.c)])),
  };

  await prisma.websiteDailyStat.upsert({
    where:  { date_storefront: { date: dayStart, storefront } },
    create: { date: dayStart, storefront, ...data },
    update: data,
  });
}

/**
 * Aggregate one UTC day, one row per storefront.
 *
 * A day with no international traffic still gets an explicit zero row rather
 * than no row, so a chart reads as "nobody came" instead of a gap.
 */
async function rollupDay(dayStart) {
  for (const storefront of STOREFRONTS) {
    await rollupDayForStorefront(dayStart, storefront);
  }
}

/**
 * Roll up every completed day that doesn't have a stat row yet
 * (idempotent — safe to re-run, backfills after downtime).
 */
async function runWebsiteAnalyticsRollupJob() {
  const today = utcDayStart(new Date());
  let cursor;

  const latest = await prisma.websiteDailyStat.findFirst({ orderBy: { date: 'desc' } });
  if (latest) {
    cursor = addDays(utcDayStart(latest.date), 1);
  } else {
    const oldest = await prisma.websiteEvent.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    if (!oldest) return;
    cursor = utcDayStart(oldest.createdAt);
  }

  let processed = 0;
  while (cursor < today && processed < MAX_DAYS_PER_RUN) {
    await rollupDay(cursor);
    cursor = addDays(cursor, 1);
    processed++;
  }
  if (processed) console.log(`[analytics] rolled up ${processed} day(s)`);
}

/** Delete raw events/sessions older than the retention window (rollups keep history). */
async function pruneOldWebsiteData() {
  const cutoff = new Date(Date.now() - RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const events = await prisma.websiteEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const sessions = await prisma.websiteSession.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
  if (events.count || sessions.count) {
    console.log(`[analytics] pruned ${events.count} events, ${sessions.count} sessions`);
  }
}

module.exports = { runWebsiteAnalyticsRollupJob, pruneOldWebsiteData, rollupDay, rollupDayForStorefront };
