const express = require('express');
const prisma  = require('../utils/prisma');
const { verifyWebhookSignature } = require('../services/razorpay.service');

const router = express.Router();

// POST /webhooks/razorpay
// Body must be raw JSON buffer — mount in app.js with express.raw() BEFORE express.json()
router.post('/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');

  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ ok: false, message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ ok: false, message: 'Invalid JSON body' });
  }

  try {
    const type = event.event;

    // payment.captured — mark Payment as paid
    if (type === 'payment.captured') {
      const p = event.payload?.payment?.entity;
      if (p?.id) {
        await prisma.payment.updateMany({
          where: { razorpayPaymentId: p.id },
          data:  { status: 'paid' },
        });
      }
    }

    // payment_link.paid — complete a pending template swap
    if (type === 'payment_link.paid') {
      const linkId = event.payload?.payment_link?.entity?.id;

      if (linkId) {
        const swapRequest = await prisma.templateSwapRequest.findFirst({
          where: { razorpayLinkId: linkId, status: 'pending' },
        });

        if (swapRequest) {
          await prisma.event.update({
            where: { id: swapRequest.eventId },
            data:  { templateId: swapRequest.toTemplateId },
          });
          if (swapRequest.pairedEventId) {
            await prisma.event.update({
              where: { id: swapRequest.pairedEventId },
              data:  { templateId: swapRequest.toTemplateId },
            });
          }

          await prisma.templateSwapRequest.update({
            where: { id: swapRequest.id },
            data:  { status: 'paid' },
          });

          const p = event.payload?.payment?.entity;
          if (p?.id) {
            await prisma.payment.create({
              data: {
                userId:           swapRequest.userId,
                eventId:          swapRequest.eventId,
                templateId:       swapRequest.toTemplateId,
                razorpayPaymentId: p.id,
                amount:           swapRequest.balanceAmount,
                status:           'paid',
              },
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error processing event:', err.message);
    return res.status(500).json({ ok: false, message: 'Webhook processing error' });
  }

  res.json({ ok: true });
});

module.exports = router;
