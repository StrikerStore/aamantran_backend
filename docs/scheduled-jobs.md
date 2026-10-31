# In-process scheduler

All recurring work lives in the API process. `src/app.js` requires
`src/services/scheduler.js` for the side effect. Loading the app starts the
crons, before `listen`. There is no worker dyno and no database lock.

`npm run dev` (nodemon) starts a fresh set on every restart. Two replicas each
run every job. The callbacks do not return their promises, and `cron.schedule`
is called with no options, so node-cron's `noOverlap` stays false and would
not see the in-flight work anyway. A slow run does not block the next tick.

node-cron 4 interprets the expression with `Intl` in the process local zone
when `timezone` is omitted. `30 2 * * *`, `0 9 * * *`, and `15 3 * * *` are
not pinned to `Asia/Kolkata`. Set `TZ` on the host if those clocks should
match India. Hourly jobs select rows with `Date.now()` and do not care which
zone the cron expression used. The date-based email job is the exception:
`daysDiff` / `toMidnight` call `setHours(0, 0, 0, 0)`, which is local
midnight, so "7 days before" follows the process zone.

## Jobs

| Cron (local) | Function | Batch | After a send error |
| --- | --- | --- | --- |
| `0 * * * *` | `runOnboardingReminderJob` | 200 payments | Still sets `reminderSentAt`. The send error is logged (`[Email Error]`); the update is not inside the send. |
| `15 * * * *` | `runAbandonedCheckoutJob` | 200 payments | Stamps `abandonedEmailSentAt` before the send, including when a later paid row causes the send to be skipped. |
| `*/30 * * * *` | `runRsvpMilestoneJob` | 500 events | Still sets `lastMilestoneNotified`. |
| `0 9 * * *` | `runDateBasedEmailJob` | 500 events | Still sets `countdownEmailSent` or `postEventEmailSent`. |
| `30 2 * * *` | `runWebsiteAnalyticsRollupJob` then `pruneOldWebsiteData` | 120 UTC days | See `docs/analytics-rollup.md`. Prune does not run if the rollup throws. |
| `*/15 * * * *` | `purgeExpiredTrialDemos` | all matching rows | Deletes `TrialDemo` where `dataExpiresAt` has passed. A dead link can still have a row until then. |
| `15 3 * * *` | `runGuestDataRetentionJob` then `pruneAuthAuditLogs` | 200 events per phase | Warning stamp is written before the email. Audit prune uses its own cutoff. |

The four email crons use `.catch(() => {})`. A throw from Prisma, including a
failed stamp after a logged send error, is discarded with no log line. The
analytics, trial, and retention crons log `[analytics]`, `[trial-demo]`, and
`[retention]` respectively. A prune failure after a successful rollup is
logged as `[analytics] rollup job failed`.

Selection details (test-account filters, opt-in, milestone ladder, 2h-72h
abandoned window, 88/90 day guest erasure, 13 month audit prune) stay in the
function bodies:

- `src/services/scheduler.js` for the four email jobs
- `src/services/analyticsRollup.service.js`
- `src/services/trialDemo.service.js` (`purgeExpiredTrialDemos`)
- `src/services/dataRetention.service.js`

Email jobs spread `EXCLUDE_TEST_OWNER` or `EXCLUDE_TEST_EVENT`
(`src/utils/testFilters.js`). The analytics rollup does not. Website beacons
are not tied to the testing account.

## What a deploy already runs

`prestart` and `npm run db:deploy` (see `package.json`):

1. `prisma migrate deploy` (after a few `migrate resolve --rolled-back`
   attempts).
2. `node scripts/backfill-template-versions.js --apply`.
3. `node scripts/run-retention.js || true`.

Retention therefore runs on every boot, not only at 03:15. A failure of that
script does not fail the deploy (`|| true`). The 03:15 cron runs the same two
steps again. Warning and erasure stamps make the second pass skip work it
already finished.

Not run on boot: the analytics rollup, `scripts/backfill-person-slots.js`,
`scripts/backfill-review-ratings.js`, `scripts/audit-schema-labels.js`,
`scripts/backfill-invite-pair-settings.js`. The person-slot migration comment
claims deploy runs that backfill. `package.json` does not.

Manual equivalents that do load `.env`:

```sh
npm run jobs:analytics-rollup
npm run jobs:retention
```
