/**
 * POST /webhooks/razorpay
 *
 * Razorpay's server-to-server notification, and the reason a buyer who pays and
 * then closes the tab still gets their invitation. The browser normally
 * confirms the payment itself (POST /api/checkout/razorpay-verify); this is the
 * backstop for when it cannot, exactly as PayU's IPN is for PayU.
 *
 * THE SIGNATURE IS OVER THE RAW BYTES. Razorpay signs the request body
 * character for character, so this router is mounted with its own
 * `express.raw()` parser in app.js, BEFORE the JSON parser. Parsing and
 * re-serialising the body changes the bytes and every signature would fail.
 *
 * Without RAZORPAY_WEBHOOK_SECRET set, every call is refused. An unverified
 * webhook is an open "mark this order paid" endpoint, so treating a missing
 * secret as "allow" would be worse than being down.
 */
const express = require('express');
const prisma = require('../utils/prisma');
const razorpay = require('../services/razorpay.service');
const { markPaymentPaid, markPaymentFailed } = require('../services/payment.service');

const router = express.Router();

/** The payment entity out of a Razorpay event payload, whatever the event. */
function paymentEntityOf(event) {
  return event?.payload?.payment?.entity || null;
}

router.post('/', async (req, res) => {
  if (!razorpay.isWebhookConfigured()) {
    console.error('[Webhook/Razorpay] RAZORPAY_WEBHOOK_SECRET is not set; refusing');
    return res.status(503).json({ ok: false, message: 'Webhook not configured' });
  }

  const signature = req.get('x-razorpay-signature');
  // req.body is a Buffer here, from express.raw(). Anything else means the
  // mount order in app.js has been changed and the signature cannot be trusted.
  if (!Buffer.isBuffer(req.body)) {
    console.error('[Webhook/Razorpay] body is not raw; check the mount order in app.js');
    return res.status(500).json({ ok: false, message: 'Webhook misconfigured' });
  }
  if (!razorpay.verifyWebhookSignature(req.body, signature)) {
    return res.status(400).json({ ok: false, message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, message: 'Invalid payload' });
  }

  const entity = paymentEntityOf(event);
  const orderRef = entity && entity.order_id;
  // Nothing to match on. Answered 200 so Razorpay stops retrying an event we
  // will never be able to act on.
  if (!orderRef) return res.json({ ok: true });

  try {
    const payment = await prisma.payment.findFirst({
      where: { gatewayOrderId: String(orderRef), gateway: 'razorpay' },
    });
    if (!payment) return res.json({ ok: true });

    switch (event.event) {
      case 'payment.captured':
        if (payment.status !== 'paid') await markPaymentPaid(payment, entity.id);
        break;
      case 'payment.failed':
        // Only a still-pending order; a failed attempt after a successful one
        // must not un-sell a paid invitation.
        await markPaymentFailed({ id: payment.id });
        break;
      default:
        break;
    }
  } catch (err) {
    console.error('[Webhook/Razorpay] error processing event:', err.message);
    // 500 asks Razorpay to retry, which is what we want for a transient
    // database failure on a payment that has really been taken.
    return res.status(500).json({ ok: false, message: 'Webhook processing error' });
  }

  return res.json({ ok: true });
});

module.exports = router;
