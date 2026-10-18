# Full and partial invite pairs

A couple can publish two public links for the same celebration: a **full**
invite (every function) and a **partial** invite (a chosen subset). They share
Links & Guests settings and one guest list in the dashboard, but guests and
RSVPs are stored on the invite they were submitted from.

## Intent

- Send a shorter link to guests who are only invited to some ceremonies.
- Keep Instagram / website / RSVP / wishes toggles identical on both links.
- Show every RSVP in one couple-dashboard list, tagged with which link it
  came through.

Source of truth: `src/controllers/userDashboard.controller.js`
(`PAIR_SHARED_FIELDS`, `syncPairSharedFields`, `getPairEventIds`),
`src/routes/publicInvite.js`.

## Architecture

| Piece | Location |
| --- | --- |
| Pair create / publish | `PATCH /api/user/events/:id/publish` |
| Shared-field edits | `PUT /api/user/events/:id` |
| Subset function list | `PATCH /api/user/events/:id/partial-functions` |
| Public RSVP / wishes | `src/routes/publicInvite.js` |
| Guest list + CSV | `listGuests` / `exportGuestsCSV` (pair-wide) |
| Drift repair | `npm run db:backfill-pair-settings` -> `scripts/backfill-invite-pair-settings.js` |
| Renderer override | `src/services/templateRenderer.js` (Links & Guests after `...custom`) |

Identity is `Event.invitePairId` (a UUID written on both rows) plus
`Event.inviteScope` (`full` or `subset`). Unpaired events have both null.
The partial row is a **copy** of people, venues, selected functions, custom
fields, and media -- not a live join. Function ids on the subset are new
rows; public RSVP `functionIds` must be ids from **that** invite.

## Shared vs per-invite

`PAIR_SHARED_FIELDS` -- mirrored onto every other row in the pair on update
and re-applied from the full invite on every republish:

- `language`
- `instagramUrl`
- `instagramHashtag`
- `socialYoutubeUrl`
- `websiteUrl`
- `rsvpEnabled`
- `guestNotesEnabled`

Deliberately **not** shared:

| Field | Why |
| --- | --- |
| `slug`, `subdomain` | Each link is its own URL |
| `expiresAt` | Derived from that invite's function dates (+ 6 months) |
| Functions | The subset is the point of the partial invite |
| People / venues / media / custom fields | Copied at publish / function-list edit, not continuously synced |

Hashtags are stored bare (no leading `#`, max 120) via
`normalizeOptionalHashtag`. The renderer exposes `{{hashtag}}` (`#...`) and
`{{hashtag_raw}}`.

## Publish

`PATCH /api/user/events/:id/publish`

```json
{
  "slugFull": "arjun-meera",
  "createPartial": true,
  "partialSlug": "arjun-meera-sangeet",
  "partialFunctionIds": ["<function-id>", "..."]
}
```

Constraints:

- Names must already be frozen (`namesAreFrozen`).
- `partialSlug` is required when `createPartial` is true (falls back to
  `{fullSlug}-partial` if omitted but still must be non-empty after slugify).
- Partial slug must differ from the **effective** full slug (including a
  rename in the same request). Collision is 400, not a unique-index 500.
- If `invitePairId` already exists, publish does **not** recreate the subset.
  It flips `isPublished` on both rows, refreshes subset `expiresAt`, and
  copies `readPairSharedFields(full)` onto the partial -- including for pairs
  that drifted before sync existed.
- The subset clones `templateVersionId` so both links render the same pinned
  bundle.
- `createPartial` with an empty `partialFunctionIds` is ignored; the full
  invite publishes alone.

## Public guest input

`POST /api/public/rsvp` and wishes require the invite `isPublished`.

| Input | Stored on | Toggle |
| --- | --- | --- |
| RSVP | The event for `eventSlug` (partial stays on the partial row) | `rsvpEnabled === false` -> 403 `RSVP is not enabled for this invitation` |
| Wish | The **full** invite (`resolveWishOwnerEventId`) so both walls share one list | `guestNotesEnabled === false` -> 403 / empty GET |

RSVP `functionIds` must belong to that invite's function list. If the guest
sends none and the invite has exactly one function, that id is filled in;
several functions and no ids is 400.

Per-IP cap: 5 RSVPs or wishes per 10 minutes (`publicInvite.js` in-memory
map), plus the shared `publicInviteLimiter`.

Dashboard `listGuests` / CSV span `getPairEventIds` and tag each guest with
`inviteScope` + `inviteSlug`. `listWishes` reads `eventId = :id` only --
open the **full** event in the dashboard to moderate wishes posted from
either link.

## Renderer

After spreading custom fields, `templateRenderer` re-applies Links & Guests
from the Event columns (`instagram_url`, `hashtag`, `hashtag_raw`,
`social_youtube_url`, `website_url`). A leftover custom field of the same
key cannot shadow what the couple typed on that screen. Demo data uses the
same override (`TemplateDemoData` columns win over demo custom JSON).

## Backfill

Pairs created before sync-on-update can have a partial invite whose
`rsvpEnabled` is still the old default. That made `POST /api/public/rsvp`
return 403 on the short link.

```
npm run db:backfill-pair-settings              # dry run
npm run db:backfill-pair-settings -- --apply   # write
```

Source of truth per pair is `inviteScope = 'full'`. Per-invite fields are
never touched. Idempotent: only rows that differ are written. Orphan pairs
with no full row are counted and skipped.

`prestart` / `db:deploy` do **not** run this script. Run it once after
deploying the sync change against existing data.

## Pitfalls

- Editing Links & Guests on the full invite now mirrors to the partial.
  Editing slug or functions does not.
- RSVP milestone mail (`runRsvpMilestoneJob`) counts attending RSVPs on the
  **full** event id only. Guests who RSVP on the partial link are visible in
  the dashboard but do not increment that counter.
- Countdown / thank-you jobs also select `inviteScope` null or `full` and
  use the **full** invite's function dates, not the subset.
- After `updatePartialFunctions`, old subset function ids are gone. A guest
  who bookmarked a previous RSVP payload will 400 until they reload
  `/api/public/functions/:eventSlug`.
- Do not treat a custom field named `instagram_url` or `hashtag` as the live
  value -- the Event columns win at render time.
