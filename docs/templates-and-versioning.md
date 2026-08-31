# Templates and versioning

Template uploads are mutable while being edited and immutable after publishing.
This keeps live invitations stable even when admins upload a new ZIP for the
same template.

## Codepaths

| Concern | Source |
| --- | --- |
| Admin routes | `src/routes/templates.js` |
| Template controller | `src/controllers/templates.controller.js` |
| ZIP extraction and snapshots | `src/services/fileManager.js` |
| Render source selection | `src/routes/render.js` |
| Storage switching | `src/config/storage.js` |
| Versioning models | `prisma/schema.prisma` |
| Backfill script | `scripts/backfill-template-versions.js` |

## Storage layout

For a template with `folderPath = floral-design-14463`:

```text
templates/
  floral-design-14463/
    draft/        # mutable working copy used by /demo/:slug
    v1/           # immutable published snapshot
    v2/           # later immutable snapshot
    thumbnails/   # cover images
    template.zip  # legacy/root artifact may exist
```

Local development serves template files from `STORAGE_PATH` through `/s`.
Cloudflare R2 is used when every required R2 env var is set; browser-facing asset
URLs are built from `R2_PUBLIC_BASE_URL`.

## Admin lifecycle

### Create template

`POST /api/v1/templates` requires admin JWT and multipart form data:

- `templateZip` (required)
- `desktopThumbnailImage` or legacy `thumbnailImage`
- `mobileThumbnailImage`
- Template metadata fields such as `name`, `community`, `price`, `aboutText`,
  `bestFor`, `languages`, `gstPercent`, and optional `demoData`

The uploaded ZIP is extracted to `templates/{folderPath}/draft/`. New templates
start inactive and have no `currentVersionId`.

### Update metadata

`PUT /api/v1/templates/:id` updates database metadata and optional thumbnails.
It does not snapshot the draft or affect live invitations.

### Update files

`PUT /api/v1/templates/:id/files` uploads a replacement ZIP and extracts it into
the draft folder. This overwrites the admin/demo working copy only. Existing live
invitations keep rendering from their pinned version until a publish operation
repoints them.

### Publish first version

`PATCH /api/v1/templates/:id/publish` has two behaviors:

- First publish: snapshot `draft/` into `v1/`, set `Template.currentVersionId`,
  repoint events on that template to `v1`, and set `isActive=true`.
- Later calls: only reactivate the template with `isActive=true`; no new version
  is created.

Use this endpoint for the first release or to reactivate a draft/inactive
template.

### Publish changes

`POST /api/v1/templates/:id/publish-changes` snapshots the current draft into the
next immutable folder (`v2`, `v3`, ...), updates `Template.currentVersionId`, and
repoints every `Event` using that template to the new version. It also clears the
event render cache for that template.

Use this endpoint when admins intend all existing live invitations for a template
to pick up the new bundle.

If a template has no published version yet, this endpoint returns `409` and the
caller should use `publish` first.

### Draft/unpublish

`PATCH /api/v1/templates/:id/draft` sets `isActive=false`. It does not delete
versions and does not change already published invitations.

### Delete a version

`DELETE /api/v1/templates/:id/versions/:versionId` removes an immutable snapshot
only when:

- It is not the current published version.
- No event is pinned to it.
- Its folder path belongs to the template being edited.

If any invitation still uses the version, the route returns `409`.

## Render behavior

`GET /demo/:slug` always renders the latest `draft/` folder with template demo
data. This gives admins immediate feedback after ZIP uploads.

`GET /i/:slug` renders a couple's live invitation from `Event.templateVersionId`
when present. If the event has no pinned version, the route falls back to the
template draft folder; this fallback is for legacy events that were not backfilled
and should not be relied on for new data.

`GET /i/:slug/preview?pt=...` can preview unpublished events when a valid signed
preview token is supplied by the admin or couple dashboard.

## Backfill

Template versioning is backfilled by:

```bash
node scripts/backfill-template-versions.js          # dry run
node scripts/backfill-template-versions.js --apply  # write changes
```

For templates without `currentVersionId`, the script:

1. Finds the stored ZIP at `templates/{slug}/template.zip`.
2. Extracts it into both `v1/` and `draft/`.
3. Creates a `TemplateVersion` row for version 1.
4. Sets `Template.currentVersionId`.
5. Pins existing events with null `templateVersionId` to version 1.
6. Deletes old flat-layout files while keeping thumbnails and the root ZIP.

The script is idempotent: reruns skip templates that already have
`currentVersionId`. `npm start` and `npm run db:deploy` run the apply mode after
Prisma migrations.

## Constraints and pitfalls

- Re-uploading a ZIP does not update live invitations by itself.
- Use `publish-changes` only when all existing events on that template should move
  to the new snapshot.
- Template swap payments pin upgraded events to the target template's current
  version when available.
- R2/local storage behavior is decided at runtime by `src/config/storage.js`.
  Missing one R2 env var disables object storage entirely.
- Invitation HTML responses and local `/s` template assets are served with
  no-store cache headers so updates are visible immediately.
