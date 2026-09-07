/**
 * PayU, across two merchant accounts.
 *
 * aamantran.online settles in INR through the India account; aamantranglobal.com
 * settles in USD through a second account with international payments enabled.
 * Every function here therefore takes a `storefront` and picks its credentials
 * from it, defaulting to 'IN' so the pre-existing India callers are unchanged.
 *
 * The two accounts deliberately do NOT fall back to one another. An order signed
 * with the wrong salt would either be rejected by PayU or, worse, settle into the
 * wrong merchant account -- so a missing international key is a loud failure
 * rather than a quiet redirect of someone's money.
 */
const crypto = require('crypto');
const siteUrls = require('../config/siteUrls');

const INTL = 'INTL';

function isIntl(storefront) {
  return String(storefront || 'IN').toUpperCase() === INTL;
}

function merchantKey(storefront) {
  return (isIntl(storefront)
    ? process.env.PAYU_INTL_MERCHANT_KEY
    : process.env.PAYU_MERCHANT_KEY) || '';
}

function merchantSalt(storefront) {
  return (isIntl(storefront)
    ? process.env.PAYU_INTL_MERCHANT_SALT
    : process.env.PAYU_MERCHANT_SALT) || '';
}

/** True when this storefront has a usable merchant account configured. */
function isPayuConfigured(storefront) {
  return Boolean(merchantKey(storefront) && merchantSalt(storefront));
}

/**
 * Refuse to build anything for a storefront whose account is not set up.
 * Called before a payment is initiated so the failure surfaces at checkout,
 * not as an inscrutable rejection on PayU's page.
 */
function assertPayuConfigured(storefront) {
  if (isPayuConfigured(storefront)) return;
  const which = isIntl(storefront)
    ? 'PAYU_INTL_MERCHANT_KEY / PAYU_INTL_MERCHANT_SALT'
    : 'PAYU_MERCHANT_KEY / PAYU_MERCHANT_SALT';
  throw new Error('PayU is not configured for storefront ' + storefront + ': set ' + which);
}

/** The currency PayU should charge in for this storefront. */
function currencyFor(storefront) {
  return isIntl(storefront) ? 'USD' : 'INR';
}

/**
 * PayU payment endpoint — test or production.
 * NOTE: defaults to production, so a missing PAYU_ENV points at live PayU.
 */
function payuPaymentUrl() {
  return (process.env.PAYU_ENV || 'prod') === 'test'
    ? 'https://test.payu.in/_payment'
    : 'https://secure.payu.in/_payment';
}

/**
 * Generate PayU payment hash.
 * SHA512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
 *
 * `currency` is deliberately absent: PayU does not include it in the hash.
 */
function generateHash({ txnid, amount, productinfo, firstname, email, udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '' }, storefront) {
  const key = merchantKey(storefront);
  const salt = merchantSalt(storefront);
  const parts = [key, txnid, amount, productinfo, firstname, email, udf1, udf2, udf3, udf4, udf5, '', '', '', '', '', salt];
  return crypto.createHash('sha512').update(parts.join('|')).digest('hex');
}

/**
 * Verify PayU response / IPN hash.
 * Reverse hash = SHA512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 *
 * The caller must pass the storefront of the payment being verified, which means
 * looking the payment up by txnid FIRST. udf1 carries the storefront and is
 * inside the signed hash, but it cannot be trusted until the signature checks
 * out -- and checking the signature is what needs the salt. The stored row is
 * the only source that is already trustworthy.
 */
function verifyResponseHash(params, storefront) {
  const { status, txnid, amount, productinfo, firstname, email,
          udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '', hash } = params;
  if (!hash) return false;
  const salt = merchantSalt(storefront);
  const key  = merchantKey(storefront);
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
 *
 * `amountMinor` is an integer in the minor units of the storefront currency:
 * paise for INR (INR 999 = 99900), cents for USD ($59.99 = 5999).
 *
 * udf1 carries the storefront so the success and failure callbacks can send the
 * buyer back to the site they actually bought from. It is inside the signed
 * hash, so it cannot be tampered with in transit.
 */
function buildPaymentParams({ txnid, amountMinor, productinfo, firstname, email, phone, successUrl, failureUrl, storefront = 'IN', udf2 = '', udf3 = '', udf4 = '', udf5 = '' }) {
  assertPayuConfigured(storefront);

  const amount = (amountMinor / 100).toFixed(2);
  const udf1 = String(storefront || 'IN').toUpperCase();
  const hash = generateHash({ txnid, amount, productinfo, firstname, email, udf1, udf2, udf3, udf4, udf5 }, storefront);
  return {
    key:         merchantKey(storefront),
    txnid,
    amount,
    currency:    currencyFor(storefront),
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
 * amountMinor — amount to refund, in the minor units of the payment's currency.
 * storefront — which merchant account settled the original payment. Refunding
 * through the other account cannot work: PayU does not know the transaction.
 */
async function refundPayment(mihpayid, amountMinor, storefront = 'IN') {
  const key     = merchantKey(storefront);
  const salt    = merchantSalt(storefront);
  const command = 'cancel_refund_transaction';
  const var1    = String(mihpayid);
  const var2    = (amountMinor / 100).toFixed(2);
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
async function createPaymentLinkOrPlaceholder({ txnid, amountMinor, description, customerName, customerEmail, customerPhone, storefront = 'IN', notes = {} }) {
  if (!isPayuConfigured(storefront)) {
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
  merchantSalt,
  isPayuConfigured,
  assertPayuConfigured,
  currencyFor,
  payuPaymentUrl,
  generateHash,
  verifyResponseHash,
  buildPaymentParams,
  refundPayment,
  createPaymentLinkOrPlaceholder,
};
