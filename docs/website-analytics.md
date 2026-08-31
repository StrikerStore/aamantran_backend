# Website analytics

First-party marketing-site analytics: anonymous session beacons, admin summary
APIs, daily rollups, and a 90-day raw-data prune. No third-party tracker SDK is
required on the API side.

## Architecture

- Public beacon: `POST /api/track` in `src/routes/track.js` (mounted from
  `src/routes/index.js`), rate-limited by `trackLimiter`.
- Admin reads: `GET /api/v1/analytics/summary` and
  `GET /api/v1/analytics/live` in `src/routes/adminAnalytics.js`, protected by
  admin JWT.
- Aggregation: `src/services/analyticsRollup.service.js`.
- Scheduler: daily `30 2 * * *` (2:30 AM) in `src/services/scheduler.js` runs
  rollup then prune.
- Manual job: `npm run jobs:analytics-rollup` (`scripts/run-analytics-rollup.js`).
- Models: `WebsiteSession`, `WebsiteEvent`, `WebsiteDailyStat` in
  `prisma/schema.prisma` (migration `20260704000000_website_analytics`).
- UA parsing: `src/utils/uaParser.js`. Geo fields come from Cloudflare request
  headers when present.

## Beacon contract (`POST /api/track`)

Accepts JSON (`application/json`) or `text/plain` JSON bodies so
`navigator.sendBeacon` stays a simple CORS request. Body limit for text:
16 KB.

Required fields:

| Field | Constraint |
| --- | --- |
| `sessionId` | Matches `^[a-zA-Z0-9-]{16,64}$`. |
| `type` | One of `pageview`, `view_template`, `initiate_checkout`, `purchase`, `register_complete`. |
| `path` | Non-empty string, stored up to 512 chars. |

Optional fields:

- `referrer` - full URL; stored as external hostname only. Own hosts derived
  from `LANDING_URL`, `API_BASE_URL`, and `COUPLE_DASHBOARD_URL` become
  `(direct)` / null.
- `utm.source` / `utm.medium` / `utm.campaign` - first-touch only (set on
  session create, never overwritten).
- `meta` - object serialized to at most 2000 JSON characters; ignored if
  larger.

Server-derived:

- `deviceType`, `browser`, `os` from `User-Agent`
- `country` / `region` / `city` from `cf-ipcountry`, `cf-region`, `cf-ipcity`

Behavior:

1. Upsert `WebsiteSession` by `sessionId`. Pageviews increment `pageViews` and
   refresh `lastSeenAt`.
2. Insert a `WebsiteEvent` row.
3. Always respond `{ ok: true }` on success or `{ ok: false }` on validation /
   failure (no detailed public error text).

Example:

```bash
curl -X POST "$API_BASE_URL/api/track" \
  -H "Content-Type: text/plain" \
  --data '{"sessionId":"11112222-3333-4444-5555-666677778888","type":"pageview","path":"/templates","referrer":"https://google.com/search","utm":{"source":"google","medium":"organic"}}'
```

Rate limit override: `RATE_LIMIT_TRACK_MAX` (see
`src/middleware/rateLimits.js` and `.env.example`).

## Admin endpoints

All require `Authorization: Bearer <admin-jwt>` from
`POST /api/v1/auth/login`.

### `GET /api/v1/analytics/summary`

Query params: `from` and `to` as `YYYY-MM-DD` (UTC day bounds). Defaults to the
last 30 UTC days ending now. Ranges longer than 92 days are clamped from `to`.

Response highlights (`ok: true`):

- `overview`: visitors, pageViews, liveVisitors (5-minute window),
  avgPagesPerVisit, funnel `purchases`, `paidOrders` (Payment rows with
  `status: paid` in range), conversionRate (`paidOrders / visitors`).
- `timeseries`: daily pageViews + distinct session visitors for pageviews.
- `sources`, `geo`, `devices`, `browsers`, `pages`, `funnel` stages
  (`Visitors`, then `view_template`, `initiate_checkout`, `purchase`,
  `register_complete`).

Invalid dates return `400` with `{ ok: false, message: "Invalid date range" }`.

### `GET /api/v1/analytics/live`

Returns sessions with `lastSeenAt` in the last 5 minutes and top active
pageview paths in that window.

```bash
curl "$API_BASE_URL/api/v1/analytics/summary?from=2026-07-01&to=2026-07-25" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl "$API_BASE_URL/api/v1/analytics/live" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Rollup and retention

- Rollup writes/updates one `WebsiteDailyStat` per completed UTC day that is
  missing or needs refresh, up to 120 days per run. Safe to re-run
  (idempotent upserts).
- Prune deletes raw `WebsiteEvent` rows older than 90 days and
  `WebsiteSession` rows whose `lastSeenAt` is older than 90 days. Daily stats
  remain for longer history.

```sh
npm run jobs:analytics-rollup
```

## Cloudflare geo headers

`cf-ipcountry` is generally available behind Cloudflare. `cf-region` and
`cf-ipcity` require enabling Cloudflare's visitor location headers managed
transform; without it, city/region breakdowns stay empty while country may
still populate.

## Troubleshooting

- Beacon returns `400`: check `sessionId` charset/length, allowed `type`, and
  non-empty `path`. Malformed `text/plain` JSON also fails.
- Beacon returns `500`: inspect `[track] failed:` server logs (usually DB).
- Admin `401`/`403`: use an admin JWT, not a couple-dashboard user token.
- Empty geo/city in summary: confirm Cloudflare proxying and location-header
  transform.
- Gaps after downtime: run `npm run jobs:analytics-rollup` to backfill
  completed days, then wait for prune only if raw retention must catch up.
- Conversion vs funnel mismatch: overview `paidOrders` counts paid `Payment`
  rows; funnel `purchase` counts distinct sessions that emitted a `purchase`
  beacon event.
