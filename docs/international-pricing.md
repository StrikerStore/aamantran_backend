# International pricing and dual storefronts

Two public websites share this API: India (`aamantran.online`, INR + GST)
and international (`aamantranglobal.com`, USD, GST zero-rated). They are
separate deployments of the same storefront code. The API decides currency
from an explicit storefront claim, not from the visitor's IP.

USD catalogue prices are derived on every read from the hand-maintained
INR `Template.price`. They are never stored on `Template`. The charged
USD amount is frozen on `Payment` at order time.

## Architecture

| Concern | Where | Rule |
| --- | --- | --- |
| Which site is this request | `x-aamantran-storefront` header, else `storefront` query/body | Normalised to `IN` or `INTL`. Anything else becomes `IN`. |
| What a buyer is charged | `POST /api/checkout/order` | `resolveStorefrontForOrder` -- claim checked against `Origin` |
| Catalogue prices | `GET /api/templates`, `GET /api/templates/:slug` | Both INR and USD on every row; the client picks |
| FX + default markup | `AppSetting` keys `usdInrRate`, `defaultMarkupMultiplier` | Admin-editable; 60s in-process cache |
| Per-template lift | `Template.markupMultiplier` | Null means "use the global default" |
| Settlement | PayU merchant pair | India keys vs `PAYU_INTL_*`; no fallback between them |
| Return URL | `landingUrlFor(storefront)` | Global buyers go back to `LANDING_URL_INTL` |

Defaulting to `IN` is intentional. India is the lower price and collects
GST. A missing signal must not overcharge someone or skip tax.

## How the storefront is stated

```
storefrontFromRequest(req)
  1. header  x-aamantran-storefront
  2. query   ?storefront=
  3. body    { "storefront": "INTL" }
  4. else    IN
```

Header wins so a claim survives a body that failed to parse. The two
Next.js sites set this at build time; the API does not infer it from
`cf-ipcountry`. Geo is recorded on the payment as evidence of an export,
not as the price switch. See `src/utils/storefront.js` and
`src/utils/geo.js`.

`resolveStorefrontForOrder` is the only place the claim is checked
against `Origin`. It compares full origins (scheme + host + port) with
`www.` folded, because in dev both sites are `localhost` and differ
only by port. A hostname-only check would treat them as the same and
could fail toward `INTL` (skip GST).

A missing `Origin` is allowed through (server-to-server and older
browsers). A mismatch is logged and the origin wins:

```
[storefront] claim INTL from origin https://www.aamantran.online -- using IN
```

CORS includes `LANDING_URL_INTL` once, at process boot
(`src/app.js`). Set the env var and redeploy the API before
`aamantranglobal.com` takes traffic, or browser checkout calls are
rejected and the site "loads then fails silently".

## USD derivation

Only INR is edited by hand (`Template.price` / `originalPrice` in
paise). USD cents:

```
rawCents  = round(paise * multiplier / usdInrRate)
tierCents = (floor(rawCents / 1000) + 1) * 1000
usdCents  = tierCents - 1
```

That is: convert to cents with integer rounding, then ceiling to the
next whole $10, then subtract one cent. $59.99, $69.99, ...

A value already sitting on a $10 boundary moves up. $60.00 becomes
$69.99.

The ceiling-to-tier makes prices sticky. At INR 2999 x multiplier 3,
every rate from 90 to 99 yields $99.99. Ordinary FX drift changes
nothing; a price only ever jumps a full $10 tier. Use
`GET /api/v1/settings/pricing/preview` before saving a rate.

`originalPriceUsd` uses the same rate and multiplier as `priceUsd`.
The discount *percentage* will not match India, because each side is
tiered independently. Royal at INR 2999 / 5999 is 50% off in India
and about 47% off abroad ($99.99 / $189.99). That is accepted.

If a USD price cannot be derived, `computeBreakup` throws rather than
billing the INR figure in dollars (roughly 50x too much).

## Order breakup

`computeBreakup` in `src/services/pricing.service.js`:

1. Base = INR `template.price`, or derived USD cents on `INTL`.
2. Subtract coupon `discountAmount` (already computed against that same
   base). Floor at 100 minor units (INR 1 / USD 1).
3. GST = `template.gstPercent` on India; **0** on `INTL` (export of
   services is zero-rated).
4. `finalAmount` = taxable + GST, in the minor units of `currency`.

`POST /api/checkout/order` uses `resolveStorefrontForOrder`. Catalogue
and coupon-preview use `storefrontFromRequest` (no Origin check) because
those responses already carry both currencies / do not move money.

## PayU: two merchant accounts

| Storefront | Env | Currency |
| --- | --- | --- |
| `IN` | `PAYU_MERCHANT_KEY` / `PAYU_MERCHANT_SALT` | INR |
| `INTL` | `PAYU_INTL_MERCHANT_KEY` / `PAYU_INTL_MERCHANT_SALT` | USD |

The pairs do not fall back to each other. Signing with the wrong salt
is rejected by PayU or settles into the wrong merchant account.

`POST /api/checkout/order` calls `isPayuConfigured(storefront)` *before*
inserting `Payment`. A missing international key used to leave a
stranded `pending` row and a generic "Failed to create checkout order".
Now the handler returns **503**:

```
Payments are temporarily unavailable for your region. Please contact support.
```

Skipped when `DUMMY_PAYMENT_MODE=true` (blocked in production).
`buildPaymentParams` still `assertPayuConfigured` further down.

Hash verify looks the payment up by `txnid` **first**, then uses
`Payment.storefront` to pick the salt. `udf1` also carries the
storefront, but udf1 is only as trustworthy as the POST. Do not verify
with the request's claimed storefront.

Success / failure redirects use `landingUrlFor(payment.storefront)` so
a global buyer is not sent to the India site.

## What is frozen on Payment

| Column | Meaning |
| --- | --- |
| `amount` | Minor units of `currency` (paise or cents). Never sum across rows without grouping by `currency`. |
| `currency` | `INR` or `USD` -- what the buyer was charged |
| `storefront` | `IN` or `INTL` -- which site and which PayU account |
| `fxRate`, `markupMultiplier` | Snapshots; null on INR orders |
| `gstAmount` | Same minor units as `amount`; 0 on `INTL` |
| `countryCode` | ISO-3166 from `cf-ipcountry` at order time (`XX` / `T1` stored as null) |

`countryCode` is evidence that an international sale was an export. It
is only meaningful on a browser-originated request. Catalogue reads are
often server-side from Next and would record the datacentre.

## Coupons are storefront-scoped

`CouponCode.storefront` is `IN` | `INTL` | `BOTH`. Rows written before
the international site default to `IN`, so an India campaign cannot
leak abroad and give away the markup.

`minOrderAmount` is in the **coupon's** storefront minor units (paise
on `IN`, cents on `INTL`). Honouring an India code against a dollar
base would compare paise to cents.

A code scoped to the other site is treated as if it did not exist
(`discountPct: 0`), not as a hard error. Displayed coupons
(`GET /api/checkout/coupons`) filter `storefront IN (this, BOTH)`.

Full coupon evaluate/display rules are the checkout-coupons runbook
(draft PR #9). This page only covers the storefront constraint.

## Admin pricing API

Admin JWT (`issuer: aamantran:admin`). Mounted at `/api/v1/settings`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/settings/pricing` | Current rate + markup (`force: true`, bypasses cache) |
| PUT | `/api/v1/settings/pricing` | Write both keys in one transaction, then drop cache |
| GET | `/api/v1/settings/pricing/preview` | Per-template USD before/after |

PUT body: `{ "usdInrRate": 96, "defaultMarkupMultiplier": 3 }`.

Bounds (typo rails, not policy): rate 1-1000, markup 0.1-20. Both
values are required together so a half-applied change cannot price the
catalogue off a new rate at the old markup.

Preview query: `?usdInrRate=&defaultMarkupMultiplier=`. Omitted params
use the current saved values. Response includes `changedCount` and
`usesDefaultMultiplier` per template. Sandbox lab templates are
excluded.

Per-template `markupMultiplier` is edited on
`POST`/`PUT /api/v1/templates` (same 0.1-20 bounds). Empty string
stores null (use global). Do not send `0` -- a zero multiplier would
price the template at the lowest USD tier.

Seeded fallbacks if `AppSetting` is empty or unreadable: rate **96**,
markup **3** (must match migration `20260906120000`). A fallback is
logged:

```
[pricing] usdInrRate/defaultMarkupMultiplier missing or invalid in AppSetting; using fallbacks 96 / 3
```

`getPricingSettings` never throws on a DB read failure; the catalogue
stays up at those fallbacks.

## Catalogue responses

`withUsdPrices` adds `priceUsd` and `originalPriceUsd` (cents, or
null). `GET /api/templates` and `GET /api/templates/:slug` always
attach both currencies so one cached response is correct for either
deployment.

`sort=price-asc` / `price-desc` still order by the INR `price` column.
That is the same order when every template uses the global multiplier.
A custom `markupMultiplier` can make the USD list look unsorted.

## Setup

Required for the international site to take a payment:

```
LANDING_URL_INTL=https://www.aamantranglobal.com
PAYU_INTL_MERCHANT_KEY=...
PAYU_INTL_MERCHANT_SALT=...
```

Then redeploy the API (CORS + PayU). Dev defaults:
`LANDING_URL_INTL=http://localhost:3002`.

`PAYU_ENV` defaults to **prod** if unset. Set `PAYU_ENV=test` when
testing.

## Pitfalls

- Do not infer storefront from IP. Geo is evidence, not the switch.
- Do not sum `Payment.amount` across `currency`.
- Do not restore a stored `Template.priceUsd` column. The point of
  derivation is that a rate edit repositions the whole catalogue.
- A browser on the India origin cannot buy at international prices,
  even if it sends `x-aamantran-storefront: INTL`.
- Missing `PAYU_INTL_*` is a 503, not a fallback to the India
  merchant.
- `DUMMY_PAYMENT_MODE` skips the gateway check and the team order
  alert (see the internal-notifications runbook).
- Rate edits look like a no-op until they cross a $10 tier. Preview
  first.
