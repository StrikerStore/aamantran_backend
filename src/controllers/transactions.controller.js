const prisma = require('../utils/prisma');
const { refundPayment } = require('../services/payu.service');

// GET /api/v1/transactions
async function list(req, res) {
  const { status, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = status ? { status } : {};

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
      user:     { select: { id: true, username: true, email: true, phone: true } },
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
  if (!payment.payuMihpayid) {
    return res.status(400).json({ ok: false, message: 'No PayU payment ID — cannot refund' });
  }

  const refundResult = await refundPayment(payment.payuMihpayid, payment.amount);

  await prisma.payment.update({
    where: { id: payment.id },
    data:  { status: 'refunded' },
  });

  res.json({ ok: true, data: refundResult, message: 'Refund initiated' });
}

module.exports = { list, get, refund };
