# Checkout coupons

Single eligibility engine for typed codes and the public offers strip. Listing
and applying go through the same rules so the checkout page cannot advertise a
coupon that `/order` will then refuse.

## Intent

- Admins can advertise some codes on the landing checkout page (`isDisplayed`)
  while leaving partner / one-off codes typable but hidden.
- Ineligible advertised codes stay visible with an `unlockMessage` (for
  example "add INR 200 more") instead of disappearing.
- Usage caps and remaining-use counts never reach the browser.

Source of truth: `src/services/coupon.service.js`. Callers:
`src/routes/publicCheckout.js`, `src/controllers/coupons.controller.js`.

## Architecture

| Piece | Location |
| --- | --- |
| Rules + listing | `src/services/coupon.service.js` |
| Public list / preview / apply | `GET /api/checkout/coupons`, `POST /api/checkout/coupon-preview`, `POST /api/checkout/order` |
| Admin CRUD | `src/routes/coupons.js` at `/api/v1/coupons` (admin JWT) |
| Schema | `CouponCode` in `prisma/schema.prisma` |

Amounts on `CouponCode.minOrderAmount`, `Payment.amount`, and
`Payment.discountAmount` are **paise**. The admin create/update API accepts
`minOrderAmount` in **rupees** and multiplies by 100.

`evaluateCoupon` is pure: usage counts are passed in so a listing can resolve
many codes with two `groupBy` queries instead of two queries per coupon.

`getCouponDiscount` keeps the historical return shape used by `/coupon-preview`
and `/order` -- including echoing the normalised code even when the coupon
does not apply.

## Eligibility

Checked in order. First failure wins.

| Rule | `reason` (preview / order) | `reasonCode` / unlock copy |
| --- | --- | --- |
| Missing, inactive, or unknown | (no `reason`; discount 0) | listing never includes inactive rows |
| `expiresAt` in the past | `Coupon expired` | `expired` -- "This offer has expired" |
| `minOrderAmount` > base | `Minimum order is INR ...` | `minOrder` -- "Add INR N more to unlock this offer" |
| Paid uses >= `maxGlobalUses` | `Coupon usage limit reached` | `globalLimit` -- "This offer is no longer available" |
| Paid uses by this email >= `maxUsesPerUser` | `Per-user usage limit reached` | `perUserLimit` -- "You have already used this offer" |

Base amount is `Template.price` (pre-GST, paise). Discount is
`round(base * discountPercent / 100)`. `discountPercent` is clamped to 0-100.

Usage counts only `Payment` rows with `status: 'paid'`. Unlimited coupons skip
the COUNT on `/coupon-preview` and `/order` (no limit means no query). The
listing always groupBys the displayed set.

`customerEmail` is optional on the listing. Without it the per-user cap cannot
be evaluated, so a coupon that email has already exhausted still reads as
eligible until the page re-requests with a valid email.

## Public API

All three routes sit behind `checkoutLimiter`. Sandbox Lab templates are
excluded (`EXCLUDE_SANDBOX_TEMPLATE`).

### GET `/api/checkout/coupons?templateSlug=...&customerEmail=...`

`templateSlug` is required. Response is always `{ coupons: [...] }` -- an
empty list is normal (no running campaign). A thrown error also returns
`{ coupons: [] }` so the offers strip cannot break checkout; the typed-code
input still works.

Each item:

```json
{
  "code": "SPRING20",
  "discountPercent": 20,
  "discountAmount": 200000,
  "label": "20% off",
  "condition": "on orders over INR 4,999 / expires 31 Aug",
  "expiresAt": "2026-08-31T18:30:00.000Z",
  "eligible": false,
  "unlockMessage": "Add INR 500 more to unlock this offer"
}
```

`label` and `condition` are generated from the row (`couponLabel` /
`couponCondition`) so they cannot contradict the rules. Live `condition`
text uses a rupee sign and a middle-dot separator; the example above is
ASCII-normalized. Candidates are
`isDisplayed: true` and `isActive: true`, ordered by `discountPercent` desc,
then eligible rows sorted first. Remaining-use counts are omitted on purpose.

### POST `/api/checkout/coupon-preview`

Body: `{ templateSlug, couponCode, customerEmail }`.

```json
{
  "valid": true,
  "code": "SPRING20",
  "reason": null,
  "priceBreakup": {
    "baseAmount": 499900,
    "discountAmount": 99980,
    "discountPct": 20,
    "gstPercent": 18,
    "gstAmount": 71984,
    "finalAmount": 471904
  }
}
```

GST is applied **after** the discount. Taxable floor is 100 paise
(`Math.max(100, price - discount)`), so a 100% coupon still creates a
one-rupee order.

### POST `/api/checkout/order`

Same `getCouponDiscount` call. `Payment.couponCode` is stored only when
`discountPct > 0`. Pending rows do not consume usage; only `paid` does
(PayU callback / mock-success -> `markPaymentPaid`).

## Admin API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/coupons` | All rows. `?limit=&page=` (limit capped at 100) adds `total` |
| POST | `/api/v1/coupons` | Create. `isDisplayed` defaults **false** |
| PATCH | `/api/v1/coupons/:id` | Partial update |
| DELETE | `/api/v1/coupons/:id` | Hard delete |

Create body: `{ code, discountPercent, expiresAt?, maxGlobalUses?, maxUsesPerUser?, minOrderAmount?, isActive?, isDisplayed? }`.

Constraints:

- `code` is trimmed and uppercased. Unique on `CouponCode.code`.
- `discountPercent` is 1-100 (integer after `Math.round`).
- `maxGlobalUses` / `maxUsesPerUser` null means unlimited; if set, must be >= 1.
- `minOrderAmount` is rupees on the wire, paise in the database.
- `isDisplayed` always implies `isActive`. Creating with `isDisplayed: true`
  and `isActive: false` stores `isDisplayed: false`. Disabling a coupon also
  clears `isDisplayed`. Turning display on for an already-disabled coupon
  returns 400: `A disabled coupon cannot be shown on checkout`.

## Pitfalls

- A hidden (`isDisplayed: false`) but active code still works when typed.
  That is intentional for partner codes -- do not flip display on to "test"
  apply behaviour.
- Listing without `customerEmail` can show a per-user-capped coupon as
  eligible. Re-fetch after the email field is valid.
- Admin `minOrderAmount` is rupees; public `priceBreakup` and unlock copy use
  paise internally and format rupees for humans. Do not send paise to POST
  `/api/v1/coupons`.
- Checkout listing failures are swallowed. If the strip is empty and you
  expected offers, check server logs and that `templateSlug` is an **active,
  non-sandbox** catalogue slug.
- `isDisplayed` defaults off so a newly created code is never published by
  accident.
