# Template Versioning and Backfill

Template versioning keeps public invitations stable while admins edit template
drafts. It is implemented by:

- `src/controllers/templates.controller.js`
- `src/services/fileManager.js`
- `src/routes/render.js`
- `scripts/backfill-template-versions.js`
- `prisma/schema.prisma`

## Storage layout

Each template has a stable `Template.folderPath`, usually the slug generated at
creation time.

```text
templates/{folderPath}/
  draft/        mutable working copy used by /demo/:slug
  v1/           immutable published snapshot
  v2/           next immutable snapshot
  thumbnails/   thumbnail assets
```

Local development serves template files from `/s/{folderPath}/...`. When all R2
environment variables are set, template files are stored under
`templates/{folderPath}/...` in R2 and referenced through `R2_PUBLIC_BASE_URL`.

`extractTemplateZip` rewrites asset references for the target folder. Creating a
version re-extracts the stored `draft/template.zip` into `v{n}/` so HTML in that
snapshot points at versioned assets instead of the draft path.

## Drafts, publishing, and live renders

### Create template

`POST /api/v1/templates` uploads `templateZip` and writes it to
`templates/{folderPath}/draft/`. New templates are inactive and have no
`currentVersionId`.

### Re-upload template files

`PUT /api/v1/templates/:id/files` overwrites only the draft folder. Existing
published versions and events pinned to them are unchanged. Admins can preview
the changed draft at `/demo/:slug`.

### First publish

`PATCH /api/v1/templates/:id/publish`:

1. snapshots `draft/` to `v1/` when the template has no current version
2. creates a `TemplateVersion` row
3. sets `Template.currentVersionId`
4. points all events for the template at that version
5. sets `Template.isActive=true`

Calling publish again on a template that already has `currentVersionId` only
reactivates the template; it does not create another version.

### Publish changes

`POST /api/v1/templates/:id/publish-changes`:

1. requires the template to already have a published version
2. snapshots current `draft/` to the next `v{n}/`
3. updates `Template.currentVersionId`
4. repoints every event on the template to the new version
5. deletes render cache rows for events on that template

Use this endpoint when admins want existing live invitations to pick up the new
template bundle.

### Demo vs live invitation

- `/demo/:slug` always renders `templates/{folderPath}/draft/` with demo data.
- `/i/:slug` renders the event's pinned `TemplateVersion.folderPath`.
- `/i/:slug` falls back to `draft/` only for legacy events without a pinned
  version.

## Deleting versions

`DELETE /api/v1/templates/:id/versions/:versionId` removes a historical version
only when:

- the version belongs to the template
- it is not `Template.currentVersionId`
- no events are pinned to it
- its storage path starts with the template folder prefix

The endpoint deletes the version folder from local storage or R2, then deletes
the `TemplateVersion` row.

## Backfill runbook

The backfill script migrates legacy flat template folders into the versioned
layout.

```sh
node scripts/backfill-template-versions.js
node scripts/backfill-template-versions.js --apply
```

Dry run is the default. `--apply` writes changes.

For each template without `currentVersionId`, the script:

1. reads `templates/{folderPath}/template.zip`
2. extracts it into both `v1/` and `draft/`
3. creates `TemplateVersion(versionNumber=1)`
4. sets `Template.currentVersionId`
5. backfills events with `templateVersionId = v1.id`
6. removes old flat HTML/CSS/JS/assets at the template root while keeping
   `thumbnails/` and `template.zip`

The script is idempotent: templates that already have `currentVersionId` are
skipped. Templates without a stored `template.zip` are reported and skipped.

## Deployment behavior

`npm run db:deploy` and the production `prestart` script run:

```sh
npx prisma migrate deploy && node scripts/backfill-template-versions.js --apply
```

This means deploys apply schema migrations and then ensure old templates are
backfilled before the server starts.

## Common pitfalls

- Re-uploading a ZIP does not change live invites until `publish-changes` runs.
- Publishing an already-published template does not create a new version.
- Deleting a current or pinned version returns `409`.
- Version snapshots depend on `draft/template.zip`; if it is missing,
  snapshotting returns a conflict-style error.
- R2 mode activates only when every required R2 environment variable is set.
