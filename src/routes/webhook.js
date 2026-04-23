const express = require('express');
const prisma  = require('../utils/prisma');
const { verifyResponseHash } = require('../services/payu.service');

const router = express.Router();

/**
 * POST /webhooks/payu
 *
 * PayU IPN (Instant Payment Notification) — identical hash algorithm
 * to the redirect callback.  PayU sends application/x-www-form-urlencoded
 * so this must be mounted AFTER express.urlencoded() in app.js.
 *
 * Handles:
 *  - Direct template purchases (payuTxnId on Payment)
 *  - Template swap balance payments (payuLinkId on TemplateSwapRequest)
 */
router.post('/payu', async (req, res) => {
  // PayU IPN sends form-encoded data
  const params = req.body || {};

  if (!verifyResponseHash(params)) {
    return res.status(400).json({ ok: false, message: 'Invalid hash' });
  }

  const { txnid, mihpayid, status } = params;

  if (status !== 'success') {
    // Non-success IPN — mark payment as failed if still pending
    try {
      if (txnid) {
        await prisma.payment.updateMany({
          where: { payuTxnId: txnid, status: 'pending' },
          data:  { status: 'failed' },
        });
      }
    } catch {
      // best-effort
    }
    return res.json({ ok: true });
  }

  try {
    // 1. Try direct template purchase
    const payment = await prisma.payment.findFirst({
      where: { payuTxnId: txnid },
    });

    if (payment && payment.status !== 'paid') {
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: payment.id },
          data:  { status: 'paid', payuMihpayid: mihpayid || null },
        }),
        prisma.template.update({
          where: { id: payment.templateId },
          data:  { buyerCount: { increment: 1 } },
        }),
      ]);
    }

    // 2. Try swap payment
    const swap = await prisma.templateSwapRequest.findFirst({
      where: { payuLinkId: txnid, status: 'pending' },
    });

    if (swap) {
      const toTemplate = await prisma.template.findUnique({
        where:  { id: swap.toTemplateId },
        select: { currentVersionId: true },
      });
      const swapData = {
        templateId:        swap.toTemplateId,
        templateVersionId: toTemplate?.currentVersionId || null,
      };
      await prisma.event.update({ where: { id: swap.eventId }, data: swapData });
      if (swap.pairedEventId) {
        await prisma.event.update({ where: { id: swap.pairedEventId }, data: swapData });
      }
      await prisma.templateSwapRequest.update({
        where: { id: swap.id },
        data:  { status: 'paid' },
      });

      // Create payment record if not already created by the redirect handler
      const existing = await prisma.payment.findFirst({ where: { payuTxnId: txnid } });
      if (!existing && mihpayid) {
        await prisma.payment.create({
          data: {
            userId:       swap.userId,
            eventId:      swap.eventId,
            templateId:   swap.toTemplateId,
            payuTxnId:    txnid,
            payuMihpayid: mihpayid,
            amount:       swap.balanceAmount,
            status:       'paid',
          },
        });
        // Only increment buyerCount when we're creating the record for the first time
        await prisma.template.update({
          where: { id: swap.toTemplateId },
          data:  { buyerCount: { increment: 1 } },
        });
      }
    }
  } catch (err) {
    console.error('[Webhook/PayU] Error processing IPN:', err.message);
    return res.status(500).json({ ok: false, message: 'IPN processing error' });
  }

  res.json({ ok: true });
});

module.exports = router;
