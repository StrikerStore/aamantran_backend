const crypto = require('crypto');
const siteUrls = require('../config/siteUrls');

function merchantKey() {
  return process.env.PAYU_MERCHANT_KEY || '';
}

function merchantSalt() {
  return process.env.PAYU_MERCHANT_SALT || '';
}

/** PayU payment endpoint — test or production */
function payuPaymentUrl() {
  return (process.env.PAYU_ENV || 'prod') === 'test'
    ? 'https://test.payu.in/_payment'
    : 'https://secure.payu.in/_payment';
}

/**
 * Generate PayU payment hash.
 * SHA512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
 */
function generateHash({ txnid, amount, productinfo, firstname, email, udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '' }) {
  const key = merchantKey();
  const salt = merchantSalt();
  const parts = [key, txnid, amount, productinfo, firstname, email, udf1, udf2, udf3, udf4, udf5, '', '', '', '', '', salt];
  return crypto.createHash('sha512').update(parts.join('|')).digest('hex');
}

/**
 * Verify PayU response / IPN hash.
 * Reverse hash = SHA512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
function verifyResponseHash(params) {
  const { status, txnid, amount, productinfo, firstname, email,
          udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '', hash } = params;
  if (!hash) return false;
  const salt = merchantSalt();
  const key  = merchantKey();
  const parts = [salt, status, '', '', '', '', '', udf5, udf4, udf3, udf2, udf1, email, firstname, productinfo, amount, txnid, key];
  const expected = crypto.createHash('sha512').update(parts.join('|')).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash.toLowerCase(), 'hex'));
  } catch {
    return false;
  }
}

/**
 * Build the form parameters to POST to PayU's payment page.
 * amountPaise is integer paise (₹999 = 99900).
 */
function buildPaymentParams({ txnid, amountPaise, productinfo, firstname, email, phone, successUrl, failureUrl, udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '' }) {
  const amount = (amountPaise / 100).toFixed(2);
  const hash = generateHash({ txnid, amount, productinfo, firstname, email, udf1, udf2, udf3, udf4, udf5 });
  return {
    key:         merchantKey(),
    txnid,
    amount,
    productinfo,
    firstname,
    email,
    phone:       phone || '',
    surl:        successUrl,
    furl:        failureUrl,
    hash,
    udf1,
    udf2,
    udf3,
    udf4,
    udf5,
  };
}

/**
 * Issue a refund via PayU's cancel/refund API.
 * mihpayid — PayU's internal transaction ID returned in payment callback.
 * amountPaise — amount to refund in paise.
 */
async function refundPayment(mihpayid, amountPaise) {
  const key     = merchantKey();
  const salt    = merchantSalt();
  const command = 'cancel_refund_transaction';
  const var1    = String(mihpayid);
  const var2    = (amountPaise / 100).toFixed(2);
  const hashStr = [key, command, var1, var2, salt].join('|');
  const hash    = crypto.createHash('sha512').update(hashStr).digest('hex');

  const body = new URLSearchParams({ key, command, var1, var2, hash });
  const res  = await fetch('https://info.payu.in/merchant/postservice.php?form=2', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Create a payment link for template swap balance payments.
 * Returns { id: txnid, short_url, isPlaceholder }.
 * The short_url points to a backend page that auto-submits the PayU form.
 */
async function createPaymentLinkOrPlaceholder({ txnid, amountPaise, description, customerName, customerEmail, customerPhone, notes = {} }) {
  const hasKeys = Boolean(process.env.PAYU_MERCHANT_KEY && process.env.PAYU_MERCHANT_SALT);

  if (!hasKeys) {
    const placeholderUrl = (process.env.TEMPLATE_SWAP_PLACEHOLDER_PAY_URL || '').trim()
      || 'https://aamantran.online/configure-payu';
    return { id: `placeholder_${Date.now()}`, short_url: placeholderUrl, isPlaceholder: true };
  }

  const apiBase = siteUrls.apiBaseUrl();
  const linkUrl = `${apiBase}/api/checkout/payu-swap-link/${txnid}`;

  return { id: txnid, short_url: linkUrl, isPlaceholder: false };
}

module.exports = {
  merchantKey,
  payuPaymentUrl,
  generateHash,
  verifyResponseHash,
  buildPaymentParams,
  refundPayment,
  createPaymentLinkOrPlaceholder,
};
