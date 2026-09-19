/**
 * Razorpay, as a second gateway beside PayU.
 *
 * One account serves both storefronts: rupees for India, dollars for the global
 * site (which needs "international payments" enabled in the Razorpay dashboard —
 * nothing here can check that, so a USD order on an account without it fails at
 * Razorpay with its own message).
 *
 * This file deliberately mirrors payu.service.js: isConfigured / assertConfigured
 * / currencyFor / a create step / a signature check / refundPayment. The two are
 * swapped by paymentGateway.service.js, which is the only place that decides
 * which one an order uses.
 *
 * SECRETS. RAZORPAY_KEY_ID is public — it is handed to Checkout.js in the
 * buyer's browser. RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are not, and
 * nothing in this module returns them: they only ever go into an HMAC or the
 * SDK's own Basic auth header.
 *
 * WHY THE SIGNATURE CHECKS ARE HAND-ROLLED. The SDK ships equivalents, but these
 * are four lines of crypto, they use timingSafeEqual, and they can be unit
 * tested without the SDK or the network. The algorithms are Razorpay's
 * documented ones:
 *   checkout: HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
 *   webhook:  HMAC-SHA256(raw request body, WEBHOOK_SECRET)
 */
const crypto = require('crypto');
const { currencyFor: currencyForStorefront } = require('../utils/storefront');

let instance = null;

function keyId() {
  return (process.env.RAZORPAY_KEY_ID || '').trim();
}

function keySecret() {
  return (process.env.RAZORPAY_KEY_SECRET || '').trim();
}

function webhookSecret() {
  return (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
}

/**
 * True when the account is usable.
 *
 * Takes a storefront for symmetry with isPayuConfigured(storefront) so the
 * resolver can ask both gateways the same question; the answer does not depend
 * on it, because one Razorpay account serves both sites.
 */
function isRazorpayConfigured(_storefront) {
  return Boolean(keyId() && keySecret());
}

function assertRazorpayConfigured(storefront) {
  if (isRazorpayConfigured(storefront)) return;
  throw new Error('Razorpay is not configured: set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET');
}

/** The currency to charge in for this storefront — the same rule PayU follows. */
function currencyFor(storefront) {
  return currencyForStorefront(storefront);
}

/** True when a webhook can be verified at all. Without the secret we refuse every call. */
function isWebhookConfigured() {
  return Boolean(webhookSecret());
}

/** Test or live is decided by the key itself: rzp_test_… vs rzp_live_…. */
function isTestKey() {
  return keyId().startsWith('rzp_test');
}

function client() {
  if (!instance) {
    // Required lazily so a deploy without the credentials still boots; the
    // gateway resolver refuses such an order long before this runs.
    const Razorpay = require('razorpay');
    instance = new Razorpay({ key_id: keyId(), key_secret: keySecret() });
  }
  return instance;
}

/** Drops the memoised client. Only used by tests that swap the credentials. */
function resetClient() {
  instance = null;
}

/**
 * Create the Razorpay order the browser will pay against.
 *
 * `amountMinor` is an integer in the minor units of `currency` — paise for INR,
 * cents for USD — which is exactly how Payment.amount is stored, so no
 * conversion happens anywhere in this path.
 *
 * `receipt` is our own order id, which is what makes a Razorpay dashboard row
 * traceable back to a row in Payment.
 *
 * Throws on any Razorpay error. The caller creates the Payment row only after
 * this resolves, so a gateway outage leaves no stranded `pending` order behind.
 */
async function createOrder({ amountMinor, currency, receipt, notes = {} }) {
  assertRazorpayConfigured();
  const amount = Number(amountMinor);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Razorpay order amount must be a positive integer in minor units');
  }
  const order = await client().orders.create({
    amount,
    currency: String(currency || 'INR').toUpperCase(),
    // Razorpay caps this at 40 characters and rejects anything longer.
    receipt: String(receipt || '').slice(0, 40),
    notes,
  });
  return { id: order.id, amount: order.amount, currency: order.currency, status: order.status };
}

/** Constant-time compare of two hex digests of the same length. */
function sameHex(a, b) {
  try {
    const left = Buffer.from(String(a), 'hex');
    const right = Buffer.from(String(b), 'hex');
    if (left.length === 0 || left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * Verify what Checkout.js hands back to the page.
 *
 * This is the whole security of the browser-side flow: the three fields arrive
 * from the buyer's own browser and are worth nothing until this passes. A
 * mismatch must leave the order unpaid.
 */
function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const secret = keySecret();
  if (!secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return sameHex(expected, signature);
}

/**
 * Verify a webhook, over the EXACT bytes Razorpay sent.
 *
 * `rawBody` must be the untouched request body — a Buffer or the original
 * string. Anything that has been through JSON.parse and re-serialised will not
 * match, which is why the webhook route mounts its own raw body parser.
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = webhookSecret();
  if (!secret || !signature || rawBody == null) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return sameHex(expected, signature);
}

/**
 * Refund a captured payment, in the currency it was taken in.
 *
 * `paymentId` is Razorpay's pay_… id (Payment.gatewayPaymentId), never the
 * order id: an order can hold several payment attempts and only the captured
 * one can be refunded.
 */
async function refundPayment(paymentId, amountMinor) {
  assertRazorpayConfigured();
  return client().payments.refund(String(paymentId), { amount: Number(amountMinor) });
}

module.exports = {
  keyId,
  isRazorpayConfigured,
  assertRazorpayConfigured,
  isWebhookConfigured,
  isTestKey,
  currencyFor,
  createOrder,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  refundPayment,
  resetClient,
};
