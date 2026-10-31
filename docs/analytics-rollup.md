# Website analytics rollup

Nightly job that writes one `WebsiteDailyStat` row per completed UTC day per
storefront, then deletes raw beacon rows older than 90 days.

The admin Analytics tab does not read this table. `GET /api/v1/analytics/summary`
and the business and marketing controllers query `WebsiteSession` and
`WebsiteEvent` directly (`src/controllers/websiteAnalytics.controller.js`).
After the prune, that UI only sees what is still inside the raw window. The
stat rows are a write-only archive unless something queries them by hand.

Code: `src/services/analyticsRollup.service.js`, cron in
`src/services/scheduler.js`, manual entry `scripts/run-analytics-rollup.js`
(`npm run jobs:analytics-rollup`). Beacon writes are `POST /api/track` in
`src/routes/track.js`. Event names are `src/lib/analyticsEvents.js`.

## Schedule and clock

| Piece | Value |
| --- | --- |
| Cron | `30 2 * * *`, process local time. No `timezone` option. |
| Day boundary inside the job | UTC. `utcDayStart` uses `getUTC*` methods. |
| Days written per invocation | At most `MAX_DAYS_PER_RUN` (120), then it stops. |
| Day skipped as incomplete | The UTC date that contains `new Date()` when the job runs. |

A host in `Asia/Kolkata` fires at 02:30 IST, which is 21:00 UTC the previous
date. The UTC day still in progress is left for a later run. Changing `TZ`
moves the trigger. It does not change which UTC day counts as finished.

Deploy does not run this job. `prestart` and `npm run db:deploy` call the
retention script, not the rollup. A process that is down at 02:30 simply
misses that night; the next successful run is what catches up, subject to the
120-day cap below.

## What one day stores

`rollupDay` always writes both storefronts, in order `IN` then `INTL`, even
when a side has no traffic. An empty side is a row of zeros, not a missing
row. Unique key is `(date, storefront)`.

`IN` sessions are `storefront = 'IN'` or `NULL`. `NULL` is traffic from before
the global site. `INTL` is exactly `INTL`. New beacons do not store `NULL`:
`normalizeStorefront` turns a missing or unknown value into `IN`
(`src/utils/storefront.js`). Events have no storefront column; they inherit
the session's.

| Column | Rule |
| --- | --- |
| `visitors` | `WebsiteSession` rows whose `firstSeenAt` is inside the UTC day. Not "sessions that did something that day". |
| `pageViews` | `WebsiteEvent` rows with `type = 'pageview'` and `createdAt` inside the day. Other event types do not add to this number. |
| `sources` | JSON map. Label is `utmSource`, else `referrer`, else `(direct)`. Grouped by the pair, then summed into that label. |
| `devices` | JSON map. Missing `deviceType` is `Unknown`. |
| `countries` | JSON map. Missing `country` is `Unknown`. |
| `conversions` | JSON map of funnel stage to distinct `sessionId`. Stages with no sessions are omitted, not stored as `0`. |

The window is inclusive: `firstSeenAt` / `createdAt` from UTC midnight through
the last millisecond before the next midnight (`DATETIME(3)`). A timestamp
exactly on the next midnight belongs to the next day.

`conversions` uses `FUNNEL_STAGES` only: `view_template`,
`initiate_checkout`, `purchase`, `register_complete`. A session that emits the
same stage twice counts once. `pageview` and the interaction events
(`demo_opened`, `try_demo_created`, `occasion_interest`, and the rest of
`INTERACTION_EVENTS`) never enter this object. Paid-order counts are not
rolled up at all. The admin summary's conversion rate is
`Payment.status = paid` over visitors, computed live, and is a different
number.

The admin timeseries is also a different visitor definition: distinct sessions
that had a `pageview` on an IST calendar day. Do not reconcile it against
`WebsiteDailyStat.visitors`.

## How the cursor moves

`runWebsiteAnalyticsRollupJob`:

1. If any `WebsiteDailyStat` exists, start at the latest `date` plus one UTC
   day. Storefront is not part of that lookup. One row for a date blocks every
   earlier date and that date itself.
2. If the table is empty, start at the UTC day of the oldest
   `WebsiteEvent.createdAt`. If there are no events, return without writing.
3. Call `rollupDay` while the cursor is strictly before today's UTC midnight,
   and stop after 120 days. Log `[analytics] rolled up N day(s)` when N > 0.

Re-running is safe only in the sense that it will not double-count days it
skips. The upsert would refresh a day that is actually processed. The cursor
does not select those days again. There is no flag to rebuild one date.

Consequences:

- A hole (a missing date while a later date exists) is never filled.
- A crash after the `IN` upsert and before the `INTL` upsert leaves that date
  as the latest row. The next run starts the following day. That date never
  gets an `INTL` row.
- Rows already present before migration `20260906120000_international_pricing`
  were stamped `storefront = 'IN'` by the column default. They are not split
  and not recomputed. They have no `INTL` sibling.
- To rebuild from a date forward, delete every stat row from that date through
  the latest date, then run the job while the raw events for those days still
  exist. Deleting only the days you care about, and leaving a newer row, does
  nothing.

## Prune

`pruneOldWebsiteData` runs only after a rollup attempt returns. The cron chains
them with `.then`. A throw from the rollup skips the prune and logs
`[analytics] rollup job failed`. A throw from the prune uses that same log
line. The npm script always calls both, in that order, and has no dry-run and
no skip-prune switch. `process.exit(1)` on failure.

| Target | Delete when |
| --- | --- |
| `WebsiteEvent` | `createdAt` is more than 90 x 24 hours before `Date.now()`. |
| `WebsiteSession` | `lastSeenAt` is more than 90 x 24 hours before `Date.now()`. |

The cutoff is a rolling instant, not a UTC midnight. Events are deleted first.
Sessions deleted in the second step also drop their events (`onDelete:
Cascade`). Every accepted beacon updates `lastSeenAt`, so a session that is
still receiving events is kept, while its events older than 90 days are
removed. Stat rows are never pruned.

## Catch-up can drop days

One invocation rolls at most 120 completed days and then deletes raw rows
older than 90 days. Days outside that 120, and already older than 90 days,
are pruned before a later run can aggregate them. The following run still
writes the storefront rows; the counts are zero because the events are gone.

If the newest stat row (or the oldest event, when the table is empty) is far
behind, run `npm run jobs:analytics-rollup` in a loop until a run logs that it
rolled fewer than 120 days. Do this while the raw rows you care about are
still inside 90 days. Nothing in `prestart` does this for you.

```sh
npm run jobs:analytics-rollup
```

The script loads `.env` via `dotenv`. It needs `DATABASE_URL`. It does not
start the HTTP server and does not schedule a repeat.
