/**
 * Where a request came from, per Cloudflare.
 *
 * `cf-ipcountry` is the only geo signal in the stack -- there is no IP-geolocation
 * library anywhere -- and it is already what routes/track.js records for website
 * analytics. Using the same header for order records means an order's country and
 * a session's country are directly comparable.
 *
 * This is ONLY meaningful on a request the visitor's own browser made. A fetch
 * issued by our Next.js server carries that server's IP, so a country resolved
 * from a server-to-server call describes the datacentre, not the customer. The
 * checkout endpoints qualify because the checkout page calls them from the
 * browser; the catalogue endpoints, which Next renders server-side, do not.
 *
 * The country is never used to decide pricing -- the storefront does that, and it
 * is stated explicitly by the deployment. This is recorded as evidence of where a
 * sale happened, which is what zero-rating GST on exports rests on, and as a
 * best-guess default for the phone country-code picker.
 */

/** Cloudflare's placeholders for "no country": Tor exits and unknown IPs. */
const UNKNOWN_COUNTRIES = new Set(['XX', 'T1']);

/**
 * ISO-3166 alpha-2 for this request, or null when Cloudflare could not say.
 *
 * Null rather than a guess: a blank country on an order is honest, whereas a
 * defaulted one would be evidence of something that was never observed.
 */
function countryFromRequest(req) {
  const raw = String((req && req.headers && req.headers['cf-ipcountry']) || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{2}$/.test(raw) || UNKNOWN_COUNTRIES.has(raw)) return null;
  return raw;
}

module.exports = { countryFromRequest, UNKNOWN_COUNTRIES };
