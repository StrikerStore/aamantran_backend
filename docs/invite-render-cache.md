# Invite render cache

`EventRenderCache` is a one-row-per-event table (`eventId` is unique) with
`htmlDesktop`, `htmlMobile`, `dataJson`, and `builtAt`. Deleting the `Event`
removes the row (`onDelete: Cascade`).

Nothing in `src/` or `scripts/` inserts or reads those columns. Guest HTML is
built on the request by `renderTemplate` in `src/services/templateRenderer.js`,
called from `src/routes/render.js`. Clearing a cache row does not change the
page a guest sees, and leaving a row in place does not serve it.

The deletes below are all `deleteMany`. They matter only as a record of which
writes were expected to invalidate a pre-rendered page. Do not debug a stale
invite by inspecting this table.

## Where a row is deleted

The event row itself stays. Only the cache row is removed.

| Trigger | Scope |
| --- | --- |
| `POST /api/user/events/:id/media` and `DELETE /api/user/events/:id/media/:mediaId` | That event, after the media write succeeds. A media error returns before the delete. |
| `POST /api/v1/users/:id/events/:eventId/media` and `DELETE .../media/:mediaId` | Same, for an admin upload or delete. |
| `PUT /api/v1/users/:id/event-data` | That event, after the handler finishes the nested updates. |
| `POST /api/v1/users/:id/swap-template` when the new list price is less than or equal to the old one | That event. |
| `POST /api/v1/users/:id/swap-paired-template` on the same free path | Both the full and the partial event. |
| `PATCH /api/v1/users/:id/change-template` | That event, inside the transaction that also unpublishes and wipes custom fields and media. |
| `PATCH /api/v1/templates/:id/publish` the first time (no `currentVersionId` yet) and `POST /api/v1/templates/:id/publish-changes` | Every cache row whose event uses that `templateId`, including test events. |
| `POST /api/v1/testing/repin` | The test event. |
| `PUT /api/dev/templates/:id/files` | The caller's sandbox event, when one exists. |
| `PUT /api/dev/sandbox` | The sandbox event. |
| `node scripts/backfill-person-slots.js --apply` | Every row. The dry run does not delete. There is no npm script for this file, and `prestart` / `db:deploy` do not run it. |

`repointAllEventsToTemplateVersion` (`src/controllers/templates.controller.js`)
pins `templateVersionId` only where `isTestEvent` is false, then deletes cache
rows for every event on that template. Test events are not repointed, so
a testing-account or Lab invite that is pinned to the draft stays on the
draft, and its cache row is still removed. A later
`PATCH .../publish` that only flips `isActive` does not call this helper, so
it does not touch the cache. `PATCH .../draft` does not either.

Lab activate (`POST /api/dev/templates/:id/activate`) does not call
`deleteMany`. It runs `purgeTestEvents` first, which deletes the sandbox
event, and the cache row goes with that event. Schema save
(`PUT /api/dev/templates/:id/schema`) does the same only when the sandbox
event is already on that template.

## Paths that do not delete it

These writes change what the renderer returns and leave `EventRenderCache`
alone:

- Couple edits other than media. `PUT /api/user/events/:id`, publish,
  unpublish, partial functions, people, functions, venues, and
  `PUT /api/user/events/:id/custom-fields` do not delete a row. The only
  couple calls that do are the two media routes above.
- Paid template swaps. The free branch deletes the row; the payment branch
  does not. See `docs/template-swaps.md`.
- `npm run db:backfill-pair-settings` / `scripts/backfill-invite-pair-settings.js`.

`PUT /api/v1/users/:id/event-data` can also miss the delete. The scalar event
update is committed first. If `functions` is present but invalid (empty list,
an id from another invite, a bad date, a rejected map), the handler returns
400 and never reaches `deleteMany`.

## Constraints

- There is no flush route and no scheduled purge of this table.
- A row can sit forever. It is not on the response path.
- `dataJson` is not a second copy of the invitation that any job reconciles.
