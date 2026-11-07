# Invite pair settings backfill

One-off repair for Links and Guests fields that drifted between a full invite
and its partial invite. Pair field rules for the live API are in
`docs/invite-pairs.md`. This page is only the script.

```bash
node scripts/backfill-invite-pair-settings.js            # dry run (default)
node scripts/backfill-invite-pair-settings.js --apply    # write
npm run db:backfill-pair-settings                        # always --apply
```

`prestart` and `db:deploy` do not run it. The script does not load dotenv.
`DATABASE_URL` has to be in the environment already (the server loads
`src/app.js`, which calls dotenv; this file does not). Any argument other
than `--apply` is ignored. A dry run that finds drift still exits 0. Exit 1
means the process threw. There is no transaction around the loop: rows
updated before a throw stay updated.

## What it copies

For each `invitePairId`, the member with `inviteScope` `full` is the source.
These columns are copied onto every other member:

| Column | Compare and write |
| --- | --- |
| `language` | Blank is treated as `en` on both sides. The value written is that normalized string, so a blank source becomes `en` on the target. |
| `instagramUrl`, `instagramHashtag`, `socialYoutubeUrl`, `websiteUrl` | Compared as stored. Null stays null. Not passed through the URL or hashtag normalizers. |
| `rsvpEnabled`, `guestNotesEnabled` | Only an explicit `false` is false. The boolean written is that normalized value. |

`slug`, `subdomain`, `expiresAt`, functions, people, media, custom fields,
and `isPublished` are not touched. The render cache is not cleared (nothing
reads it; see `docs/invite-render-cache.md`). Test events are not skipped.

The source is the earliest `full` row in the pair (`createdAt` ascending).
A second `full` row is treated as a target and overwritten. A pair with no
`full` member is skipped and counted as an orphan pair. The "already in
sync" count is target rows, not pairs. The source row is not part of that
count.

Logs are prefixed `[pair-settings]`. Dry run prints `WOULD FIX` and, when
anything would change, a reminder to re-run with `--apply`. Apply prints
`FIX` and then how many invites were repaired.

## Why a pair drifts

A partial invite is created as a copy. Two live paths keep the seven fields
aligned after that, and one admin path does not.

`PUT /api/user/events/:id` copies only the shared keys present on that
request onto every other row in the pair (`syncPairSharedFields`). Editing
the partial updates the full invite, and the reverse. Keys omitted from the
body are left as they are.

`PATCH /api/user/events/:id/publish`, when the invite is already paired,
copies all seven fields from the event in the URL onto one other member
(`findFirst`, no order). It does not walk every sibling. Publishing the
partial invite therefore treats the partial row as the source for that one
sibling. The script does not: it always reads the `full` row.

`PUT /api/v1/users/:id/event-data` writes the body onto that one event and
does not call `syncPairSharedFields`. An admin edit of `rsvpEnabled` on only
the full invite leaves the partial unchanged until someone publishes or this
script runs.

`POST /api/public/rsvp` returns 403 `{ "message": "RSVP is not enabled for this invitation" }`
when that invite's `rsvpEnabled` is false. The RSVP row is stored on the
invite that was opened. `GET /api/public/wishes/:eventSlug` and
`POST /api/public/wishes` check `guestNotesEnabled` on that same invite
(the GET returns an empty list, the POST returns 403
`Guest notes are not enabled for this invitation`). When the flag is on, the
wish itself is written on the full invite. A drifted flag hides or shows the
wall without moving those rows.

Running the script after an intentional edit of the partial only will put
the full invite's values back onto the partial.
