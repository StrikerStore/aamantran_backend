const prisma = require('../utils/prisma');
const { refundPayment } = require('../services/payu.service');
const razorpay = require('../services/razorpay.service');
const { RAZORPAY } = require('../services/paymentGateway.service');
const { EXCLUDE_TEST_OWNER } = require('../utils/testFilters');

const STATUSES = ['pending', 'paid', 'failed', 'refunded'];
const GATEWAYS = ['payu', 'razorpay'];
const STOREFRONTS = ['IN', 'INTL'];
const CURRENCIES = ['INR', 'USD'];

/** A whitelisted value, or undefined — an unknown filter shows everything rather than nothing. */
function oneOf(raw, allowed) {
  const value = String(raw || '').trim();
  return allowed.includes(value) ? value : undefined;
}

/** YYYY-MM-DD → a Date at the start or end of that UTC day. Invalid input is ignored. */
function dayBound(raw, end) {
  const value = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The filters behind the transactions list, the totals and the CSV export —
 * one function, so an export can never cover a different set of orders than the
 * table it was taken from.
 *
 * `q` searches the identifiers someone actually arrives with: the order id from
 * a customer's email, the address they paid with, their username, the
 * invitation's link, or a gateway reference from a bank statement.
 */
function listWhere(query) {
  const q = String(query.q || '').trim().slice(0, 120);
  const from = dayBound(query.from, false);
  const to = dayBound(query.to, true);

  return {
    ...EXCLUDE_TEST_OWNER,
    ...(oneOf(query.status, STATUSES) ? { status: oneOf(query.status, STATUSES) } : {}),
    ...(oneOf(query.gateway, GATEWAYS) ? { gateway: oneOf(query.gateway, GATEWAYS) } : {}),
    ...(oneOf(query.storefront, STOREFRONTS) ? { storefront: oneOf(query.storefront, STOREFRONTS) } : {}),
    ...(oneOf(query.currency, CURRENCIES) ? { currency: oneOf(query.currency, CURRENCIES) } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(q
      ? {
          OR: [
            { orderId: { contains: q } },
            { customerEmail: { contains: q } },
            { gatewayOrderId: { contains: q } },
            { gatewayPaymentId: { contains: q } },
            { payuTxnId: { contains: q } },
            { couponCode: { contains: q } },
            { user: { is: { email: { contains: q } } } },
            { user: { is: { username: { contains: q } } } },
            { event: { is: { slug: { contains: q } } } },
          ],
        }
      : {}),
  };
}

/**
 * Money taken, per currency.
 *
 * NEVER a single number: Payment.amount is in the minor units of its own
 * currency, so adding a rupee row to a dollar row produces a figure that means
 * nothing. Refunded orders are counted separately rather than netted off, so a
 * refund never silently shrinks a day's revenue without saying why.
 */
async function totalsFor(where) {
  const rows = await prisma.payment.groupBy({
    by: ['currency', 'status'],
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });

  const byCurrency = new Map();
  for (const row of rows) {
    const key = row.currency || 'INR';
    const entry = byCurrency.get(key) || { currency: key, paidAmount: 0, paidOrders: 0, refundedAmount: 0, refundedOrders: 0, orders: 0 };
    entry.orders += row._count._all;
    if (row.status === 'paid') {
      entry.paidAmount += row._sum.amount || 0;
      entry.paidOrders += row._count._all;
    }
    if (row.status === 'refunded') {
      entry.refundedAmount += row._sum.amount || 0;
      entry.refundedOrders += row._count._all;
    }
    byCurrency.set(key, entry);
  }
  return [...byCurrency.values()].sort((a, b) => b.paidAmount - a.paidAmount);
}

// GET /api/v1/transactions
async function list(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const where = listWhere(req.query);

  const [payments, total, totals] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user:     { select: { id: true, username: true, email: true } },
        template: { select: { id: true, name: true } },
        event:    { select: { id: true, slug: true, brideName: true, groomName: true } },
      },
    }),
    prisma.payment.count({ where }),
    totalsFor(where),
  ]);

  res.json({ ok: true, data: payments, total, page, limit, totals });
}

// The export is a convenience, not a backup: a cap keeps one click from pulling
// the whole table into memory and out through the browser.
const EXPORT_MAX_ROWS = 5000;

/**
 * One CSV cell.
 *
 * Fields here are typed by customers, and a spreadsheet treats a cell starting
 * with = + - or @ as a formula — so those are prefixed with a quote. Quotes and
 * newlines are escaped the ordinary CSV way.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

// GET /api/v1/transactions/export — the filtered list as CSV
async function exportCsv(req, res) {
  const where = listWhere(req.query);
  const payments = await prisma.payment.findMany({
    where,
    take: EXPORT_MAX_ROWS,
    orderBy: { createdAt: 'desc' },
    include: {
      user:     { select: { username: true, email: true } },
      template: { select: { name: true } },
      event:    { select: { slug: true } },
    },
  });

  const header = [
    'Order ID', 'Date', 'Status', 'Storefront', 'Gateway', 'Currency',
    'Amount (minor units)', 'Amount', 'GST', 'Discount', 'Coupon',
    'Customer email', 'Username', 'Template', 'Invitation', 'Country',
    'Gateway order', 'Gateway payment',
  ];

  const lines = [header.map(csvCell).join(',')];
  for (const p of payments) {
    lines.push([
      p.orderId,
      p.createdAt.toISOString(),
      p.status,
      p.storefront,
      p.gateway,
      p.currency,
      p.amount,
      // The same figure in major units, because a spreadsheet full of paise is
      // no use to anyone reconciling a bank statement.
      (p.amount / 100).toFixed(2),
      ((p.gstAmount || 0) / 100).toFixed(2),
      ((p.discountAmount || 0) / 100).toFixed(2),
      p.couponCode,
      p.customerEmail || p.user?.email,
      p.user?.username,
      p.template?.name,
      p.event?.slug ? `/${p.event.slug}` : '',
      p.countryCode,
      p.gatewayOrderId || p.payuTxnId,
      p.gatewayPaymentId || p.payuMihpayid,
    ].map(csvCell).join(','));
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="aamantran-transactions-${stamp}.csv"`);
  // Excel opens a plain UTF-8 CSV as Windows-1252 and mangles ₹ and any
  // non-ASCII name; the BOM is what stops that.
  res.send('﻿' + lines.join('\r\n') + '\r\n');
}

// GET /api/v1/transactions/:id
async function get(req, res) {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: req.params.id },
    include: {
      user:     { select: { id: true, username: true, email: true, phone: true, phoneCountryCode: true } },
      template: { select: { id: true, name: true, slug: true, price: true } },
      event:    { select: { id: true, slug: true, brideName: true, groomName: true, isPublished: true } },
    },
  });

  res.json({ ok: true, data: payment });
}

// POST /api/v1/transactions/:id/refund
async function refund(req, res) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: req.params.id } });

  if (payment.status === 'refunded') {
    return res.status(409).json({ ok: false, message: 'Payment already refunded' });
  }

  // Refund through the gateway that actually took the money -- and, for PayU,
  // the merchant account that settled it. The other gateway, or the other PayU
  // account, has no record of the transaction.
  const isRazorpay = String(payment.gateway || 'payu') === RAZORPAY;
  // gatewayPaymentId mirrors payuMihpayid on PayU orders; the fallback covers a
  // row written before that column existed.
  const reference = payment.gatewayPaymentId || payment.payuMihpayid;

  if (!reference) {
    return res.status(400).json({
      ok: false,
      message: `No ${isRazorpay ? 'Razorpay' : 'PayU'} payment ID — cannot refund`,
    });
  }
  if (isRazorpay && !razorpay.isRazorpayConfigured()) {
    return res.status(503).json({ ok: false, message: 'Razorpay is not configured on this server' });
  }

  const refundResult = isRazorpay
    ? await razorpay.refundPayment(reference, payment.amount)
    : await refundPayment(reference, payment.amount, payment.storefront);

  await prisma.payment.update({
    where: { id: payment.id },
    data:  { status: 'refunded' },
  });

  res.json({ ok: true, data: refundResult, message: 'Refund initiated' });
}

module.exports = { list, get, refund, exportCsv };
