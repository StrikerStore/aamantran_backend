# Template testing account

Admin-only workflow that loads exactly one invitation into a permanent test
user so a template can be walked end-to-end as a real buyer would -- including
unpublished drafts -- without a payment and without making the design live.

## Intent

- QA a ZIP upload in the couple dashboard and on `/i/:slug` before publishing.
- Re-upload the draft ZIP and refresh the browser; no reload API call is needed
  when the test event is pinned to the mutable draft folder.
- Keep test traffic out of revenue, reviews, RSVP emails, retention, and
  invitation analytics.

Source of truth: `src/controllers/testing.controller.js`,
`src/services/testAccount.service.js`, `src/utils/testFilters.js`.

## Architecture

| Piece | Location |
| --- | --- |
| Admin routes (JWT) | `src/routes/testing.js` mounted at `/api/v1/testing` |
| Controller | `src/controllers/testing.controller.js` |
| Account + purge | `src/services/testAccount.service.js` |
| Shared Prisma filters | `src/utils/testFilters.js` |
| Shell provision | `npm run test:account` -> `scripts/ensure-test-account.js` |
| Scheduler / analytics exclusion | `EXCLUDE_TEST_EVENT` / `EXCLUDE_TEST_OWNER` |

Identity is the `User.isTestAccount` flag, not a magic username. Renaming
`TEST_ACCOUNT_USERNAME` does not orphan the row. `Event.isTestEvent` is a
denormalized copy written only by the testing load endpoint so Event-rooted
queries can filter without a join.

There is no User-Template join table. Ownership is `Event.ownerId`. The test
user holds at most one event; `load-template` deletes-and-recreates rather
than mutating, so counters and flags reset when a column is added later.

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `TEST_ACCOUNT_USERNAME` | `aamantran-test` | Forced lowercase; login also lowercases |
| `TEST_ACCOUNT_EMAIL` | `test@aamantran.online` | Used only on first create |
| `TEST_EVENT_SLUG` | `aamantran-test` | Stable invite slug; unique on `Event.slug` |
| `POLICY_VERSION` | `2026-07-08` | Written on first create (`User.policyVersion`) |

Passwords must pass `validateNewPassword` (`src/utils/authSecurity.js`): 8-128
chars, not a single repeated character, not in the common-password list.

## Admin API

All routes require the admin JWT (`src/middleware/auth.js`). Bodies are JSON
unless noted.

### GET `/api/v1/testing/status`

Never 500s on a missing user -- the admin Testing page uses this for empty
state.

```json
{
  "ok": true,
  "provisioned": false,
  "config": { "username": "aamantran-test", "email": "test@aamantran.online", "slug": "aamantran-test" },
  "user": null,
  "event": null,
  "urls": {}
}
```

When provisioned, `event.renderSource` is `draft` if `templateVersionId` is
null, else `current`. URLs (when an event exists):

| Key | Value |
| --- | --- |
| `invite` | `{API_BASE_URL}/i/{slug}` |
| `preview` | `{API_BASE_URL}/i/{slug}/preview?pt={24h JWT}` |
| `userDashboard` | `{COUPLE_DASHBOARD_URL}/events/{id}/edit` if published, else `/generate` |

Preview tokens come from `mintInvitePreviewToken` (`src/services/previewToken.js`):
issuer `aamantran:preview`, TTL 24h, signed with `JWT_SECRET`.

### POST `/api/v1/testing/account`

Idempotent create-or-adopt. Body: `{ "password"?: string }`.

- First create: generates a 12-char base64url password when `password` is
  omitted and returns it as `generatedPassword` exactly once.
- Existing row: sets `isTestAccount: true`. If `password` is sent, the hash is
  updated, but `generatedPassword` is always `null` on this path. Use
  `rotate-password` when you need the plaintext echoed back.

`409` if more than one `isTestAccount` row exists.

### POST `/api/v1/testing/rotate-password`

Body: `{ "password"?: string }`. Generates a password when omitted. Returns
`generatedPassword`. Rotation changes `User.passwordHash`, which invalidates
couple-dashboard JWTs because they carry a `pv` fingerprint of the hash
(`src/middleware/userAuth.js`).

### POST `/api/v1/testing/load-template`

```json
{
  "templateId": "uuid",
  "renderSource": "draft",
  "community": "universal",
  "eventType": "wedding",
  "language": "en",
  "publish": false
}
```

| Field | Constraint |
| --- | --- |
| `templateId` | Required. No `isActive` filter -- drafts are the point. |
| `renderSource` | `draft` (default) or `current` |
| `community` | Falls back to `template.community` then `universal` |
| `eventType` | Falls back to the first comma-separated `template.bestFor`, else `wedding` |
| `language` | Default `en` |
| `publish` | Default `false` |

`current` requires `template.currentVersionId`; otherwise `400`.
Purges every existing test event first, then creates one event with
`slug = TEST_EVENT_SLUG`, `isTestEvent: true`, and
`templateVersionId = null` (draft) or `template.currentVersionId` (current).
Does not send `sendTemplateChangedEmail`.

### POST `/api/v1/testing/publish`

Body: `{ "publish"?: boolean }` (default `true`). Sets `Event.isPublished`
without walking the wizard. Bypasses `namesAreFrozen` on purpose.

### POST `/api/v1/testing/repin`

Body: `{ "renderSource": "draft" | "current" }`. Flips `templateVersionId`
without deleting wizard data. Clears `EventRenderCache` for that event so the
next render is not stale.

### POST `/api/v1/testing/session`

Mints a 30-minute couple-user JWT (`issuer: aamantran:user`, secret from
`userJwtSecret()`). Refuses unless `isTestAccount` is true (`400`). Response
includes `token`, `expiresIn: 1800`, and `dashboardUrl`.

### POST `/api/v1/testing/reset`

Purges test events and uploaded files with no replacement. Required before a
template that is currently loaded can be deleted cleanly (see below).

## Draft vs current render

`src/routes/render.js` uses the pinned `TemplateVersion` folder when
`templateVersionId` is set. Otherwise it falls through to
`templates/{slug}/draft/`, which every ZIP re-upload rewrites.

Admin "publish changes" (`repointAllEventsToTemplateVersion` in
`src/controllers/templates.controller.js`) excludes `isTestEvent` rows so a
global publish cannot silently freeze the test invite onto a snapshot and
break the refresh loop.

Live test invites set `X-Robots-Tag: noindex, nofollow, noarchive` and skip
`InvitationEvent` open logging.

## What the test flags keep out

| Filter | Shape | Used by |
| --- | --- | --- |
| `EXCLUDE_TEST_USER` | `{ isTestAccount: false }` | Admin user list (unless `includeTest=1`) |
| `EXCLUDE_TEST_EVENT` | `{ isTestEvent: false }` | Cron, retention, version-repoint, published-invite delete guard |
| `EXCLUDE_TEST_OWNER` | `NOT { user: { is: { isTestAccount: true } } }` | Payments, reviews, tickets, website analytics |

`EXCLUDE_TEST_OWNER` is a negation on purpose. `userId` is nullable on Payment
and TemplateReview; account deletion de-identifies payments to `userId: null`
for tax retention. A bare `user: { isTestAccount: false }` would drop those
null-owner rows from revenue.

Hard blocks:

- Checkout onboarding refuses the test username (`403` in
  `src/routes/publicCheckout.js`).
- Couple review submit refuses the test user (`403` in
  `src/controllers/userDashboard.controller.js`).
- Self-serve `DELETE /api/user/me` refuses the test user (`403` in
  `src/controllers/accountDeletion.controller.js`) so a new provision does
  not mint a new id and break admin bookmarks.

## Template delete and version cleanup

`DELETE /api/v1/templates/:id` counts published non-test events. If only a
test invitation is using the template, `purgeTestEvents()` runs first so the
missing `onDelete` on `Event.templateId` cannot fail the delete.

`purgeTestEvents` must delete `InvitationEvent`, `TemplateSwapRequest`,
`SupportTicket`, and detach `Payment` before `Event` -- those four relations
have no `onDelete` in the schema. Ordering matches
`accountDeletion.controller.js`. Uploaded media / people / photo-wall /
mood-board / review photo URLs are collected first and deleted from object
storage after the transaction.

Version delete ignores test events when counting pins
(`EXCLUDE_TEST_EVENT`). If the test invite was pinned to that snapshot,
`Event.templateVersion` is `onDelete: SetNull`, so the row falls back to the
draft folder.

## Shell provision

```bash
npm run test:account
npm run test:account -- --password 'a-chosen-password'
```

Safe to re-run. The plaintext is printed only when `ensureTestAccount`
returns `generatedPassword` (first create). Passing `--password` on an
already-provisioned row still updates the hash, but the script prints
"password unchanged" because that return value is null. Use
`POST /api/v1/testing/rotate-password` (or delete the row and re-run) when
you need the password echoed.

## Pitfalls

- More than one `isTestAccount` row: every provision call 409s until the extra
  flags are cleared.
- Mixed-case `TEST_ACCOUNT_USERNAME` is lowercased at read time; login also
  lowercases. Do not create a second user with a different casing by hand.
- `POST /account` on an existing user does not echo a password. Rotate to get
  one.
- Session tokens last 30 minutes and die immediately on password rotate.
- Loading a template wipes the previous test invitation and its files. Pin
  with `repin` when you only want to switch draft/current.
- `publish` here is an admin shortcut and does not freeze names or send
  `sendInvitationPublishedEmail`.
- Do not register a real purchase under the test username; checkout blocks it
  so paid rows cannot re-enter analytics.
- Admin user list hides the test account unless `GET /api/v1/users?includeTest=1`.
- Cron jobs in `src/services/scheduler.js` exclude the test event/owner, so
  onboarding / RSVP / countdown mail will not fire for QA data.
- `TEST_EVENT_SLUG` must stay unique. Load/reset purge the old row first; a
  hand-created event with the same slug will make `load-template` fail.
