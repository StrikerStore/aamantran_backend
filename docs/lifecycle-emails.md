# Couple lifecycle emails

Scheduled transactional mail for paid-but-not-onboarded buyers and published
full-scope invitations. These jobs are not marketing: they do not check
`Payment.marketingOptIn` and they do not include unsubscribe links.

Abandoned-checkout recovery (pending PayU rows, opt-in gated) is a separate
job in the same scheduler. Website analytics rollup and DPDP guest-data
retention also share this process; they are not covered here.

## Architecture

Jobs start when the API process loads `src/app.js` (`require('./services/scheduler')`).
There are no standalone npm scripts. Cron expressions use the host timezone
(`node-cron`, no `timezone` option).

| Job | Cron | Function | Sender |
| --- | --- | --- | --- |
| Onboarding reminder | `0 * * * *` (hourly at minute 0) | `runOnboardingReminderJob` | `sendOnboardingReminderEmail` |
| RSVP milestones | `*/30 * * * *` | `runRsvpMilestoneJob` | `sendRsvpMilestoneEmail` |
| Countdown + thank-you | `0 9 * * *` (09:00 daily) | `runDateBasedEmailJob` | `sendEventCountdownEmail` / `sendPostEventThankYouEmail` |
| Abandoned checkout | `15 * * * *` | `runAbandonedCheckoutJob` | (marketing; not this doc) |
| Analytics rollup | `30 2 * * *` | `runWebsiteAnalyticsRollupJob` | n/a |
| Guest-data retention | `15 3 * * *` | `runGuestDataRetentionJob` | n/a |

HTML lives in `src/services/emailTemplates.js`. SMTP must be configured
(`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`; `SMTP_PORT` defaults to 587). Send
failures are logged as `[Email Error] ...` and swallowed with `.catch`, then
the per-row marker is still written -- so a failed send is not retried.

Test-account rows are excluded (`EXCLUDE_TEST_OWNER` / `EXCLUDE_TEST_EVENT`
in `src/utils/testFilters.js`).

## Onboarding reminder

Nudges buyers who paid but never finished
`/onboarding?paymentId=...` on the landing site.

### Selection

`Payment` rows, batch 200 per run:

| Condition | Value |
| --- | --- |
| `status` | `paid` |
| `isOnboarded` | `false` |
| `reminderSentAt` | `null` |
| `createdAt` | `<= now - 24h` |
| `customerEmail` | not empty string |
| Owner | not the test account |

Onboarding completion is written by `src/routes/publicCheckout.js` when the
buyer registers or links the paid row (`isOnboarded: true`, `onboardedAt`).

### Send

1. Build `{LANDING_URL}/onboarding?paymentId={id}&slug={template.slug}&template={template.name}`.
2. Send subject `Complete your Aamantran onboarding`.
3. Set `reminderSentAt = now`.

Unlike abandoned checkout, the marker is written **after** the send attempt.
A crash between send and update can duplicate; a logged SMTP error cannot,
because `.catch` swallows and the update still runs.

`isOnboarded` is independent of invitation publish. A couple can finish
onboarding and still be unpublished; this job only cares about the payment
flag.

## RSVP milestones

Notifies the couple when attending RSVPs cross 10, 25, 50, or 100.

### Selection

`Event` rows, batch 500 per run:

| Condition | Value |
| --- | --- |
| `isPublished` | `true` |
| `owner.email` | not empty |
| `inviteScope` | `null` or `full` (subset / paired invites are skipped) |
| `isTestEvent` | `false` |

Count: `Rsvp` rows with `attending: true` for that `eventId`.
`last` is the highest milestone `<= count`. Skip if
`(lastMilestoneNotified || 0) >= last`.

### Send

- Subject: `You reached {last} RSVPs`
- Link: `{COUPLE_DASHBOARD_URL}/dashboard`
- Then `Event.lastMilestoneNotified = last`

Only the highest newly crossed milestone is mailed (30 attending after a
notified 10 sends the 25 mail, not 10 again). Crossing two bands between
30-minute ticks still sends only the highest (50 attending from 0 sends 50).

Declines and `attending: false` do not count.

## Countdown and post-event thank-you

Same event filter as RSVP milestones. Requires at least one `Function` with a
parseable `date` (`Function.date` is `@db.Date`).

Day math uses local midnight (`setHours(0,0,0,0)`) and
`Math.round` of the millisecond delta / 86400000:

- `daysToEarliest` -- today vs the earliest function date
- `daysAfterLatest` -- days since the latest function date

### Countdown

Fires when `daysToEarliest` is `7` or `1` **and**
`countdownEmailSent !== daysToEarliest`.

- Subject: `{n} day` / `{n} days left for your event`
- Link: `{COUPLE_DASHBOARD_URL}/dashboard`
- Then `Event.countdownEmailSent = n` (so the 7-day mail does not block the
  1-day mail)

Missed days are not backfilled. If the process was down on the 7-day and
1-day midnights, those mails are skipped.

### Post-event

Fires when `daysAfterLatest >= 1` and `postEventEmailSent` is false.

- Subject: `Thank you for celebrating with Aamantran`
- Link: `{COUPLE_DASHBOARD_URL}/dashboard`
- Then `Event.postEventEmailSent = true` (once, forever)

Multi-day weddings use the latest function date, not the earliest.

## Operational checks

1. Confirm the long-lived API process is running. Cron does not tick in
   one-shot scripts (`npm run jobs:retention` etc. do not send these).
2. Startup already probes SMTP via `sendTestEmail` in `src/server.js`.
3. Inspect backlog (MySQL examples):

```sql
-- Paid, not onboarded, older than 24h, reminder not sent
SELECT id, customerEmail, createdAt, isOnboarded, reminderSentAt
FROM Payment
WHERE status = 'paid'
  AND isOnboarded = 0
  AND reminderSentAt IS NULL
  AND customerEmail <> ''
  AND createdAt <= (NOW() - INTERVAL 24 HOUR);

-- Published full-scope events and their markers
SELECT e.id, e.slug, e.lastMilestoneNotified, e.countdownEmailSent, e.postEventEmailSent
FROM Event e
WHERE e.isPublished = 1
  AND e.isTestEvent = 0
  AND (e.inviteScope IS NULL OR e.inviteScope = 'full');
```

To re-send after a confirmed SMTP outage, null the marker for that row only
(`reminderSentAt`, `lastMilestoneNotified`, `countdownEmailSent`, or
`postEventEmailSent`). Do not bulk-clear `countdownEmailSent` or you may
re-fire the 7-day mail on a later 7-day anniversary of a date change.

## Constraints and pitfalls

- Markers are written even when SMTP throws (`.catch` then update). Failed
  sends are not retried automatically.
- Onboarding reminder ignores `marketingOptIn`. That flag is for abandoned
  checkout only (`Payment.marketingOptIn` comment in `schema.prisma`).
- Subset invites (`inviteScope` other than null/`full`) never get RSVP or
  date mail. Admin-generated invite pairs use this to avoid mailing the
  secondary event.
- Events with zero functions never get countdown or thank-you mail.
- `countdownEmailSent` stores the day-count last sent (`7` or `1`), not a
  timestamp. Changing function dates can re-trigger if the new delta is 7 or
  1 and differs from the stored value.
- Batch caps: 200 payments / 500 events per tick. A large backlog takes
  multiple hours (onboarding) or several 30-minute passes (RSVP).
- Owner email must be non-empty. Users created without email will never be
  selected.
- URLs come from `src/config/siteUrls.js`. Unset `LANDING_URL` /
  `COUPLE_DASHBOARD_URL` fall back to localhost in development and
  `www.aamantran.online` / `app.aamantran.online` in production.
- These jobs do not export from `module.exports` for CLI use beyond the four
  function names; calling them from a REPL still requires a loaded Prisma
  client and SMTP.
