/**
 * Which gateway takes the money, per storefront.
 *
 * India has a PayU merchant account and a Razorpay account; the global site has
 * Razorpay only, because PayU never issued an international account. The default
 * is therefore PayU for IN and Razorpay for INTL, and an admin can point either
 * storefront at either gateway from the admin panel without a redeploy.
 *
 * TWO RULES THAT MUST NOT DRIFT:
 *
 * 1. The admin's choice is never trusted blindly. `gatewayFor` re-checks on
 *    every order that the chosen gateway actually has credentials for that
 *    storefront, and an unconfigured choice is REFUSED — it never quietly falls
 *    back to the other gateway. Falling back would settle someone's money into
 *    an account they did not choose, and (for PayU's two merchant accounts)
 *    possibly the wrong country's books.
 *
 * 2. A saved setting only decides NEW orders. An order already taken keeps its
 *    own `Payment.gateway`, and refunds and callbacks follow that column, so
 *    flipping this setting can never strand an existing payment.
 *
 * Stored in AppSetting, cached exactly like pricing.service.js: a 60-second TTL
 * per process, dropped on write. On a multi-instance deploy another instance can
 * therefore keep using the previous gateway for up to a minute; the admin page
 * says so.
 */
const prisma = require('../utils/prisma');
const { isPayuConfigured } = require('./payu.service');
const { isRazorpayConfigured } = require('./razorpay.service');

const PAYU = 'payu';
const RAZORPAY = 'razorpay';
const GATEWAYS = [PAYU, RAZORPAY];

const KEY_GATEWAY_IN = 'paymentGateway.IN';
const KEY_GATEWAY_INTL = 'paymentGateway.INTL';

const KEY_FOR = { IN: KEY_GATEWAY_IN, INTL: KEY_GATEWAY_INTL };

// What each storefront uses until an admin says otherwise. India keeps the
// account that has taken every order to date; the global site has no PayU
// account at all, so Razorpay is the only thing that can work there.
const DEFAULTS = { IN: PAYU, INTL: RAZORPAY };

const CACHE_TTL_MS = 60 * 1000;
let cache = null; // { at: number, value: { IN: string, INTL: string } }

/** Anything unrecognised becomes null, so a corrupted row falls back to the default. */
function normalizeGateway(raw) {
  const g = String(raw || '').trim().toLowerCase();
  return GATEWAYS.includes(g) ? g : null;
}

function normalizeStorefront(raw) {
  return String(raw || 'IN').toUpperCase() === 'INTL' ? 'INTL' : 'IN';
}

/** Is this gateway usable for this storefront right now? */
function isGatewayConfigured(gateway, storefront) {
  if (gateway === RAZORPAY) return isRazorpayConfigured(storefront);
  if (gateway === PAYU) return isPayuConfigured(storefront);
  return false;
}

/** The env vars an admin has to set to make a disabled choice selectable. */
function missingCredentialsFor(gateway, storefront) {
  if (gateway === RAZORPAY) return 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET';
  if (gateway === PAYU) {
    return normalizeStorefront(storefront) === 'INTL'
      ? 'PAYU_INTL_MERCHANT_KEY / PAYU_INTL_MERCHANT_SALT'
      : 'PAYU_MERCHANT_KEY / PAYU_MERCHANT_SALT';
  }
  return '';
}

/**
 * The chosen gateway for each storefront, as saved — before any credential
 * check. A read failure falls back to the defaults rather than taking checkout
 * down, the same way a pricing read does.
 *
 * @returns {Promise<{IN: string, INTL: string}>}
 */
async function getGatewaySettings({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let rows = [];
  try {
    rows = await prisma.appSetting.findMany({
      where: { key: { in: [KEY_GATEWAY_IN, KEY_GATEWAY_INTL] } },
    });
  } catch (err) {
    console.error('[gateway] AppSetting read failed:', err.message);
  }

  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const value = {
    IN: normalizeGateway(raw[KEY_GATEWAY_IN]) || DEFAULTS.IN,
    INTL: normalizeGateway(raw[KEY_GATEWAY_INTL]) || DEFAULTS.INTL,
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Drop the cache so an admin's save takes effect on the next order. */
function invalidateGatewaySettings() {
  cache = null;
}

/**
 * Which gateway this order must use, checked against its credentials.
 *
 * @returns {Promise<{gateway: string, configured: boolean, missing: string}>}
 *   `configured: false` means refuse the order (503) — see rule 1 above.
 */
async function gatewayFor(storefront) {
  const site = normalizeStorefront(storefront);
  const settings = await getGatewaySettings();
  const gateway = settings[site] || DEFAULTS[site];
  const configured = isGatewayConfigured(gateway, site);
  return {
    gateway,
    configured,
    missing: configured ? '' : missingCredentialsFor(gateway, site),
  };
}

/**
 * The whole picture for the admin page: what each storefront is set to, and
 * which gateways it could be set to.
 *
 * `effective` differs from `chosen` only when the chosen gateway has lost its
 * credentials — in which case orders are being refused, not silently rerouted,
 * and the page has to say so rather than showing a tidy green tick.
 */
async function getGatewayStatus() {
  const settings = await getGatewaySettings({ force: true });
  const forSite = (site) => {
    const chosen = settings[site];
    const options = GATEWAYS.map((gateway) => ({
      gateway,
      configured: isGatewayConfigured(gateway, site),
      missing: isGatewayConfigured(gateway, site) ? '' : missingCredentialsFor(gateway, site),
    }));
    const chosenOption = options.find((o) => o.gateway === chosen);
    return {
      storefront: site,
      chosen,
      isDefault: chosen === DEFAULTS[site],
      configured: Boolean(chosenOption && chosenOption.configured),
      missing: chosenOption ? chosenOption.missing : '',
      options,
    };
  };
  return { storefronts: [forSite('IN'), forSite('INTL')], defaults: { ...DEFAULTS } };
}

/**
 * Save a storefront's gateway.
 *
 * Refuses a gateway with no credentials for that storefront: saving it would
 * mean every subsequent order is refused with a 503, which is a worse outcome
 * than not being able to save at all. Returns an { error } the caller turns
 * into a 400.
 */
async function setGatewayFor(storefront, gateway) {
  const site = normalizeStorefront(storefront);
  const wanted = normalizeGateway(gateway);
  if (!wanted) return { error: 'Unknown payment gateway' };
  if (!isGatewayConfigured(wanted, site)) {
    return {
      error:
        `${wanted === RAZORPAY ? 'Razorpay' : 'PayU'} is not configured for ` +
        `${site === 'INTL' ? 'the global site' : 'India'}: set ${missingCredentialsFor(wanted, site)}`,
    };
  }

  await prisma.appSetting.upsert({
    where: { key: KEY_FOR[site] },
    create: { key: KEY_FOR[site], value: wanted },
    update: { value: wanted },
  });
  invalidateGatewaySettings();
  return { gateway: wanted, storefront: site };
}

module.exports = {
  PAYU,
  RAZORPAY,
  GATEWAYS,
  DEFAULTS,
  KEY_GATEWAY_IN,
  KEY_GATEWAY_INTL,
  normalizeGateway,
  isGatewayConfigured,
  missingCredentialsFor,
  getGatewaySettings,
  invalidateGatewaySettings,
  gatewayFor,
  getGatewayStatus,
  setGatewayFor,
};
