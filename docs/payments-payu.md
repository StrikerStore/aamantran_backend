# PayU payments

This document describes the active payment integration. Razorpay code remains in
`src/services/razorpay.service.js`, but the checkout and webhook routes use PayU.

## Codepaths

| Concern | Source |
| --- | --- |
| Checkout routes | `src/routes/publicCheckout.js` |
| PayU hashes, URLs, refunds, swap links | `src/services/payu.service.js` |
| IPN webhook | `src/routes/webhook.js` |
| Webhook body parser mount | `src/app.js` |
| Payment and swap models | `prisma/schema.prisma` |
| Purchase confirmation email | `src/services/email.service.js` |

## Environment

Required for live PayU payments:

```env
PAYU_MERCHANT_KEY="..."
PAYU_MERCHANT_SALT="..."
PAYU_ENV="test" # or "prod"; defaults to prod
API_BASE_URL="https://api.example.com"
LANDING_URL="https://www.example.com"
COUPLE_DASHBOARD_URL="https://app.example.com"
```

`PAYU_ENV=test` posts forms to `https://test.payu.in/_payment`; any other value
uses `https://secure.payu.in/_payment`.

## Template purchase flow

1. The landing page calls `POST /api/checkout/order` with:

   ```json
   {
     "templateSlug": "floral-design-14463",
     "couponCode": "OPTIONAL",
     "customerEmail": "buyer@example.com",
     "customerContact": "9876543210"
   }
   ```

2. The route looks up an active template, applies coupon/GST rules, creates a
   pending `Payment`, and generates both:
   - `payuTxnId`: PayU transaction id used for gateway callbacks.
   - `orderId`: customer-facing order id included in responses and emails.

3. The response contains `payuUrl`, `payuParams`, `paymentId`, `orderId`,
   `amount`, and `priceBreakup`. The frontend must submit `payuParams` as a form
   POST to `payuUrl`.

4. PayU redirects successful payments to
   `POST /api/checkout/payu-success`. The handler verifies the reverse hash,
   marks the payment paid, increments `Template.buyerCount`, sends the purchase
   email, and redirects to:

   ```text
   {LANDING_URL}/onboarding?paymentId=...&slug=...&template=...&orderId=...
   ```

5. PayU redirects failed payments to `POST /api/checkout/payu-failure`, which
   marks still-pending payments failed and redirects to the landing page with
   `?payment=failed`.

## IPN webhook

PayU IPN calls `POST /webhooks/payu`.

Important constraints:

- PayU sends `application/x-www-form-urlencoded` payloads.
- `src/app.js` mounts `/webhooks` with `express.urlencoded()` before global
  `express.json()`.
- The global rate limiter skips `/webhooks`.
- The same reverse hash verification is used for redirects and IPN.

The webhook is intentionally idempotent:

- For direct purchases, it updates matching `Payment` rows only when they are not
  already `paid`.
- For failed/non-success statuses, it best-effort marks pending payments failed.
- For template swap payments, it applies the template change if a pending
  `TemplateSwapRequest` matches `payuLinkId`.

## Template swap balance payments

Admin template swaps can require the customer to pay a balance. The PayU helper
`createPaymentLinkOrPlaceholder()` returns:

```js
{ id: txnid, short_url: "{API_BASE_URL}/api/checkout/payu-swap-link/{txnid}", isPlaceholder: false }
```

`GET /api/checkout/payu-swap-link/:txnid` renders an auto-submitting PayU form.
Successful callbacks go to `POST /api/checkout/payu-swap-success`, which:

- Verifies the PayU hash.
- Updates the primary event and optional paired event to the new template.
- Pins both events to the target template's current version when available.
- Marks the swap request paid.
- Creates a paid `Payment` row with a generated `orderId`.
- Increments the target template `buyerCount`.

If PayU keys are missing, the helper returns a placeholder URL instead of a live
PayU link. Use this only outside production payment processing.

## Hashes

`src/services/payu.service.js` implements the PayU SHA-512 algorithms:

- Payment request hash:
  `key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt`
- Response/IPN hash:
  `salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key`

Amounts are stored internally in paise. PayU form amounts are sent as rupees with
two decimals.

## Development and staging

Set `DUMMY_PAYMENT_MODE=true` to test checkout without PayU:

1. `POST /api/checkout/order` returns `{ dummy: true, paymentId, orderId, ... }`.
2. `POST /api/checkout/mock-success` with `{ "paymentId": "..." }` marks the
   payment paid, sets mock PayU ids, increments `buyerCount`, and sends the same
   purchase confirmation email.

`mock-success` returns `403` when dummy mode is disabled or when
`NODE_ENV=production`.

## Operational checks

- Confirm PayU callback URLs use the deployed `API_BASE_URL`.
- Confirm `LANDING_URL` and `COUPLE_DASHBOARD_URL` point to the correct
  frontends before testing redirects.
- Watch for `invalid_signature` redirects or `Invalid hash` webhook responses;
  these usually indicate key/salt mismatch, wrong environment, or modified PayU
  form fields.
- Do not remove `orderId` from purchase email/onboarding links; it is the
  customer-facing reference for each purchase.
