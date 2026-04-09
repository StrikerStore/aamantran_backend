const Razorpay = require('razorpay');
const siteUrls = require('../config/siteUrls');

let _instance = null;

function getRazorpay() {
  if (!_instance) {
    _instance = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _instance;
}

/**
 * Create a Razorpay Payment Link for balance amount on template swap.
 * Returns { id, short_url } from Razorpay.
 */
async function createPaymentLink({ amountPaise, description, customerName, customerEmail, customerPhone, notes = {} }) {
  const rz = getRazorpay();
  const link = await rz.paymentLink.create({
    amount:      amountPaise,
    currency:    'INR',
    description,
    customer: {
      name:  customerName,
      email: customerEmail,
      contact: customerPhone || undefined,
    },
    notify: { email: true, sms: !!customerPhone },
    reminder_enable: true,
    notes,
    callback_url:    `${siteUrls.coupleDashboardUrl()}/payment/success`,
    callback_method: 'get',
  });
  return link;
}

/**
 * Creates a real Razorpay payment link when keys are configured; otherwise returns a placeholder
 * (or env TEMPLATE_SWAP_PLACEHOLDER_PAY_URL) so admin flows never crash in local dev.
 * @returns {Promise<{ id: string, short_url: string, isPlaceholder: boolean }>}
 */
async function createPaymentLinkOrPlaceholder({
  amountPaise,
  description,
  customerName,
  customerEmail,
  customerPhone,
  notes = {},
}) {
  const placeholderUrl =
    (process.env.TEMPLATE_SWAP_PLACEHOLDER_PAY_URL || '').trim() ||
    'https://rzp.io/i/configure-razorpay-for-template-upgrade';
  const hasKeys = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

  if (!hasKeys) {
    return {
      id:          `placeholder_${Date.now()}`,
      short_url:   placeholderUrl,
      isPlaceholder: true,
    };
  }

  try {
    const link = await createPaymentLink({
      amountPaise,
      description,
      customerName,
      customerEmail,
      customerPhone,
      notes,
    });
    return { id: link.id, short_url: link.short_url, isPlaceholder: false };
  } catch (err) {
    console.error('[Razorpay] createPaymentLink failed, using placeholder URL:', err.message);
    return {
      id:          `placeholder_${Date.now()}`,
      short_url:   placeholderUrl,
      isPlaceholder: true,
    };
  }
}

/**
 * Create a Razorpay Order for frontend checkout.js flow.
 * Returns Razorpay order object with id, amount, currency, etc.
 */
async function createOrder({ amountPaise, receipt, notes = {} }) {
  const rz = getRazorpay();
  return rz.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: receipt || `aamantran_${Date.now()}`,
    notes,
  });
}

/**
 * Fetch a Razorpay payment by ID (for transaction detail).
 */
async function fetchPayment(razorpayPaymentId) {
  const rz = getRazorpay();
  return rz.payments.fetch(razorpayPaymentId);
}

/**
 * Issue a full refund for a payment.
 */
async function refundPayment(razorpayPaymentId, amountPaise) {
  const rz = getRazorpay();
  return rz.payments.refund(razorpayPaymentId, {
    amount: amountPaise,
    speed:  'normal',
  });
}

/**
 * Verify Razorpay webhook signature.
 */
function verifyWebhookSignature(body, signature) {
  const crypto = require('crypto');
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

module.exports = {
  createPaymentLink,
  createPaymentLinkOrPlaceholder,
  createOrder,
  fetchPayment,
  refundPayment,
  verifyWebhookSignature,
};
