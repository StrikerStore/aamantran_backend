# Catalogue ranking

Public gallery: `GET /api/templates` in `src/routes/publicTemplates.js`.
No auth. Rate limit: `publicInviteLimiter`
(`RATE_LIMIT_PUBLIC_INVITE_MAX`, default 200 per 15 minutes).

`sort=popular` (the default) orders designs by recent browsing and recent
sales. The other sorts are plain SQL.

| `sort` | Order |
| --- | --- |
| `popular` or omitted | In-memory score below, when the match set is small enough |
| `new` | `releasedAt` descending |
| `price-asc` / `price-desc` | Base `price` in paise, before GST |
| anything else | `buyerCount` descending, paginated in SQL |

Code: `src/services/popularity.service.js`.

## Score

Over a rolling 30 days (`WINDOW_DAYS`), not a calendar month and not IST:

```
score = paid orders x 50 + distinct sessions that opened the design
```

`PURCHASE_WEIGHT` is 50. That is a chosen exchange rate: about fifty extra
people opening a design match one extra sale. It is not measured from data.

| Signal | Source | Count |
| --- | --- | --- |
| Opens | `WebsiteEvent` where `type` is `view_template` and `metadata.slug` is set | `COUNT(DISTINCT sessionId)` per slug |
| Sales | `Payment` with `status: paid` and `createdAt` in the window | rows per `templateId` |

Opens are people, not page loads. Refreshing one design does not move it.
The slug has to be in event metadata. The URL path is not parsed, so a
gallery URL is not an open. If `meta` on `POST /api/track` is larger than
2000 JSON characters, the event is stored with no metadata and that open
does not count.

Sales exclude payments owned by a test account (`EXCLUDE_TEST_OWNER`). A
payment with no user is kept. Opens are not filtered that way: a test
session that sends `view_template` still counts. Both storefronts are in
the same ranking. There is no India-only or global-only popular order.

The window is `now` minus 30 times 24 hours. Raw events are pruned after
90 days (`RAW_RETENTION_DAYS` in `analyticsRollup.service.js`), so the
window sits inside what is still stored.

## Tie break

Equal scores use lifetime `buyerCount` (highest first), then `releasedAt`
(newest first; a missing date sorts last), then `id` as a string. The
order does not change between requests unless the signals change.

A design with no recent opens and no recent sales scores 0 and falls
through to that tie break. Lifetime sales still decide among designs
nobody has touched this month. They do not decide the top of the list
while anything has a positive score.

## When the old order is used instead

The score is computed in memory because SQL cannot `ORDER BY` the two
signals together. The handler loads the filtered set, ranks it, then
slices the page.

| Situation | What the caller sees |
| --- | --- |
| No opens and no sales in the window (`isEmpty`) | `buyerCount` descending. A new deployment behaves like the old catalogue. |
| The popularity query throws | Same fallback. The error is cached. |
| 500 or more designs match the filters | Same fallback, and only the first 500 by `buyerCount` are loaded. |

`POPULAR_RANK_MAX` is 500. The check is strict: 499 designs are ranked,
500 are not. `total` in the JSON is the real match count, so a catalogue
that large can report pages the response cannot fill. The comment in the
route says the live catalogue is under this cap.

## Cache

`getPopularitySignals` keeps one in-process cache for 10 minutes
(`CACHE_TTL_MS`). A design that starts selling shows up on the next
refresh after that, not on the next request. Each API process has its own
cache. `invalidatePopularity` clears it and is not called from any route.

A database error is cached as an empty ranking for the same 10 minutes.
The gallery still returns 200. It does not 500 because analytics failed.

## Filters that ranking sees

Bad query values are ignored, not rejected, so a stale gallery URL still
returns a catalogue.

| Query | Rule |
| --- | --- |
| `q` | `name` contains. Whitespace collapsed, then cut to 60 characters. Case follows the MySQL collation. |
| `community` | Exact match. |
| `eventType` | `bestFor` contains. Not an exact occasion. |
| `exclude` | Drop that `slug`. |
| `minPrice`, `maxPrice` | Paise, before GST, `>= 0`. A reversed pair is swapped. Non-numbers are dropped. |
| `limit` | 1 to 100, default 20. The sitemap asks for 100. |
| `page` | `>= 1`, default 1. |

Rows are `isActive` templates with no `sandboxOwnerId`. Each row includes
both INR and USD prices (`withUsdPrices`) so one cached response serves
both sites, plus `tryWithNames` from `canTryTemplate`. A failure loading
eligibility sets `tryWithNames` false and hides the button. `aboutText` is
not returned; `aboutExcerpt` is.

`GET /api/templates/stats` and the review routes on this router do not use
the popularity score.
