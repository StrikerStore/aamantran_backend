# Payment gateways (PayU and Razorpay)

India and the global storefront each have a chosen gateway. India
defaults to PayU. The global site (`aamantranglobal.com`) defaults to
Razorpay, because PayU has no international merchant account. An admin
can point either storefront at either gateway from the admin panel.
The choice is stored in the database, so it takes effect without a
redeploy.

Two rules hold the money path together:

1. Checkout uses only the gateway saved for that storefront, and only
   when that gateway has credentials. A missing key returns **503**
   and writes no `Payment` row. The order is never sent to the other
   gateway, and the two PayU merchant accounts never sign for each
   other.
2. A saved setting applies to new orders. Refunds, redirects, and
   webhooks follow `Payment.gateway` on the row that already exists.

Code: `src/services/paymentGateway.service.js`,
`src/services/payu.service.js`, `src/services/razorpay.service.js`,
`src/services/payment.service.js`, `src/routes/publicCheckout.js`,
`src/routes/razorpayWebhook.js`, `src/routes/webhook.js`.

## Defaults and storage

| Storefront | AppSetting key | Default |
| --- | --- | --- |
| `IN` | `paymentGateway.IN` | `payu` |
| `INTL` | `paymentGateway.INTL` | `razorpay` |

An unrecognised value is ignored and the default is used. A failed
`AppSetting` read also falls back to the defaults, so a database blip
does not take checkout down by itself.

Each process caches the pair for 60 seconds and drops the cache on its
own write. On a multi-instance deploy, another instance can keep the
previous gateway for up to a minute after a save.

## Credentials

| Gateway | Storefront | Required variables |
| --- | --- | --- |
| PayU | `IN` | `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT` |
| PayU | `INTL` | `PAYU_INTL_MERCHANT_KEY`, `PAYU_INTL_MERCHANT_SALT` |
| Razorpay | both | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` |

One Razorpay account serves both sites. Rupees for India, dollars for
the global site. USD orders also need international payments enabled
in the Razorpay dashboard. This API cannot see that flag. A USD order
on an account without it fails at Razorpay.

`RAZORPAY_KEY_ID` is public. Checkout hands it to the buyer's browser.
`RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` stay on the server.

Test versus live Razorpay is the key prefix (`rzp_test_` versus
`rzp_live_`). There is no environment switch. PayU is the opposite:
`PAYU_ENV=test` posts to `test.payu.in`. Any other value, including
unset, posts to live PayU.

`DUMMY_PAYMENT_MODE=true` skips both gateways and returns
`dummy: true` from `POST /api/checkout/order`.
`POST /api/checkout/mock-success` is rejected when
`NODE_ENV=production`.

## Admin API

Mounted at `/api/v1/settings` behind the admin JWT
(`issuer: aamantran:admin`, `role: admin`).

| Method | Path | Body |
| --- | --- | --- |
| GET | `/gateway` | none |
| PUT | `/gateway` | `{ "storefront": "IN", "gateway": "razorpay" }` |

`GET` returns `{ storefronts, defaults }`. Each storefront object has
`chosen` (the saved gateway), `isDefault`, `configured`, `missing`
(the env vars still needed), and `options` (both gateways, each with
`configured` and `missing`). When the saved gateway has lost its keys,
`configured` is false and new orders on that site are refused. `chosen`
stays the saved value.

`PUT` rejects an unknown gateway and a gateway with no credentials for
that storefront (**400**). Saving an unconfigured gateway would make
every later order on that site fail with 503.

```
curl -X PUT "$API/api/v1/settings/gateway" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"storefront":"INTL","gateway":"razorpay"}'
```

`storefront` accepts `IN` or `INTL` (anything else is treated as
`IN`). `gateway` must be `payu` or `razorpay` after trim and
lowercase.

## Creating an order

`POST /api/checkout/order`. The storefront comes from the request
`Origin`, the same check international pricing uses. The body cannot
ask for the other site's prices or gateway.

Before any row is written, `gatewayFor(storefront)` resolves the
saved gateway (the 60-second cache above) and checks the credentials
in the environment now. Unconfigured, and not in dummy mode:

```
503  { "message": "Payments are temporarily unavailable for your region. Please contact support." }
```

The log line names the gateway and the missing variables. The buyer
message does not.

Razorpay creates the gateway order first, then the `Payment` row.
`receipt` is this API's `orderId` (capped at 40 characters). A
Razorpay outage returns **502** and leaves no `pending` row. PayU
inserts the row first, then returns form fields for the browser to
post.

Both responses include `paymentId`, `orderId`, `amount` (minor units:
paise or cents), and `priceBreakup`. The gateway-specific shape:

```
# Razorpay
{
  "razorpay": {
    "keyId": "rzp_live_...",
    "orderId": "order_...",
    "amount": 299900,
    "currency": "INR",
    "name": "Aamantran",
    "description": "Floral",
    "prefill": { "name": "...", "email": "...", "contact": "..." }
  }
}

# PayU
{ "payuUrl": "https://secure.payu.in/_payment", "payuParams": { } }
```

`Payment.gateway` is `payu` or `razorpay`. PayU also stores `payuTxnId`
(and mirrors it into `gatewayOrderId`). Razorpay stores Razorpay's
`order_...` id in `gatewayOrderId` and leaves `payuTxnId` null.
`gatewayPaymentId` is filled when the payment is captured (PayU
`mihpayid`, or Razorpay `pay_...`). On a PayU order that id is also
copied to `payuMihpayid`.

Migration `20260919000000_payment_gateway` adds the columns, defaults
existing rows to `payu`, and copies the old PayU ids. Deploy it before
the code that reads `gateway`.

## Marking an order paid

`markPaymentPaid` in `src/services/payment.service.js` is the only
transition to `paid`. PayU's browser return, PayU's IPN, Razorpay's
browser verify, and Razorpay's webhook all call it. The status change
is claimed with `updateMany` where `status != paid`. The caller that
wins increments `Template.buyerCount`, sends the team alert, and
sends the buyer confirmation when `customerEmail` is set. A second
caller in the same second gets the row back and sends nothing.

A failure notice updates only a still-`pending` row. A late
`payment.failed` cannot un-sell a paid order.

### Razorpay

| Path | Who calls it |
| --- | --- |
| `POST /api/checkout/razorpay-verify` | The buyer's page, after Checkout.js closes |
| `POST /webhooks/razorpay` | Razorpay, including when the tab was closed |

Verify requires `razorpay_order_id`, `razorpay_payment_id`, and
`razorpay_signature`. The signature is
HMAC-SHA256 of `order_id|payment_id` with `RAZORPAY_KEY_SECRET`.
A mismatch is **400** and the order stays unpaid. The lookup is
`gatewayOrderId` plus `gateway: razorpay`.

The webhook signs the raw body with `RAZORPAY_WEBHOOK_SECRET`. It is
mounted in `src/app.js` with `express.raw()` before the urlencoded
`/webhooks` parser. Re-parsing the body and signing the result will
fail every signature. If `req.body` is not a Buffer, the route returns
**500** (`Webhook misconfigured`).

| Condition | Status |
| --- | --- |
| `RAZORPAY_WEBHOOK_SECRET` unset | **503**, every call refused |
| Bad `x-razorpay-signature` | **400** |
| No `order_id`, or no matching `Payment` | **200** (Razorpay should stop retrying) |
| `payment.captured` and not yet paid | `markPaymentPaid` |
| `payment.failed` while still pending | `markPaymentFailed` |
| Any other event | **200**, ignored |
| Database error while handling | **500** (Razorpay retries) |

Dashboard events to subscribe: `payment.captured` and
`payment.failed`. Point the webhook at `/webhooks/razorpay`.

### PayU

The browser returns to `POST /api/checkout/payu-success` or
`POST /api/checkout/payu-failure`. The server-to-server IPN is
`POST /webhooks/payu` (form-encoded). Both verify the hash with the
salt of the storefront stored on the `Payment` row, looked up by
`payuTxnId`. An unknown `txnid` is checked with the India salt, so the
hash fails.

## Refunds

`POST /api/v1/transactions/:id/refund` (admin JWT) calls the gateway
on the row.

| `Payment.gateway` | Refund call | Id used |
| --- | --- | --- |
| `razorpay` | Razorpay payments refund | `gatewayPaymentId` (`pay_...`), the full `amount` |
| anything else | PayU, using `payment.storefront`'s merchant account | `gatewayPaymentId` or `payuMihpayid` |

A missing capture id is **400**. Razorpay with no key pair is **503**.
An already-refunded row is **409**.

On success the row becomes `refunded`, with `refundedAt` set to now,
`refundAmount` set to the full amount, and `refundReference` set to
the gateway's refund id. That timestamp is what puts the credit note
in the GST period of the refund. See `docs/gst-report.md`.

## What a deploy must have set

`npm run check:env` (`scripts/check-env.js`) prints missing names and
why. It never prints values. Warnings only, unless `--strict`, which
exits 1 when a required item is missing.

Payment checks that matter:

- India needs a complete PayU pair or a complete Razorpay pair.
  Otherwise no India order can be taken.
- The global site needs Razorpay, or the international PayU pair.
- Half a Razorpay pair (key without secret, or the reverse) is its
  own failure. The gateway stays unconfigured until both are set, so
  a storefront already pointed at Razorpay refuses every new order.
- Razorpay keys without `RAZORPAY_WEBHOOK_SECRET` mean every webhook
  is refused. A buyer who pays and closes the tab is charged and never
  completed.
- In production, an `rzp_test_` key, `PAYU_ENV=test`, or
  `DUMMY_PAYMENT_MODE=true` is reported as a problem.

`src/server.js` logs the webhook-secret, test-key, and
`TRIAL_IP_SALT` cases on production boot. They are warnings. The
process still starts. Run `npm run check:env` on the host after
setting variables. That is the full list.
