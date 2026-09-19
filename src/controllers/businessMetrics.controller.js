/**
 * The numbers the dashboard should have been showing all along.
 *
 * It used to ask four list endpoints for their `total` and print those: how many
 * templates exist, how many users have registered, how many payments are paid,
 * how many tickets are open. None of that says whether the business is selling
 * anything this week.
 *
 * MONEY IS NEVER ONE NUMBER HERE. Payment.amount is in the minor units of its
 * own currency, so every revenue figure is grouped by currency and returned as a
 * list. Adding a rupee row to a dollar row would produce a total that is simply
 * false, and would look plausible.
 *
 * Refunds are reported beside revenue rather than netted out of it: a refund
 * belongs to the day it was issued, not the day the sale happened, and quietly
 * subtracting it would make a past week's revenue change after the fact.
 */
const prisma = require('../utils/prisma');
const { EXCLUDE_TEST_OWNER, EXCLUDE_SANDBOX_TEMPLATE } = require('../utils/testFilters');
const { parseRange, parseStorefront, sessionStorefrontWhere } = require('./websiteAnalytics.controller');

const TOP_TEMPLATES = 8;
/** A pending order older than this is stuck, not in progress. */
const STUCK_PENDING_MS = 60 * 60 * 1000;

function toDateKey(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

/** Revenue and order counts for one set of payments, per currency. */
function foldTotals(rows) {
  const byCurrency = new Map();
  for (const row of rows) {
    const currency = row.currency || 'INR';
    const entry = byCurrency.get(currency)
      || { currency, paidAmount: 0, paidOrders: 0, refundedAmount: 0, refundedOrders: 0 };
    if (row.status === 'paid') {
      entry.paidAmount += row._sum.amount || 0;
      entry.paidOrders += row._count._all;
    }
    if (row.status === 'refunded') {
      entry.refundedAmount += row._sum.amount || 0;
      entry.refundedOrders += row._count._all;
    }
    byCurrency.set(currency, entry);
  }
  return [...byCurrency.values()].sort((a, b) => b.paidAmount - a.paidAmount);
}

/**
 * GET /api/v1/analytics/business?from&to&storefront
 *
 * Everything the overview needs, in one request: what was sold in the period,
 * how it compares with the period before it, which designs sold, which gateway
 * took the money, and what is waiting for someone's attention.
 */
async function getBusiness(req, res) {
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ ok: false, message: 'Invalid date range' });
  const { from, to } = range;

  const storefront = parseStorefront(req.query);
  const sfPayment = storefront ? { storefront } : {};

  // The same length of time, immediately before this period, so "up or down" is
  // a comparison with something and not with an arbitrary month.
  const spanMs = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - spanMs - 1);
  const prevTo = new Date(from.getTime() - 1);

  const paymentsIn = (start, end) => ({
    createdAt: { gte: start, lte: end },
    ...sfPayment,
    ...EXCLUDE_TEST_OWNER,
  });

  const [
    currentRows,
    previousRows,
    statusRows,
    gatewayRows,
    dailyRows,
    templateRows,
    openTickets,
    paidNotOnboarded,
    stuckPending,
    visitors,
  ] = await Promise.all([
    prisma.payment.groupBy({
      by: ['currency', 'status'],
      where: paymentsIn(from, to),
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ['currency', 'status'],
      where: paymentsIn(prevFrom, prevTo),
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ['status'],
      where: paymentsIn(from, to),
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ['gateway', 'currency'],
      where: { ...paymentsIn(from, to), status: 'paid' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ['createdAt', 'currency'],
      where: { ...paymentsIn(from, to), status: 'paid' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ['templateId', 'currency'],
      where: { ...paymentsIn(from, to), status: 'paid' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.supportTicket.count({ where: { status: 'open' } }),
    // Paid, but the buyer never finished creating their account — the one
    // number here that is a to-do list rather than a statistic.
    //
    // Keyed on isOnboarded, NOT on `userId: null`. Deleting an account nulls
    // userId on its payments (they are kept for tax law), so a null owner also
    // means "this customer left" — and counting those as people to chase would
    // send mail to accounts that were deliberately erased.
    prisma.payment.count({
      where: { status: 'paid', isOnboarded: false, createdAt: { gte: from, lte: to }, ...sfPayment, ...EXCLUDE_TEST_OWNER },
    }),
    prisma.payment.count({
      where: {
        status: 'pending',
        createdAt: { gte: from, lte: new Date(Math.min(to.getTime(), Date.now() - STUCK_PENDING_MS)) },
        ...sfPayment,
        ...EXCLUDE_TEST_OWNER,
      },
    }),
    prisma.websiteSession.count({
      where: { firstSeenAt: { gte: from, lte: to }, ...sessionStorefrontWhere(storefront) },
    }),
  ]);

  // groupBy('createdAt') returns one row per distinct timestamp, so the days are
  // folded here rather than in SQL. The range is capped at 92 days, which keeps
  // this small enough to do in memory.
  const daily = new Map();
  for (const row of dailyRows) {
    const date = toDateKey(row.createdAt);
    const key = `${date}|${row.currency || 'INR'}`;
    const entry = daily.get(key) || { date, currency: row.currency || 'INR', amount: 0, orders: 0 };
    entry.amount += row._sum.amount || 0;
    entry.orders += row._count._all;
    daily.set(key, entry);
  }

  const templateIds = [...new Set(templateRows.map((r) => r.templateId))];
  const templates = templateIds.length
    ? await prisma.template.findMany({
        where: { id: { in: templateIds }, ...EXCLUDE_SANDBOX_TEMPLATE },
        select: { id: true, name: true, slug: true },
      })
    : [];
  const templateById = new Map(templates.map((t) => [t.id, t]));

  const topTemplates = templateRows
    .map((row) => ({
      id: row.templateId,
      name: templateById.get(row.templateId)?.name || 'Unknown design',
      slug: templateById.get(row.templateId)?.slug || null,
      currency: row.currency || 'INR',
      amount: row._sum.amount || 0,
      orders: row._count._all,
    }))
    .sort((a, b) => b.orders - a.orders || b.amount - a.amount)
    .slice(0, TOP_TEMPLATES);

  const statusCounts = Object.fromEntries(statusRows.map((r) => [r.status, r._count._all]));
  const paidOrders = statusCounts.paid || 0;

  res.json({
    ok: true,
    range: { from: from.toISOString(), to: to.toISOString() },
    previousRange: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
    storefront: storefront || 'ALL',
    revenue: foldTotals(currentRows),
    previousRevenue: foldTotals(previousRows),
    daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    orders: {
      paid: paidOrders,
      pending: statusCounts.pending || 0,
      failed: statusCounts.failed || 0,
      refunded: statusCounts.refunded || 0,
    },
    gateways: gatewayRows.map((row) => ({
      gateway: row.gateway || 'payu',
      currency: row.currency || 'INR',
      orders: row._count._all,
      amount: row._sum.amount || 0,
    })).sort((a, b) => b.orders - a.orders),
    topTemplates,
    conversion: {
      visitors,
      paidOrders,
      // One order per visitor session is the assumption; it is a rate, not a
      // headcount, and it is left at zero rather than dividing by nothing.
      rate: visitors ? Number(((paidOrders / visitors) * 100).toFixed(2)) : 0,
    },
    attention: { openTickets, paidNotOnboarded, stuckPending },
  });
}

module.exports = { getBusiness };
