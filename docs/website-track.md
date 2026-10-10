# Website analytics beacon

`POST /api/track` records anonymous sessions and events for the marketing
sites. No auth. Mounted from `src/routes/index.js`.

This is the write path. Admin reads (`/api/v1/analytics/summary`, `/live`,
`/business`, `/insights`, `/trial-demos`) are separate, and their `from` /
`to` window is IST. Do not describe those reads with the UTC-day rule this
beacon used to be documented under.

Code: `src/routes/track.js`, allowlist in `src/lib/analyticsEvents.js`.
The website client that must send the same names is
`aamantran_website/lib/track.ts` (`TrackEventType`). A name longer than 32
characters, or a duplicate, throws when this process boots. `WebsiteEvent.type`
is `VARCHAR(32)`.

Guest invitation opens are not events here. `routes/render.js` writes
`InvitationEvent`. Nothing in the allowlist changes a live invitation or the
couple dashboard's open counts.

## Request

JSON, or a `text/plain` body that is JSON. `navigator.sendBeacon` uses
`text/plain` so the call stays a simple CORS request. The text parser limit
is 16 KB. A normal JSON post uses the app's 2 MB JSON limit.

Storefront is a field in that JSON, not a header. A custom header would
force a preflight, which `sendBeacon` cannot make. It is also not inferred
from the IP: an Indian visitor on the global site is global traffic.

| Field | Required | Rule |
| --- | --- | --- |
| `sessionId` | yes | `^[a-zA-Z0-9-]{16,64}$` |
| `type` | yes | One allowlist name below |
| `path` | yes | Trimmed, non-empty, stored up to 512 characters |
| `storefront` | no | `IN` or `INTL`. Anything else, including omitted, is stored as `IN`. |
| `referrer` | no | Full URL. Stored as the hostname, max 255, `www.` removed. |
| `utm.source`, `utm.medium`, `utm.campaign` | no | Trimmed, max 128. First touch only. |
| `meta` | no | Object. Kept only when `JSON.stringify` is at most 2000 characters. A larger object is dropped; the event is still stored. |

Validation failure is **400** `{ "ok": false }`. There is no public reason.
A database failure is **500** `{ "ok": false }`. Success is `{ "ok": true }`.

`referrer` hostnames that are this deployment, or a subdomain of it, are
stored as null (direct). The hosts come from `LANDING_URL`,
`LANDING_URL_INTL`, `API_BASE_URL`, and `COUPLE_DASHBOARD_URL`. Without the
international origin, every hop between the two sites would look like a new
referral.

Server-derived, on the session row only: `deviceType`, `browser`, `os` from
the User-Agent; `country`, `region`, `city` from `cf-ipcountry`,
`cf-region`, `cf-ipcity` when Cloudflare sends them.

## Session write

Two beacons from a first page (a pageview and another event) arrive
together. Prisma `upsert` reads then writes, so both used to insert and the
second hit the primary key. The client also logged that unique-constraint
error. The route does not upsert.

1. `createMany` one `WebsiteSession` with `skipDuplicates` (INSERT IGNORE).
2. If that inserted nothing (`count === 0`), `update` the existing row.
3. Insert one `WebsiteEvent`.

The insert sets referrer, UTM, device, geo, and storefront. Later beacons
only move `lastSeenAt` and, for `type: pageview`, increment `pageViews`.
Attribution is first touch, including storefront. A session created before
the global site can still have a null storefront; new beacons do not write
null. Admin reports treat null as India. This route does not.

`pageview` is the only type that increments `pageViews`. Other types still
create a session (with `pageViews: 0` if they win the insert) and an event.

## Allowlist

Funnel stages are the conversions. The nightly rollup's
`WebsiteDailyStat.conversions` is built from these alone
(`FUNNEL_STAGES`):

- `view_template`
- `initiate_checkout`
- `purchase`
- `register_complete`

`pageview` is its own count. It is not a conversion.

Interaction events are stored and can be queried. They are not conversions:

| `type` | Meaning |
| --- | --- |
| `demo_opened` | Live template demo opened from the storefront |
| `guest_demo_interaction` | Sample RSVP or wishes demo used |
| `planning_demo_interaction` | Sample planning workspace used |
| `checkout_error` | Checkout validation or API error shown |
| `payment_failed_return` | Buyer returned after a failed payment |
| `checkout_retry` | Buyer retried checkout after a failure |
| `try_demo_started` | Try-it sheet opened |
| `try_demo_created` | Personal demo link generated |
| `try_demo_opened` | Personal demo link opened |
| `try_demo_to_checkout` | Buyer left a personal demo for checkout |
| `occasion_interest` | Shopper asked about an occasion the shop does not stock |

`view_template` must include `meta.slug`. Catalogue ranking counts distinct
sessions on that slug over 30 days and ignores events whose metadata was
dropped. See `docs/catalogue-ranking.md`.

## Limits and retention

`trackLimiter`: `RATE_LIMIT_TRACK_MAX` requests per IP per 60 seconds,
default 120. The response on the cap is `{ "ok": false }`. The global
limiter still applies (default 600 per 15 minutes) because `/api/track` is
not skipped.

Raw `WebsiteSession` and `WebsiteEvent` rows are pruned after 90 days
(`RAW_RETENTION_DAYS`). Daily stats remain. A popularity window or an admin
funnel that looks at raw events cannot see past that prune.

Example:

```bash
curl -X POST "$API_BASE_URL/api/track" \
  -H "Content-Type: text/plain" \
  --data '{"sessionId":"11112222-3333-4444-5555-666677778888","type":"view_template","path":"/templates/mehendi","storefront":"IN","meta":{"slug":"mehendi"}}'
```
