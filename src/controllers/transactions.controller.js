const prisma = require('../utils/prisma');
const { refundPayment } = require('../services/payu.service');
const razorpay = require('../services/razorpay.service');
const { RAZORPAY } = require('../services/paymentGateway.service');
const { EXCLUDE_TEST_OWNER } = require('../utils/testFilters');

// GET /api/v1/transactions
async function list(req, res) {
  const { status, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = { ...(status ? { status } : {}), ...EXCLUDE_TEST_OWNER };

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take:    Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        user:     { select: { id: true, username: true, email: true } },
        template: { select: { id: true, name: true } },
        event:    { select: { id: true, slug: true, brideName: true, groomName: true } },
      },
    }),
    prisma.payment.count({ where }),
  ]);

  res.json({ ok: true, data: payments, total, page: Number(page), limit: Number(limit) });
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

module.exports = { list, get, refund };
