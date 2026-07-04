const prisma = require('../utils/prisma');

const MAX_RANGE_DAYS = 92;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const FUNNEL_STAGES = ['view_template', 'initiate_checkout', 'purchase', 'register_complete'];

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
  const sessionWhere = { firstSeenAt: { gte: from, lte: to } };

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
    prisma.websiteEvent.count({ where: { type: 'pageview', createdAt: { gte: from, lte: to } } }),
    prisma.websiteSession.count({ where: { lastSeenAt: { gte: new Date(Date.now() - LIVE_WINDOW_MS) } } }),
    prisma.$queryRaw`
      SELECT DATE(createdAt) AS d, COUNT(*) AS pv, COUNT(DISTINCT sessionId) AS v
      FROM WebsiteEvent
      WHERE type = 'pageview' AND createdAt >= ${from} AND createdAt <= ${to}
      GROUP BY DATE(createdAt) ORDER BY d ASC`,
    prisma.websiteSession.groupBy({ by: ['utmSource', 'referrer'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['country'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['country', 'region', 'city'], where: { ...sessionWhere, city: { not: null } }, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['deviceType'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteSession.groupBy({ by: ['browser'], where: sessionWhere, _count: { _all: true } }),
    prisma.websiteEvent.groupBy({
      by: ['path'],
      where: { type: 'pageview', createdAt: { gte: from, lte: to } },
      _count: { _all: true },
      orderBy: { _count: { path: 'desc' } },
      take: 12,
    }),
    prisma.$queryRaw`
      SELECT type, COUNT(DISTINCT sessionId) AS c
      FROM WebsiteEvent
      WHERE createdAt >= ${from} AND createdAt <= ${to}
      GROUP BY type`,
    prisma.payment.count({ where: { status: 'paid', createdAt: { gte: from, lte: to } } }),
  ]);

  const funnelCounts = Object.fromEntries(funnelRaw.map((r) => [r.type, Number(r.c)]));
  const purchases = funnelCounts.purchase || 0;

  res.json({
    ok: true,
    range: { from: from.toISOString(), to: to.toISOString() },
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
  const [liveVisitors, pathRows] = await Promise.all([
    prisma.websiteSession.count({ where: { lastSeenAt: { gte: since } } }),
    prisma.websiteEvent.groupBy({
      by: ['path'],
      where: { type: 'pageview', createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { path: 'desc' } },
      take: 10,
    }),
  ]);
  res.json({
    ok: true,
    liveVisitors,
    activePages: pathRows.map((r) => ({ path: r.path, views: r._count._all })),
  });
}

module.exports = { getSummary, getLive };
