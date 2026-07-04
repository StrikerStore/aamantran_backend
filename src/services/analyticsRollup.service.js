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

/** Aggregate one UTC day of raw events/sessions into a WebsiteDailyStat row. */
async function rollupDay(dayStart) {
  const dayEnd = new Date(addDays(dayStart, 1).getTime() - 1);
  const sessionWhere = { firstSeenAt: { gte: dayStart, lte: dayEnd } };

  const [visitors, pageViews, sourceRows, deviceRows, countryRows, conversionRaw] = await Promise.all([
    prisma.websiteSession.count({ where: sessionWhere }),
    prisma.websiteEvent.count({ where: { type: 'pageview', createdAt: { gte: dayStart, lte: dayEnd } } }),
    prisma.websiteSession.groupBy({ by: ['utmSource', 'referrer'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['deviceType'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['country'], where: sessionWhere, _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT type, COUNT(DISTINCT sessionId) AS c
      FROM WebsiteEvent
      WHERE type <> 'pageview' AND createdAt >= ${dayStart} AND createdAt <= ${dayEnd}
      GROUP BY type`,
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
    where: { date: dayStart },
    create: { date: dayStart, ...data },
    update: data,
  });
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

module.exports = { runWebsiteAnalyticsRollupJob, pruneOldWebsiteData, rollupDay };
