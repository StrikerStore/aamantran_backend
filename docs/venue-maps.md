# Venue map links

A live invite can show two map stores that were written by different
rules. `Venue` is a place row. `Function` also carries its own
`venueName`, `venueAddress`, `venueLat`, `venueLng`, and `venueMapUrl`,
and may point at a `Venue` via `venueId`. The parser that fills
coordinates from a Google URL runs on only one of the admin writes.

## Where the columns live

| Store | Map columns | Who parses a URL into lat/lng |
| --- | --- | --- |
| `Function` | `venueMapUrl` `VarChar(2048)`, `venueLat` `Decimal(10, 8)`, `venueLng` `Decimal(11, 8)` | Admin function save only, via `resolveFunctionVenueMap` |
| `Venue` | `mapUrl` `VarChar(2048)`, `lat` / `lng` same decimal sizes | Nobody. The body is stored as sent. |
| `TemplateDemoFunction` | `venueMapUrl` only. No lat/lng columns. | Nobody. `/demo` renders that URL and an empty `venues` array. |

`src/utils/mapsParse.js` exports `parseGoogleMapsLocation`. It does not
fetch the link. A short share URL stays a URL with null coordinates,
which `resolveFunctionVenueMap` allows on purpose.

The first match wins. The whole string is trimmed. There is no
percent-decoding.

| Input shape | Result |
| --- | --- |
| The entire string is `lat, lng` (optional space). Each number has 1 to 3 digits before the decimal. | That pair, if lat is -90..90 and lng is -180..180. `0, 0` is kept. `91, 0` is null. A third number (`12.97, 77.59, 15`) is null. |
| `@lat,lng` anywhere in the string | That pair. A place URL that also has `!3dlat!4dlng` returns the `@` camera, not the pin. |
| `!3dlat!4dlng` | That pair, when no `@` matched. |
| `?q=` or `&q=` then `lat,lng` or `lat+lng` | That pair. `q=12.97%2C77.59` is null. `query=` is not `q=`. `q=loc:12.97,77.59` is null. |
| `https://maps.app.goo.gl/...`, a place-name search, or anything else | null |

Checked against `parseGoogleMapsLocation` in that file:

```text
12.9716, 77.5946                                          -> 12.9716, 77.5946
https://www.google.com/maps/@12.9716,77.5946,15z         -> 12.9716, 77.5946
.../place/Hall/@12.5,77.5,17z/data=!3d12.9!4d77.6        -> 12.5, 77.5
https://maps.google.com/?q=12.9716+77.5946               -> 12.9716, 77.5946
https://www.google.com/maps/search/?api=1&query=12.97,77.59 -> null
https://maps.app.goo.gl/abc123                           -> null
```

## Admin function save

`resolveFunctionVenueMap` in `src/controllers/users.controller.js` runs
for every function on:

- `POST /api/v1/users/:id/generate-invites`
- `PUT /api/v1/users/:id/event-data` when `functions` is an array

Rules, in order:

1. Trim `venueMapUrl`. Over 2048 characters is 400 `Map link is too long (max 2048 characters)`. Blank becomes null.
2. A non-empty link must start with `http://` or `https://` (case-insensitive). Anything else is 400 `Map link must be a valid http(s) URL`.
3. Empty lat or lng is null. A non-numeric value is also null (`Number` then `NaN`).
4. The parser runs only when the link is set and both coordinates are null. A failed parse keeps the link and leaves both null. Short links take this path.
5. If either coordinate is set, both are required and must be in range. 400 otherwise: `Provide both latitude and longitude, or only a map link, or leave map fields empty` or `Latitude or longitude out of valid range`.
6. Coordinates sent by the client are kept. The URL is not allowed to overwrite them. `0` is a real coordinate, not a blank.

`PUT` event-data replaces the function list (update by id, create when
there is no id, delete ids that were omitted). Ids must already belong
to that event. The write sets name, date, `startTime`, inline venue
fields, dress code, and sort order. It does not set `venueId`,
`endTime`, or `notes`, so a previous `venueId` stays.

Sort orders must be unique non-negative integers. An omitted sort order
becomes the array index. The same parsed coordinates are copied onto the
subset invite's functions; only the selected indices are copied.

## Admin venue rows

`generate-invites` and `PUT` event-data store `venues[]` without
`parseGoogleMapsLocation` and without the http or range checks.

- `lat` / `lng` are `Number(...)` when the field is not null, so `0` is
  kept. The function parser is not used.
- `mapUrl` is the string, or null when empty. Length is left to the
  `VarChar(2048)` column.
- Generate copies every venue onto both the full and the subset event.
  It does not set `Function.venueId`, so the new functions and the new
  venue rows are not linked.
- On event-data, if `venues` is present, every function on that event
  has `venueId` cleared, the old venue rows are deleted, and the new
  rows are inserted with no `venueId` pointing at them. This runs after
  the function replace.

A save that sends functions but not venues therefore leaves a stale
`venueId` in place. A save that sends both unlinks them.

## Couple dashboard

Mounted at `/api/user/events` (`src/routes/userEvents.js`), all behind
the couple JWT. `addVenue`, `updateVenue`, `addFunction`, and
`updateFunction` in `src/controllers/userDashboard.controller.js` do
not call the parser.

- Create uses `lat ? parseFloat(lat) : null` (same for lng). JSON `0`
  is falsy and is stored as null. The string `"0"` is truthy, so it is
  stored as 0. Update does the same when the key is present.
- Create stores `mapUrl || null` and `venueMapUrl || null`. Update
  writes the value whenever the key is present, including `""`.
- There is no http check, no 2048 check, and no lat/lng range check in
  these handlers. A non-numeric lat is `parseFloat` `NaN` and fails in
  Prisma rather than as a 400.
- `venueId` on a function is whatever the body sent (`venueId || null`
  on create, the raw value on update).

## What the invite actually renders

`buildInvitationData` in `src/services/templateRenderer.js` prefers the
linked `Venue` and falls through per field:

- `venue_name` and `venue_address`: venue, then the function inline value
- `venue_map_url`: `venue.mapUrl` if truthy, else `function.venueMapUrl`
- `venue_lat` / `venue_lng`: the venue number when it is not null
  (so `0` wins), else the function number, else `""`

A linked venue with a name and a null lat shows the venue name and the
function's coordinates. A linked venue with an empty `mapUrl` shows the
function's link. After an admin save that left `venueId` set, the new
inline link is hidden whenever the linked row has its own `mapUrl`.

`venues[]` in the same payload is the venue rows only, mapped to
`map_url`, `lat`, `lng`. Templates that loop `venues` and templates
that loop `functions` can disagree, because generate-invites writes
both and does not link them.

The public RSVP payload (`GET /api/public/functions/:eventSlug`) returns
id, name, and date. It does not return the map. The SDK function list
injected on the invite page is also id, name, and date. Map fields
reach the HTML only as Handlebars data.

A subset invite renders its own functions and venues.
`withPairPhotos` in `src/routes/render.js` replaces people and media
with the full invite's rows and leaves maps on the subset.

`/demo/:slug` uses `buildDemoData`. `venues` is always `[]`. Each
function gets `venue_map_url` from `TemplateDemoFunction.venueMapUrl`
and no coordinates. ZIP upload copies `venue_map_url` onto that column
as text (`src/controllers/templates.controller.js`).

## Links that never become a pin

Trial demos build a search URL, not a coordinate URL
(`mapSearchUrl` in `src/services/trialDemo.service.js`):

```text
https://www.google.com/maps/search/?api=1&query={venue}, {city}
```

`parseGoogleMapsLocation` returns null for that string. `/try` lays it
onto the demo function as `venueMapUrl`. Prefill
(`applyTrialPrefill`) writes the same URL to a new `Venue.mapUrl` and
to `Function.venueMapUrl`, sets `venueId`, and does not set lat/lng.
The rendered pin fields stay empty. The link still opens a search.

Lab sandbox seed (`src/services/sandboxSeed.service.js`) stores
`https://maps.google.com/?q=Green+Lawns+Pune` (and the other preset
names) on both the venue and the function, links them with `venueId`,
and does not set lat/lng. `q=` is a place name, so the parser would not
fill coordinates even if a later admin save ran it.
