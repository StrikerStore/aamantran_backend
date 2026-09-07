/**
 * Which storefront a request is being served: India or international.
 *
 * The two websites are separate deployments of the same Next.js code, so the
 * storefront is a BUILD-TIME fact on the client and is stated explicitly on the
 * wire -- an `x-aamantran-storefront` header, or a `storefront` query/body
 * param. It is deliberately NOT inferred from the visitor's IP: geo would make
 * one cached catalogue response wrong for half its readers, and the whole point
 * of splitting the deployments was to take that problem off the table.
 *
 * `IN` is the default for anything unrecognised. That is the safe direction:
 * India charges GST and is the lower price, so a signal that goes missing
 * cannot silently overcharge someone or skip tax that was owed.
 *
 * The claim IS checked against Origin before money is involved -- see
 * `assertStorefrontMatchesOrigin` -- so a browser cannot ask the India site for
 * international treatment.
 */
const siteUrls = require('../config/siteUrls');

const IN   = 'IN';
const INTL = 'INTL';
const VALID = new Set([IN, INTL]);

/** Normalise anything to a valid storefront, falling back to India. */
function normalizeStorefront(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return VALID.has(s) ? s : IN;
}

/** scheme + host + port, with `www.` folded away. Null if unparseable. */
function originKey(value) {
  const u = new URL(String(value));
  const host = u.hostname.replace(/^www\./, '');
  return u.protocol + '//' + host + (u.port ? ':' + u.port : '');
}

/**
 * Storefront claimed by this request.
 *
 * Header first so the value survives a POST body that failed to parse; query
 * param second so a demo page or a link can carry it.
 */
function storefrontFromRequest(req) {
  const fromHeader = req?.headers?.['x-aamantran-storefront'];
  if (fromHeader) return normalizeStorefront(fromHeader);

  const fromQuery = req?.query?.storefront;
  if (fromQuery) return normalizeStorefront(fromQuery);

  const fromBody = req?.body?.storefront;
  if (fromBody) return normalizeStorefront(fromBody);

  return IN;
}

/** 'USD' for the international storefront, 'INR' otherwise. */
function currencyFor(storefront) {
  return storefront === INTL ? 'USD' : 'INR';
}

/** Landing origin a buyer on this storefront should be returned to. */
function landingUrlFor(storefront) {
  return storefront === INTL ? siteUrls.landingUrlIntl() : siteUrls.landingUrl();
}

/**
 * Reject a storefront claim that does not match where the request came from.
 *
 * Only worth doing where money is decided -- order creation -- because that is
 * the only place the answer changes what someone is charged and whether GST is
 * collected. Catalogue reads return both currencies anyway.
 *
 * A missing Origin is allowed through: server-to-server callers and older
 * browsers omit it, and the storefront still defaults to the safe side.
 *
 * @returns {string} the storefront to actually use.
 */
function resolveStorefrontForOrder(req) {
  const claimed = storefrontFromRequest(req);
  const origin  = String(req?.headers?.origin || '').trim();
  if (!origin) return claimed;

  let expected;
  try {
    // Compare full origins, not hostnames: in dev both storefronts are
    // `localhost` and differ only by port, and a hostname-only comparison
    // matches them to each other -- failing toward INTL, which is the direction
    // that skips GST. `www.` is folded so the apex and www forms of the same
    // site agree.
    expected = originKey(origin) === originKey(siteUrls.landingUrlIntl()) ? INTL : IN;
  } catch {
    return claimed;
  }

  if (expected !== claimed) {
    console.warn(
      '[storefront] claim ' + claimed + ' from origin ' + origin + ' -- using ' + expected
    );
  }
  return expected;
}

module.exports = {
  IN,
  INTL,
  normalizeStorefront,
  storefrontFromRequest,
  resolveStorefrontForOrder,
  currencyFor,
  landingUrlFor,
};
