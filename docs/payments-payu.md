# PayU Payments and Checkout

This page documents the payment paths implemented by:

- `src/routes/publicCheckout.js`
- `src/routes/webhook.js`
- `src/services/payu.service.js`
- `src/controllers/transactions.controller.js`
- `src/controllers/users.controller.js`
- `prisma/schema.prisma`

## Configuration

Set these variables for live PayU traffic:

```env
PAYU_MERCHANT_KEY="..."
PAYU_MERCHANT_SALT="..."
PAYU_ENV="test" # "test" posts to test.payu.in; any other value uses production
API_BASE_URL="https://api.aamantran.online"
LANDING_URL="https://www.aamantran.online"
COUPLE_DASHBOARD_URL="https://app.aamantran.online"
```

Optional development variables:

- `DUMMY_PAYMENT_MODE=true` makes checkout return a dummy order response and
  enables `POST /api/checkout/mock-success`.
- `TEMPLATE_SWAP_PLACEHOLDER_PAY_URL` is used when template-swap balance links
  are requested without PayU keys.

Never enable `DUMMY_PAYMENT_MODE` in production. The mock-success route rejects
requests when `NODE_ENV=production`.

## Direct template purchase flow

1. Landing frontend calls `POST /api/checkout/coupon-preview` to preview pricing
   for a template and optional coupon.
2. Landing frontend calls `POST /api/checkout/order` with:

   ```json
   {
     "templateSlug": "floral-design-14463",
     "couponCode": "SAVE10",
     "customerEmail": "couple@example.com",
     "customerContact": "9876543210"
   }
   ```

3. The API creates a pending `Payment` row with:
   - `orderId`: human-readable reference generated as `AO-DDMMYY-HHMMSS-XXXX`
   - `payuTxnId`: PayU transaction id sent as `txnid`
   - `amount`: final amount in paise, after coupon and GST
   - `status`: `pending`
4. In normal mode, the response includes `payuUrl`, signed `payuParams`,
   `paymentId`, `orderId`, `amount`, and `priceBreakup`. The frontend posts the
   parameters to PayU.
5. PayU returns the browser to:
   - success: `POST /api/checkout/payu-success`
   - failure: `POST /api/checkout/payu-failure`
6. On successful hash verification and `status=success`, the API marks the
   payment `paid`, stores `payuMihpayid`, increments `Template.buyerCount`, sends
   the purchase email, and redirects to landing onboarding with `paymentId`,
   template details, and `orderId`.
7. The customer completes onboarding through `POST /api/checkout/register`.

PayU amount fields are rupees with two decimals in signed form parameters. The
database stores money amounts in paise for payments and template prices.

## Coupon rules

Coupons are looked up by uppercase `CouponCode.code`. A coupon has no effect
unless all applicable checks pass:

- coupon exists and `isActive` is true
- `expiresAt` is absent or in the future
- `minOrderAmount` is absent or no greater than the template base price
- `maxGlobalUses` has not been reached by paid payments
- `maxUsesPerUser` has not been reached for the lowercased customer email

The taxable amount is clamped to at least 100 paise before GST is applied.

## PayU hash handling

`buildPaymentParams` signs the outgoing form with:

```text
SHA512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
```

Redirect callbacks and IPN webhooks are verified with the reverse response hash:

```text
SHA512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
```

The implementation uses timing-safe comparison and returns failure if `hash` is
missing or malformed.

## IPN webhook

Configure PayU to send IPN callbacks to:

```text
POST {API_BASE_URL}/webhooks/payu
```

The webhook expects `application/x-www-form-urlencoded`. It is mounted before
the global JSON parser and is excluded from the global rate limiter.

The IPN handler is intentionally idempotent:

- For direct purchases, it updates a payment only when the matching
  `Payment.payuTxnId` exists and is not already `paid`.
- Direct-purchase IPN processing does not send the purchase confirmation email;
  that email is sent by the browser success path and mock-success path.
- For non-success callbacks, it marks matching pending payments as `failed`.
- For swap payments, it only processes `TemplateSwapRequest` rows with
  `status=pending`, and it avoids creating a duplicate `Payment` when the
  browser redirect handler already created one.

## Template-swap balance payments

Admin template swaps live in `src/controllers/users.controller.js`.

- If the new template is not more expensive, the event is updated immediately and
  its render cache is cleared.
- If a balance is due, older pending swap requests are cancelled, a new
  `TemplateSwapRequest` is created, and an email is sent with a PayU link.
- Real links point to `GET /api/checkout/payu-swap-link/:txnid`, which returns an
  auto-submitting HTML form to PayU.
- Without PayU keys, the email uses `TEMPLATE_SWAP_PLACEHOLDER_PAY_URL` or
  `https://aamantran.online/configure-payu`.

Successful swap payment redirects or IPN callbacks:

1. mark the swap request `paid`
2. update the event, and paired event when present, to the new template
3. pin `Event.templateVersionId` to the new template current version when set
4. create a paid `Payment` row for the balance payment
5. increment buyer count

## Refunds

Admins call `POST /api/v1/transactions/:id/refund`. A refund requires
`Payment.payuMihpayid`; otherwise the API returns `400`. The service calls PayU's
`cancel_refund_transaction` command and then marks the payment `refunded`.
