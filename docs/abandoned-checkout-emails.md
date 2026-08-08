# Abandoned-checkout recovery emails

Hourly marketing email for pending PayU checkouts that never completed.
Treat as marketing under DPDP: only customers who opted in at checkout receive
it, and every message includes a one-click unsubscribe link.

## Architecture

- Job: `runAbandonedCheckoutJob` in `src/services/scheduler.js`
- Cron: `15 * * * *` (minute 15 of every hour), started when the API process
  loads the scheduler module
- Sender: `sendAbandonedCheckoutEmail` in `src/services/email.service.js`
  (HTML from `abandonedCheckoutHtml` in `src/services/emailTemplates.js`)
- Opt-in source: `Payment.marketingOptIn` set by `POST /api/checkout/order`
  in `src/routes/publicCheckout.js` (strict JSON `true` only)
- Unsubscribe: `buildUnsubscribeUrl` (`src/utils/unsubscribe.js`) +
  `GET /api/unsubscribe` (see `docs/dpdp-compliance.md` when present)
- Marker column: `Payment.abandonedEmailSentAt`
  (migration `20260704000001_payment_abandoned_email`)

There is no standalone npm script for this job; it only runs inside the
long-lived API process via `node-cron`.

## Selection rules

A payment row is eligible when all of the following hold:

| Condition | Value |
| --- | --- |
| `status` | `pending` |
| `abandonedEmailSentAt` | `null` |
| `customerEmail` | non-null |
| `marketingOptIn` | `true` |
| `createdAt` | between 2 hours and 72 hours ago |
| Batch size | up to 200 rows per run |

The 72-hour lower bound on age prevents a first deploy from mass-emailing
ancient pending rows.

Per-row processing:

1. Set `abandonedEmailSentAt = now` **before** sending so a later send failure
   cannot cause repeats on the next hour.
2. If the same `customerEmail` already has any `status: paid` payment, skip
   the send (customer completed a retry on another row).
3. Otherwise send mail with:
   - subject: `Your wedding invitation is one step away`
   - `checkoutUrl`: `{LANDING_URL}/checkout/{template.slug}`
   - `unsubscribeUrl`: HMAC link from `buildUnsubscribeUrl(email)`

SMTP must be configured (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`). Send errors
are logged as `[Email Error] sendAbandonedCheckoutEmail:` and do not roll
back the marker.

## Consent and unsubscribe

At checkout, `marketingOptIn` is stored only when the JSON body value is
strictly `true`; anything else becomes `false`. Abandoned-checkout mail is
intentionally gated on that flag.

Unsubscribe links use `UNSUBSCRIBE_SECRET` when set, otherwise `JWT_SECRET`.
`GET /api/unsubscribe` sets `marketingOptIn = false` on all payments for that
email. Already-sent abandoned emails are not recalled; future recovery mail
stops because the opt-in flag is cleared (and `abandonedEmailSentAt` already
blocks the same row).

## Operational checks

Confirm the API process is running (cron only ticks inside that process) and
SMTP works (startup sends a test mail via `sendTestEmail` in `src/server.js`).

Inspect eligible backlog (MySQL example):

```sql
SELECT id, customerEmail, createdAt, marketingOptIn, abandonedEmailSentAt
FROM Payment
WHERE status = 'pending'
  AND abandonedEmailSentAt IS NULL
  AND customerEmail IS NOT NULL
  AND marketingOptIn = 1
  AND createdAt <= (UTC_TIMESTAMP() - INTERVAL 2 HOUR)
  AND createdAt >= (UTC_TIMESTAMP() - INTERVAL 72 HOUR)
ORDER BY createdAt ASC
LIMIT 50;
```

Force a dry mental walkthrough in staging: create a pending payment with
`marketingOptIn = true`, age `createdAt` past two hours (or temporarily
widen the window in a local branch), ensure no paid row shares the email,
and wait for minute 15.

## Common pitfalls

- Customers who never checked marketing opt-in at checkout will never get
  this email, even if payment stayed pending.
- Marking `abandonedEmailSentAt` before send means a broken SMTP config
  silently "consumes" the attempt; fix SMTP, then clear the marker only for
  rows you intentionally want to retry.
- Changing `LANDING_URL` changes the checkout deep link in new emails.
- Rotating `JWT_SECRET` without a stable `UNSUBSCRIBE_SECRET` breaks
  outstanding unsubscribe tokens in already-sent messages.
- Multi-instance API replicas each run the cron; the `abandonedEmailSentAt`
  write-before-send pattern limits duplicates, but expect occasional races
  under concurrent workers.
