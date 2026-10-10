# Try it with your names

A visitor previews one active design with their own names, date, venue, and
events. No account, no payment, no contact field. The link works for
minutes. The typed details are kept a little longer so checkout can prefill
the builder, then the row is deleted.

Code: `src/services/trialDemo.service.js`, `src/routes/publicTrialDemo.js`,
`GET /try/:token` in `src/routes/render.js`. The admin report is
`GET /api/v1/analytics/trial-demos` and is a separate read path.

Env (already in `.env.example`):

| Variable | Default | Effect |
| --- | --- | --- |
| `TRIAL_IP_SALT` | unset | Salt for the IP hash. Unset skips the per-IP demo cap. |
| `TRIAL_DEMO_LINK_MINUTES` | 15 | How long `GET /try/:token` renders. |
| `TRIAL_DEMO_DATA_HOURS` | 24 | How long the payload may prefill a purchase. |
| `TRIAL_DEMO_PER_IP_CAP` | 5 | Demos per salted IP per rolling hour. |
| `TRIAL_DEMO_DAILY_CAP` | 2000 | Demos across everyone since local midnight. |
| `RATE_LIMIT_TRIAL_DEMO_MAX` | 5 | `POST /api/trial-demo` requests per IP per hour. |

The daily cap and the "date is in the past" check use the API process
timezone (`Date#setHours` / `new Date(y, m, d)`). That is not the IST
midnight the admin trial-demos screen uses for `createdToday`. Around
midnight the two counts disagree. Do not file or alert on them as one number.

## What the form may ask

`GET /api/trial-demo/options?slug=` uses `publicInviteLimiter`. The body is
`trialOptionsFor`, the same function the validator uses.

A design can be tried when it has `demoData` and at least one principal
person. Principals are schema roles (else demo people) that are not a
prefix of another role: `person2_father` belongs to `person2` and is not
asked. At most 3 people (`MAX_TRIAL_PEOPLE`). If the schema marks none as
required, every name asked for is required. If the schema has no people and
the demo still has `person1Name` and `person2Name`, the form asks for
`person1` and `person2`.

Events come from the demo's functions, in `sortOrder`, else from `bestFor`
terms. A name longer than 60 characters is dropped. If any offered name is
in the wedding set (Roka, Engagement, Haldi, Mehendi, Sangeet, Nikah,
Wedding, Reception), the whole set is offered, then any other names, cut at
10. A design with no events and no occasions offers a single "Celebration".
Wedding designs label the date "Wedding date"; every other design says
"Date of the celebration".

No slug: `{ ceremonies, expiresInMinutes }` in the old wedding-only shape,
so a browser still on the previous form survives a deploy. With a slug, an
inactive, sandbox, or unusable design is **404**. A usable response is
cached `public, max-age=60`.

`tryWithNames` on `GET /api/templates` is this same rule. The product page
sends only that boolean. Schema and demo data stay off the public template
payload.

## Create

`POST /api/trial-demo`. Body is validated, not trimmed into shape.
`TrialDemoError` is **400** with `{ message, field }`, except `field: "cap"`
which is **429**. Anything else is **500** with a generic message.

| Check | Field | Constraint |
| --- | --- | --- |
| Honeypot | `website` | Must be empty. |
| Speed | `startedAt` | If it is a positive number, the form must have been open at least 3 seconds. Omitted, the check is skipped. |
| Names | `people.<role>` | Letters (any script), marks, spaces, `.`, apostrophe, hyphen. Max 60. Digits and URL characters are refused. |
| Date | `eventDate` | `YYYY-MM-DD`, not rolled (no 31 Feb). Today through three years, in the process timezone. |
| Venue | `venueName` | Required. Letters, marks, digits, and ` ,.'-/&()`. Max 80. |
| City | `city` | Optional. Same character set as names. Max 60. |
| Events | `ceremonies` | 1 to 6. Each `name` must be one the server offered for this design (matched case-insensitively, stored with the server's spelling). Dates within 30 days before the main date through 7 days after, inclusive. Optional `time` is `hh:mm` or absent. No duplicates. |

An older client may still send `brideName`, `groomName`, and `weddingDate`.
Those become people and `eventDate`. Roles the design still calls bride or
groom are moved with `legacySlotMapFor` in `src/utils/personSlots.js`.

Caps, after the payload is valid:

1. The route limiter (`RATE_LIMIT_TRIAL_DEMO_MAX`).
2. `TRIAL_DEMO_DAILY_CAP` rows with `createdAt` since local midnight. All
   visitors, both storefronts.
3. `TRIAL_DEMO_PER_IP_CAP` rows with the same `ipHash` in the last hour.

The raw IP is never stored. `ipHash` is SHA-256 of `salt:ip`. No salt, or
no IP, means step 3 is skipped and only the route limiter applies. The
address is `req.ip` (`trust proxy` is on unless `TRUST_PROXY=0`).

**201** returns `{ token, url, linkExpiresAt, expiresInMinutes }`. `token`
is 32 hex characters. `url` is `{API_BASE_URL}/try/{token}`.

`storefront` is copied from `x-aamantran-storefront`, then the query, then
the body, and defaults to `IN` (`storefrontFromRequest`). It is not checked
against `Origin` here. The value is stored inside `payload` so a forwarded
link opens the site the demo was created on. Money is still decided later,
at order creation.

## Render

`GET /try/:token` does not read or write an `Event`, and it does not inject
the guest SDK. RSVP and wish submits are cancelled in the page and a toast
says nothing was sent.

| Lookup | HTTP | Page |
| --- | --- | --- |
| Token is not 32 hex chars, or the row is gone | 404 | Ended page |
| Link time is past, or the design is inactive, sandbox, or has no demo data | 410 | Same ended page |
| Live | 200 | Published template with the visitor's details over the sample |

The ended page and the live page use the same explanation: links last
`LINK_MINUTES`. Every response sets no-cache, `X-Robots-Tag: noindex,
nofollow, noarchive`, and `Referrer-Policy: no-referrer`. Helmet's
`frame-ancestors` is rewritten to `'self'` plus the India and international
landing origins, so either storefront can embed the preview.

Live HTML is the published `currentVersion` (draft folder only when the
design has no version), not the draft that `GET /demo/:slug` shows admins.
Sample photos, music, family, and dress codes stay. Names, date, venue, and
the chosen events are replaced. `person1` / `person2` also fill the old
couple fields. A sample name inside other sample text is swapped, longest
name first. The sample's `role_choice` is dropped so the design uses its
neutral wording.

Templates render with Handlebars `noEscape`. `inertText` rewrites a straight
apostrophe to a typographic one and strips `<>"\`{}` before the value is
placed in HTML, attributes, or an inline script. The character check on
create is the first line; this strip is the second.

Open Graph and Twitter tags from the template are removed and replaced with
a generic title and description, so a link preview does not keep the
visitor's names after the row is gone.

`viewCount` increments after a live render. The update is not awaited. A
failure there still returns the page.

While `dataExpiresAt` is in the future, the buy link is
`{landing}/checkout/{slug}?trial={token}` even on the 410 page. After the
data window, the token is left off. "Create a new demo" points at
`{landing}/templates/{slug}?try=1`. The landing host comes from the
storefront saved on the demo, not from the opener's query string.

## Purchase and prefill

`POST /api/checkout/order` accepts `trialToken`. `trialIdForOrder` attaches
the demo only when the token is 32 hex, the design matches, and
`dataExpiresAt` is still ahead. A wrong or expired token is ignored.
Checkout does not fail because of it.

The payment stores `trialDemoId` and `fromTrialDemo: true`. Deleting the
demo sets `trialDemoId` to null (`onDelete: SetNull`). `fromTrialDemo`
stays, and that is what analytics counts.

Prefill runs when registration creates the event
(`applyTrialPrefill` in `src/routes/publicCheckout.js`), after the payment
is bound to the user. It fills only an event that has no people, no
functions, no venues, and `namesAreFrozen` false, and only for the same
template. People, one venue, and functions are written the way the builder
writes them. Names stay unconfirmed for step 1. The demo row is then
deleted. The call never throws: a failure logs and returns false, and
registration still succeeds. The JSON field is `prefilled`.

Values are passed through `inertText` again. A token can be pasted into
someone else's checkout, and this text is what their live invitation will
render.

## Purge

`purgeExpiredTrialDemos` runs every 15 minutes (`src/services/scheduler.js`)
and deletes rows with `dataExpiresAt` in the past. Link expiry alone does
not delete the row. That gap is what makes prefill possible after the
preview has ended.
