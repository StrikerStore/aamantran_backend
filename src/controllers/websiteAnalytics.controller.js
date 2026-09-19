const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { EXCLUDE_TEST_OWNER } = require('../utils/testFilters');

const MAX_RANGE_DAYS = 92;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const { FUNNEL_STAGES } = require('../lib/analyticsEvents');

/** Parse ?from&to (YYYY-MM-DD) into a UTC day-aligned range, default last 30 days. */
function parseRange(query) {
  const now = new Date();
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now;
  const from = query.from
    ? new Date(`${query.from}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
  const maxFrom = new Date(to.getTime() - MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from: from < maxFrom ? maxFrom : from, to };
}

/**
 * ?storefront=IN|INTL, or null for both combined.
 *
 * Anything unrecognised -- including the empty string the admin sends for "All"
 * -- means no filter, so a malformed value shows more data rather than silently
 * showing one site's numbers as if they were the whole business.
 */
function parseStorefront(query) {
  const raw = String(query.storefront || '').trim().toUpperCase();
  return raw === 'IN' || raw === 'INTL' ? raw : null;
}

/**
 * Prisma `where` fragment for sessions on this storefront.
 *
 * Sessions recorded before the global site existed have a NULL storefront, and
 * every one of them was India traffic -- so 'IN' must include NULLs or the
 * India view would appear to start from nothing on the day this shipped.
 */
function sessionStorefrontWhere(storefront) {
  if (!storefront) return {};
  if (storefront === 'INTL') return { storefront: 'INTL' };
  return { OR: [{ storefront: 'IN' }, { storefront: null }] };
}

/** The same rule as raw SQL, for the two aggregates that need a join. */
function sqlStorefrontClause(storefront, alias) {
  if (!storefront) return Prisma.empty;
  if (storefront === 'INTL') return Prisma.sql`AND ${Prisma.raw(alias)}.storefront = 'INTL'`;
  return Prisma.sql`AND (${Prisma.raw(alias)}.storefront = 'IN' OR ${Prisma.raw(alias)}.storefront IS NULL)`;
}

/** Payments carry their own storefront column, and it is never null. */
function paymentStorefrontWhere(storefront) {
  return storefront ? { storefront } : {};
}

function groupCount(rows, labelFn) {
  const acc = new Map();
  for (const r of rows) {
    const label = labelFn(r);
    acc.set(label, (acc.get(label) || 0) + r._count._all);
  }
  return [...acc.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

async function getSummary(req, res) {
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ ok: false, message: 'Invalid date range' });
  const { from, to } = range;

  const storefront = parseStorefront(req.query);
  const sfSession  = sessionStorefrontWhere(storefront);
  const sfPayment  = paymentStorefrontWhere(storefront);

  const sessionWhere = { firstSeenAt: { gte: from, lte: to }, ...sfSession };
  // WebsiteEvent has no storefront of its own; it inherits the one on its
  // session, so event queries filter through the relation.
  const eventWhere = (extra = {}) => ({
    ...extra,
    createdAt: { gte: from, lte: to },
    ...(storefront ? { session: sfSession } : {}),
  });
  const sfSql = sqlStorefrontClause(storefront, 's');

  const [
    visitors,
    pageViews,
    liveVisitors,
    timeseriesRaw,
    sourceRows,
    countryRows,
    cityRows,
    deviceRows,
    browserRows,
    pageRows,
    funnelRaw,
    paidOrders,
  ] = await Promise.all([
    prisma.websiteSession.count({ where: sessionWhere }),
    prisma.websiteEvent.count({ where: eventWhere({ type: 'pageview' }) }),
    prisma.websiteSession.count({
      where: { lastSeenAt: { gte: new Date(Date.now() - LIVE_WINDOW_MS) }, ...sfSession },
    }),
    prisma.$queryRaw`
      SELECT DATE(e.createdAt) AS d, COUNT(*) AS pv, COUNT(DISTINCT e.sessionId) AS v
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.type = 'pageview' AND e.createdAt >= ${from} AND e.createdAt <= ${to} ${sfSql}
      GROUP BY DATE(e.createdAt) ORDER BY d ASC`,
    prisma.websiteSession.groupBy({ by: ['utmSource', 'referrer'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['country'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['country', 'region', 'city'], where: { ...sessionWhere, city: { not: null } }, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['deviceType'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['browser'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteEvent.groupBy({
      by: ['path'],
      where: eventWhere({ type: 'pageview' }),
      _count: { _all: true },
      orderBy: { _count: { path: 'desc' } },
      take: 12,
    }),
    prisma.$queryRaw`
      SELECT e.type, COUNT(DISTINCT e.sessionId) AS c
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.createdAt >= ${from} AND e.createdAt <= ${to} ${sfSql}
      GROUP BY e.type`,
    prisma.payment.count({ where: { status: 'paid', createdAt: { gte: from, lte: to }, ...sfPayment, ...EXCLUDE_TEST_OWNER } }),
  ]);

  const funnelCounts = Object.fromEntries(funnelRaw.map((r) => [r.type, Number(r.c)]));
  const purchases = funnelCounts.purchase || 0;

  res.json({
    ok: true,
    range: { from: from.toISOString(), to: to.toISOString() },
    storefront: storefront || 'ALL',
    overview: {
      visitors,
      pageViews,
      liveVisitors,
      avgPagesPerVisit: visitors ? Number((pageViews / visitors).toFixed(2)) : 0,
      purchases,
      paidOrders,
      conversionRate: visitors ? Number(((paidOrders / visitors) * 100).toFixed(2)) : 0,
    },
    timeseries: timeseriesRaw.map((r) => ({
      date: r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d),
      pageViews: Number(r.pv),
      visitors: Number(r.v),
    })),
    sources: groupCount(sourceRows, (r) => r.utmSource || r.referrer || '(direct)').slice(0, 15),
    geo: {
      countries: groupCount(countryRows, (r) => r.country || 'Unknown'),
      cities: cityRows
        .map((r) => ({ country: r.country, region: r.region, city: r.city, count: r._count._all }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15),
    },
    devices: groupCount(deviceRows, (r) => r.deviceType || 'Unknown'),
    browsers: groupCount(browserRows, (r) => r.browser || 'Unknown').slice(0, 8),
    pages: pageRows.map((r) => ({ path: r.path, views: r._count._all })),
    funnel: [
      { stage: 'Visitors', sessions: visitors },
      ...FUNNEL_STAGES.map((stage) => ({ stage, sessions: funnelCounts[stage] || 0 })),
    ],
  });
}

async function getLive(req, res) {
  const since = new Date(Date.now() - LIVE_WINDOW_MS);
  const storefront = parseStorefront(req.query);
  const sfSession = sessionStorefrontWhere(storefront);

  const [liveVisitors, pathRows] = await Promise.all([
    prisma.websiteSession.count({ where: { lastSeenAt: { gte: since }, ...sfSession } }),
    prisma.websiteEvent.groupBy({
      by: ['path'],
      where: {
        type: 'pageview',
        createdAt: { gte: since },
        ...(storefront ? { session: sfSession } : {}),
      },
      _count: { _all: true },
      orderBy: { _count: { path: 'desc' } },
      take: 10,
    }),
  ]);
  res.json({
    ok: true,
    storefront: storefront || 'ALL',
    liveVisitors,
    activePages: pathRows.map((r) => ({ path: r.path, views: r._count._all })),
  });
}

// parseRange/parseStorefront/sessionStorefrontWhere are exported so the business
// dashboard applies exactly the same range cap and storefront rule — including
// counting NULL-storefront sessions as India — rather than a second copy of it.
module.exports = { getSummary, getLive, parseRange, parseStorefront, sessionStorefrontWhere };
