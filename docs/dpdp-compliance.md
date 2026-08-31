# DPDP compliance workflows

This backend implements India DPDP-oriented controls for consent capture,
marketing opt-out, account erasure, guest-data retention, and durable auth
audit logs. The codepaths below are the source of truth; treat privacy-policy
wording on the landing site as the customer-facing notice.

## Architecture

- `src/lib/constants.js` exports `POLICY_VERSION` (currently `2026-07-08`).
  Bump it whenever Terms or Privacy change materially; checkout and onboarding
  store that string on `Payment` / `User`.
- `src/routes/publicCheckout.js` requires `consent: true` on
  `POST /api/checkout/order` before creating a pending payment.
- `src/routes/unsubscribe.js` + `src/utils/unsubscribe.js` provide signed
  one-click marketing opt-out at `/api/unsubscribe`.
- `src/routes/userProfile.js` mounts `DELETE /api/user/me` to
  `src/controllers/accountDeletion.controller.js`.
- `src/services/dataRetention.service.js` warns owners and erases guest data
  after invite expiry; prunes `AuthAuditLog` past 13 months.
- `src/services/scheduler.js` runs retention daily at `15 3 * * *` (3:15 AM)
  and sends abandoned-checkout emails only when `marketingOptIn` is true.
- `scripts/send-dpdp-notice.js` is a one-time notice mailer for existing
  customers (`npm run notify:dpdp`).
- Migration `20260708000000_dpdp_compliance` adds consent, retention, and
  `AuthAuditLog` columns/tables.

## Consent at checkout and onboarding

`POST /api/checkout/order` body fields that matter:

| Field | Rule |
| --- | --- |
| `consent` | Must be JSON boolean `true`. Any other value returns `400` with a Terms/Privacy message. |
| `marketingOptIn` | Stored as `true` only when the JSON value is strictly `true`; otherwise `false`. |
| `customerEmail` | Normalized to lowercase when present. |

On create, the payment row stores:

- `consentAt` = now
- `policyVersion` = `POLICY_VERSION`
- `marketingOptIn` = boolean above

When the purchaser finishes onboarding and a `User` row is created, the
checkout consent fields are copied onto the user (`consentAt`,
`policyVersion`).

Constraint: abandoned-checkout recovery mail is treated as marketing. The
hourly job at minute 15 only selects pending payments with
`marketingOptIn: true`, age 2-72 hours, and no prior
`abandonedEmailSentAt`. Each email includes an unsubscribe URL.

## Marketing unsubscribe

Links are HMAC-SHA256 of the lowercased email, truncated to 32 hex chars.
Secret resolution:

1. `UNSUBSCRIBE_SECRET` if set
2. else `JWT_SECRET`

Build helper: `buildUnsubscribeUrl(email)` in `src/utils/unsubscribe.js`
produces:

```text
{API_BASE_URL}/api/unsubscribe?email={urlencoded}&token={token}
```

`GET /api/unsubscribe` (rate-limited by `lookupLimiter`):

1. Rejects missing/invalid email+token with HTTP `400` HTML page.
2. Sets `marketingOptIn = false` on all `Payment` rows matching that email.
3. Returns an HTML confirmation. Transactional purchase emails are unaffected.

Example (token must be generated with the same secret the API uses):

```bash
# Invalid token returns 400 HTML
curl -i "$API_BASE_URL/api/unsubscribe?email=user@example.com&token=bad"
```

Operational note: rotating `JWT_SECRET` without setting a stable
`UNSUBSCRIBE_SECRET` invalidates outstanding unsubscribe links. Prefer a
dedicated `UNSUBSCRIBE_SECRET` in production.

## Account erasure (`DELETE /api/user/me`)

Requires couple-dashboard JWT (`verifyUserJWT`) plus password re-confirmation
in the JSON body. Rate-limited by `authLoginLimiter`.

```bash
curl -X DELETE "$API_BASE_URL/api/user/me" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password":"the-account-password"}'
```

| Outcome | Status | Notes |
| --- | --- | --- |
| Missing password | `400` | Body must include `password`. |
| Wrong password | `403` | Intentionally not `401` so the dashboard client does not treat it as session expiry. Audited as `account_delete_denied`. |
| Success | `200` | `{ ok: true, message: "Your account and personal data have been deleted" }` |

Deletion behavior (single DB transaction, then best-effort storage cleanup):

- Deletes invitation activity rows, template-swap requests, support tickets,
  reviews, and all owned events (guests/RSVPs/wishes/media/planning cascade).
- Keeps `Payment` rows for tax retention but clears `userId`,
  `customerEmail`, and `eventId`.
- Collects media / couple-photo / moodboard URLs before delete, then calls
  `objectStorage.tryDeletePublicUrl` best-effort after commit.
- Audits `account_deleted` and sends `sendAccountDeletedEmail` asynchronously.

## Guest-data retention job

Policy encoded in `dataRetention.service.js`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `WARNING_AFTER_DAYS` | 88 | Warn when `expiresAt` is at least 88 days in the past and no warning sent. |
| `DELETE_AFTER_DAYS` | 90 | Eligible for erasure when expiry is at least 90 days past. |
| `MIN_WARNING_LEAD_MS` | 48h | Erasure requires `guestDataWarningSentAt` at least 48 hours old. |
| `BATCH` | 200 | Max events processed per phase per run. |

Phase 1 - warnings:

- Selects events with `expiresAt`, no `guestDataWarningSentAt`, no
  `guestDataDeletedAt`.
- Events with zero guests and zero wishes are marked warned+deleted immediately
  so they are not rescanned.
- Otherwise sets `guestDataWarningSentAt` first (avoids duplicate mail on send
  failure), then emails the owner with a scheduled delete date and dashboard
  export link.

Phase 2 - erasure:

- Deletes `invitationEvent`, `rsvp`, `guestWish`, and `guest` rows for the
  event; sets `guestDataDeletedAt`.
- Does not delete the event itself or owner account data.

Manual run (same work as the 3:15 AM cron, plus auth-log prune):

```sh
npm run jobs:retention
```

First-deploy caveat: historic expired events receive warnings first; deletion
waits for the 48-hour lead on a later run.

## Auth audit log

`src/utils/authAudit.js` `logAuthEvent(event, req, details)` writes:

- Console line prefixed `[auth-audit]`
- Fire-and-forget `AuthAuditLog` row (`event`, `ip`, `userAgent`, optional
  `userId`, JSON `details`)

`userId` is not a foreign key so rows survive account deletion. Prune keeps
at least one statutory year by deleting rows older than 396 days
(`pruneAuthAuditLogs`).

## One-time DPDP notice script

Recipients: all `User.email` values plus `customerEmail` on `paid` payments,
deduped and lowercased.

```sh
npm run notify:dpdp                 # dry run - list recipients
node scripts/send-dpdp-notice.js --preview you@example.com
node scripts/send-dpdp-notice.js --send
```

Uses `LANDING_URL` privacy page and `COUPLE_DASHBOARD_URL` dashboard links.
Sends with a 500 ms delay between messages. Exit code is non-zero if any send
fails.

## Troubleshooting

- Checkout returns Terms/Privacy `400`: the client must send
  `"consent": true` (boolean), not a string.
- Abandoned emails never send: confirm `marketingOptIn` was true at order
  time, payment is still `pending`, age is inside 2-72h, and SMTP is
  configured.
- Unsubscribe page says invalid: token/secret mismatch, or email casing/
  encoding differs from the signed value (API lowercases before verify).
- Account delete returns `403`: password mismatch, not an expired JWT.
- Retention deletes nothing on first run after deploy: expected when only
  warnings were due; re-run after 48 hours or wait for the daily cron.
- Auth audit rows missing in DB but present in logs: DB write is
  best-effort; check `[auth-audit] DB write failed` in server logs.
