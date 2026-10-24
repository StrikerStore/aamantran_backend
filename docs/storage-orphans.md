# Orphan template storage

`npm run storage:orphans` lists template folders in storage that no `Template`
row points at, and can delete them. It does not run on a schedule, and it
does not delete database rows.

Code: `scripts/cleanup-orphan-templates.js`. Deletion goes through
`deleteTemplateFolder` in `src/services/fileManager.js`.

Rows disappear without their files in three places:

- `DELETE /api/v1/testing/developers/:handle` reads each sandbox template's
  `slug` and `folderPath`, deletes the account, then best-effort deletes
  those folders. A storage error is logged and the folder stays.
- `DELETE /api/dev/templates/:id` deletes the template row first, then deletes
  `folderPath` and `<slug>/draft`, and ignores a storage error.
- `DELETE /api/v1/templates/:id` deletes the row, then deletes `folderPath`.
  A storage throw on that path returns 500 with the row already gone.

A row removed directly in the database leaves the same kind of folder. This
script is the only sweep.

## What counts as a folder

The unit is the first path segment under `templates/`. A design owns
`templates/<slug>/draft/` and `templates/<slug>/v<n>/`, so those nested
directories are not separate orphans.

On R2 the script lists keys with prefix `templates/`. On disk it lists
directories in `STORAGE_PATH/templates` (`./storage/templates` when
`STORAGE_PATH` is unset). Files sitting directly in that directory are
ignored. R2 is used only when all five R2 variables are set, including
`R2_PUBLIC_BASE_URL`, which is the same switch as the rest of the app.

A folder is claimed when any `Template` row has that string as `slug` or as
`folderPath`. Sandbox rows claim their folders too. Both columns are kept
because they are usually equal and a drifted `folderPath` must not make the
other directory look free.

`--lab-only` keeps orphans whose name starts with `lab-`. It does not ignore
claims. A Lab folder that still has a row is not a candidate.

## Commands

Dry run is the default. It prints the database host (no credentials), the
storage backend, the row count, and every orphan name, then exits 0.

```
npm run storage:orphans
npm run storage:orphans -- --lab-only
npm run storage:orphans -- --apply --confirm=<bucket>
npm run storage:orphans -- --lab-only --apply --confirm=<bucket>
```

`<bucket>` has to be copied from the banner of that same run.

- R2: the bucket name from `R2_BUCKET_NAME`.
- Disk: the absolute `templates` directory printed as `disk (...)`.

`--confirm` is compared as an exact string. `--apply` without a matching
confirm exits 1 and deletes nothing.

## The half-folder stop

If more than half of the folders in storage are on the orphan list, the
script exits 1 unless `--force` is also passed. The message on that path is
that the database likely does not match the bucket. Exactly half is allowed
through. The ratio uses the filtered orphan list over every folder, so
`--lab-only` makes the stop harder to hit: a wrong database can still delete
a small set of `lab-*` folders once confirm matches.

`--force` does not skip `--confirm`.

## What deletion removes

Each name is removed with prefix `templates/<folder>/`. That prefix includes
the draft, every version, and thumbnails under that folder. Objects outside
`templates/` are left alone. A key that is exactly `templates/<folder>` with
nothing after it does not match the trailing slash, so it is listed as an
orphan and then not removed.

There is no per-version sweep inside a claimed slug. Extra files under a
slug that still has a row stay.

A failed delete is logged as `FAILED <folder>` and the loop continues. The
process still exits 0 after a partial run. The summary line is
`removed <n>/<total> folders`. An empty orphan list exits 0 before any
confirm check.

## Before `--apply`

Read the banner. `DATABASE_URL` and the bucket have to be the same
environment. A local `.env` pointed at the production bucket makes every live
design look orphaned, and confirm plus `--force` will delete those objects.
The bytes are not recoverable from this script.

Pass `--lab-only` when the intent is leftover Lab uploads. Run once without
`--apply`, then repeat with `--confirm` set to the bucket name that run
printed.
