# Internal order, ticket, and review emails

Team alerts for a paid template, a new support ticket, and a new or edited
review, plus the customer's ticket acknowledgement. These are not the couple
lifecycle jobs (onboarding reminder, RSVP milestones, countdown, thank-you)
and not abandoned-checkout recovery.

HTML lives in `src/services/internalEmailTemplates.js`. Senders live in
`src/services/email.service.js`. SMTP must be configured (`SMTP_HOST`,
`SMTP_USER`, `SMTP_PASS`; `SMTP_PORT` defaults to 587). `EMAIL_FROM` falls
back to `SMTP_USER`, then `aamantran@plexzuu.com`.

## Architecture

| Event | Trigger | Team mail | Customer mail |
| --- | --- | --- | --- |
| Template purchased | `markPaymentPaid` from `POST /api/checkout/payu-success` | `sendAdminOrderPlacedEmail` | `sendPurchaseConfirmationEmail` (if `customerEmail` is set) |
| Ticket opened | `POST /api/user/tickets` after the row is saved | `sendAdminTicketRaisedEmail` | `sendTicketReceivedEmail` (if the user has an email) |
| Review created or edited | `POST /api/user/review` after the row is saved | `sendAdminReviewPostedEmail` | none |
| Admin replies to a ticket | `POST /api/v1/tickets/:id/reply` | none | `sendTicketReplyEmail` |

Team mail goes through `sendInternalMail`. That helper never throws: a
missing inbox or an SMTP error is logged (`[Email] ...`) and the customer
request still succeeds. Handlers also `.catch` the promise so a rejection
cannot fail the HTTP response.

The contact form (`POST /api/contact`) is a different path. It uses
`sendMail` directly, does **not** call `internalRecipient()`, and returns
500 to the browser if SMTP fails.

## Recipient

```
INTERNAL_NOTIFY_TO || CONTACT_FORM_TO || ADMIN_EMAIL
```

If none of those are set, team alerts are skipped with a warning. The
contact form uses only `CONTACT_FORM_TO || ADMIN_EMAIL`, so pointing
`INTERNAL_NOTIFY_TO` at ops does not move contact-form mail.

Admin deep links use `siteUrls.adminUrl()` (`ADMIN_URL`, or
`http://localhost:5174` in dev / `https://admin.aamantran.online` in
production).

## Order placed

Fired from `markPaymentPaid` in `src/routes/publicCheckout.js`. That helper
is the **only** caller. Subject:

```
[Order] {orderId or paymentId} - {templateName}
```

The body lists order id, template, amount paid, optional discount + coupon
(with list price = amount + discount), customer mailto, PayU `mihpayid`,
payment id, and `en-IN` timestamp. The button opens
`{ADMIN_URL}/transactions/{paymentId}`.

Amounts are `Payment.amount` / `discountAmount` **integer paise**. The
template divides by 100 and formats with `en-IN`.

### When the team mail does not fire

`POST /webhooks/payu` marks a pending purchase `paid` and increments
`buyerCount` itself. It does not send mail. `payu-success` then sees
`status === 'paid'` and skips `markPaymentPaid`, so **neither** the team
alert nor the purchase-confirmation email runs.

`POST /api/checkout/mock-success` (dummy mode, blocked in production) marks
paid and sends the customer confirmation only. No team alert.

Template-swap balance payments (redirect or IPN) also skip this alert.

## Onboarding URL `amount` query

Purchase confirmation, the PayU success redirect, mock-success, and the
hourly onboarding-reminder job all append `&amount={Payment.amount}`
(paise) to `{LANDING_URL}/onboarding?...`. The landing site reads that
value for Meta Purchase. Confirmation / redirect URLs also include
`paymentId`, `slug`, `template`, and `orderId` when present. The reminder
job omits `orderId`.

## Ticket raised

`POST /api/user/tickets` requires `subject` and `message`. Optional
`eventId` must belong to the caller (else 403). The first message row is
`senderRole: 'user'`.

There is no ticket-number column. The human reference is derived:

```
AT- + first 8 hex chars of the UUID, uppercased
```

Example: id `a1b2c3d4-....` becomes `AT-A1B2C3D4`. Search admin by that
prefix or by the full UUID in the mail body.

| Mail | Subject | Extra |
| --- | --- | --- |
| Team | `[Ticket AT-XXXXXXXX] {subject}` | Quoted message, event couple names or slug, `{ADMIN_URL}/tickets/{id}` |
| Customer | `We received your request - AT-XXXXXXXX` | Promises a reply in 24-48 hours; branded layout |

Both sends are `Promise.allSettled` after the ticket is committed.

Admin reply (`POST /api/v1/tickets/:id/reply`) emails
`Re: {ticket.subject}` with a link to
`{COUPLE_DASHBOARD_URL}/support/{id}`. Resolve / reopen do not email.

## Review posted

`notifyReviewPosted` runs for couple create **and** update (`isUpdate` in
the subject: `[Review] {n}/5 on {templateName}` or `... (updated)`).
Admin-created reviews (`POST /api/v1/reviews`) do not send this mail.

The button opens `{ADMIN_URL}/reviews` (the list, not a single row).
User-authored subject / body / review text is HTML-escaped (`esc` /
`escMultiline`) before interpolation.

## Constraints

- SMTP is required. Stale `RESEND_API_KEY` in a local `.env` is unused.
- Team alerts are best-effort and are not retried.
- Ticket reference is not stored; changing the `AT-` formula would
  invalidate every email already sent.
- `sendInternalMail` swallows errors. A quiet inbox is usually "no
  recipient" or "IPN won the race", not a thrown 500.

## Pitfalls

- If PayU IPN is faster than the browser redirect, ops will not see an
  `[Order]` mail even though the payment is paid. Check
  `{ADMIN_URL}/transactions/{id}` and PayU `mihpayid` on the row.
- Dummy checkout never exercises the team order alert. Use a PayU test
  redirect through `/api/checkout/payu-success`.
- Setting only `INTERNAL_NOTIFY_TO` leaves the public contact form on
  `ADMIN_EMAIL` (or unconfigured).
- Do not treat the onboarding `amount` query as rupees. It is paise, same
  as `Payment.amount`.
