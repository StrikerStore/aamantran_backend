# Admin analytics

Admin JWT (`issuer: aamantran:admin`, `role: admin`). Mounted at
`/api/v1/analytics`.

| Method | Path | Answers |
| --- | --- | --- |
| GET | `/summary` | Visitors, page views, sources, geo, devices, funnel |
| GET | `/live` | Who is on the site in the last 5 minutes |
| GET | `/business` | What was sold: revenue, gateways, designs, follow-ups |
| GET | `/insights` | Channels, designs, timing, and plain-sentence findings |
| GET | `/trial-demos` | "Try it with your names": live demos, the last day, history |

Code: `src/routes/adminAnalytics.js`,
`src/controllers/websiteAnalytics.controller.js`,
`src/controllers/businessMetrics.controller.js`,
`src/controllers/marketingInsights.controller.js`,
`src/utils/istDate.js`.

`/summary`, `/business`, `/insights`, and `/trial-demos` share one range
parser and one storefront rule. `/live` uses the storefront rule only.

## Date range

`from` and `to` are `YYYY-MM-DD`, read as India Standard Time calendar
days. IST is a fixed UTC+5:30.

| Query | Window |
| --- | --- |
| both omitted | Start of the IST day 29 days before today, through the current instant. That is 30 IST dates, with today partial. |
| `to` omitted | `from` at 00:00 IST, through now. |
| `to` set | That IST day through 23:59:59.999 IST. |

`2026-08-01` starts at `2026-07-31T18:30:00.000Z`. The JSON `range.from`
and `range.to` are those UTC instants. A rolled date such as `2026-02-31`,
a non-date, or a `from` after `to` is **400**
`{ "ok": false, "message": "Invalid date range" }`.

A window longer than 92 times 24 hours is shortened by moving `from`
forward. The call still returns 200. There is no error body for the clamp.

Day buckets are IST dates, not the UTC date of the stored timestamp:

- `/summary` timeseries and the `/insights` and `/trial-demos` daily
  series use `DATE(DATE_ADD(createdAt, INTERVAL 330 MINUTE))`.
- `/business` `daily[].date` shifts the payment timestamp by the same
  offset in process memory (`YYYY-MM-DD`).
- `/insights` `timing.timezone` is `IST`.
- `/trial-demos` `settings.createdToday` counts rows since midnight IST.

`/live` ignores `from` and `to`. It counts sessions with `lastSeenAt` in
the last 5 minutes, and the top 10 pageview paths in that same window.

This inclusive end-of-day range is for the admin screens. The GST report
uses its own half-open IST range (`src/utils/istDate.js` `istRangeUtc`).

## Storefront

`storefront` is `IN` or `INTL`. Anything else, including the empty string
the admin sends for "All", means both sites. A bad value shows more data
rather than one site's numbers labelled as the whole business. The JSON
field is `IN`, `INTL`, or `ALL`.

Sessions recorded before the global site existed have a NULL storefront.
Those rows are India traffic, so `IN` includes NULL. `INTL` is exact.
`Payment.storefront` is never null, so `IN` payments are only `IN`.

## Business figures

`GET /api/v1/analytics/business?from&to&storefront`

`Payment.amount` is minor units of that row's currency (paise, cents).
Every revenue list is split by currency. `revenue[]` has `paidAmount`,
`paidOrders`, `refundedAmount`, `refundedOrders`.

Rows are selected by `Payment.createdAt` inside the range, then split by
the row's current `status`. A payment that is later marked `refunded`
leaves the paid totals of the week it was created and shows under
`refundedAmount` for that same created-at week. Refunds are listed beside
revenue; they are not subtracted from `paidAmount`.

`previousRevenue` is the immediately previous window of the same length
(`previousRange` in the response).

`topTemplates` is at most 8 designs, ordered by paid order count then
amount. Sandbox templates are omitted from the name lookup; a payment
whose design is missing is labelled "Unknown design".

`attention`:

| Field | Scope |
| --- | --- |
| `openTickets` | Every open ticket. The date range and storefront are not applied. |
| `paidNotOnboarded` | `status: paid`, `isOnboarded: false`, `createdAt` in range. Keyed on `isOnboarded`, so a payment whose user was deleted (`userId` null) is still a row, and is counted only when that flag is false. |
| `stuckPending` | `pending` payments created in the range and at least 60 minutes ago. |

`conversion.rate` is paid orders divided by visitor sessions, as a
percentage. It is a rate, not a headcount.

Payments and reviews owned by a test account are excluded. A payment with
no user is kept. See `EXCLUDE_TEST_OWNER` in `src/utils/testFilters.js`.

## Insights

`GET /api/v1/analytics/insights` uses the same range and storefront.

Website sessions and events are the anonymous first-party trail, pruned
after 90 days (`RAW_RETENTION_DAYS` in `analyticsRollup.service.js`).
Tracked purchases undercount (ad blockers, closed tabs). Channel rates
come from that trail. Order counts and revenue come from `Payment`.

`insights[]` is `{ tone, title, detail, action }` with `tone` one of
`good`, `warn`, `info`. A rule stays silent under its sample floor:
20 visitors for a channel, 40 for a channel with traffic and no sales,
15 design viewers, 5 try-it sessions on each side of the comparison.
The tables (`channels`, `templates`, `timing`, and the rest) are still
returned when no sentence is.

`compare` is visitors, checkouts, try-it creates, and paid orders against
the previous window of the same length. `change` is a whole-number
percent, or null when the previous value is 0.

## Try-it demos

`GET /api/v1/analytics/trial-demos`

The response never includes what a visitor typed: no names, venue, city,
or date. `live[]` is design, age, view count, ceremony count, storefront,
and whether a payment row exists. At most 50 rows whose link has not
expired (`TRIAL_DEMO_LINK_MINUTES`, default 15).

Three clocks show up together:

| Field | Clock |
| --- | --- |
| `settings.createdToday` | Trial rows since midnight IST. The storefront filter is not applied. |
| `last24h` | Trial rows created in the rolling last 24 hours (the purge keeps them for `TRIAL_DEMO_DATA_HOURS`, default 24). Filtered to the requested storefront. A missing `payload.storefront` counts as `IN`. |
| `funnel`, `daily`, `designs`, `sales` | The `from` / `to` range, on website events and on `Payment`. |

`last24h.openedMoreThanOnce` counts links opened more than once (usually
forwarded). `sales.revenue` is paid `Payment` rows with `fromTrialDemo:
true`, minor units, per currency. `sales.shareOfAllPaid` is those paid
demo orders over all paid orders in the range. Demo rows themselves are
gone after the data window; `Payment.fromTrialDemo` is what outlives them.

`lead[]` buckets how far away the occasion is, from event metadata:
`under_1m`, `1_3m`, `3_6m`, `6_12m`, `over_12m`. `ceremonies` is the top
12 ceremony names from that metadata (names longer than 60 characters are
skipped, and the query reads at most 5000 events).
