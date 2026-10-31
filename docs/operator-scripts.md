# Operator scripts

Two one-off checks that are not in `package.json` and not in `prestart`.
Both use Prisma, and neither calls `dotenv`. Export `DATABASE_URL` (and any
other variables Prisma needs) before running them. A shell that only has a
project `.env` file will fail until that export exists.

```sh
node scripts/audit-schema-labels.js
node scripts/backfill-review-ratings.js
```

Exit code is 1 on a thrown error (`process.exitCode`). The client is
disconnected in `finally`.

## Schema label audit

`scripts/audit-schema-labels.js` prints templates whose form labels contain
`{{` or `}}`. It never writes.

The couple dashboard receives `template.fieldSchema` on
`GET /api/user/events/:id` and the API does not run Handlebars over those
labels. Tokens in a label are stored and returned as the characters typed.
Template HTML is a different path: the renderer compiles that, not the schema
label.

The script header says the admin form rejects these on save. This repo does
not. `templates.controller.js` create/update and `normalizeFieldSchema` keep
labels as submitted. The script is the check.

Scan rules:

- Every `Template` row, active or not, sandbox or not, ordered by `name`.
  `TemplateVersion.fieldSchema` snapshots are not read. Fixing the live row
  and leaving an old version untouched is invisible to this script. The couple
  form reads the live template row, which is the row the script scans.
- A string `fieldSchema` is `JSON.parse`d. Invalid JSON, null, or a non-object
  produces no findings for that template and no error line.
- Rows scanned: `people[]` (id is `role`), `customFields[]` (id is `key`),
  `mediaSlots[]` (id is `key`), and `functionFields` as an object whose values
  have `label` (id is the object key). Other keys are ignored.
- A label matches if it contains `{{` or `}}` anywhere, including a closing
  brace with no opening brace. The match is on `String(label)`. Missing labels
  are skipped.

Output is one block per affected template (`name`, `slug`, `[inactive]` when
`isActive` is false) and a closing count. Edit the labels in the template
admin. Re-run to confirm. There is no `--apply`.

## Review rating backfill

`scripts/backfill-review-ratings.js` recomputes `Template.avgRating` for every
template by calling `recalcTemplateRating` (`src/utils/reviewAggregates.js`).
It does not update or delete `TemplateReview` rows.

The script header says averages used to include admin-entered reviews and
should now use "genuine" reviews only. The function it calls does the
opposite of that sentence. `GENUINE_REVIEW_WHERE` and `VISIBLE_REVIEW_WHERE`
are the same predicate:

- `isHidden: false`
- `EXCLUDE_TEST_OWNER` (not owned by `user.isTestAccount`; a null `userId`
  stays in)

`isAdminCreated` is not part of the filter. A published review entered in the
admin panel counts. A hidden review does not. A review owned by the testing
account does not. The same predicate is what
`GET /api/templates/:slug` uses for `reviewCount` and what
`GET /api/templates/:slug/reviews` and `GET /api/reviews/featured` use for
`avgRating` / `totalCount`. Comments above the couple-dashboard writer and
the featured-reviews route still describe the old exclusion. The `where`
object is the rule.

`Template.avgRating` is the stored column (`Decimal(3, 2)`). Catalogue list
and template detail return that stored value. The reviews list returns a live
aggregate instead. Create, hide, show, delete (admin) and the couple's own
review submit already call `recalcTemplateRating`. Run the script once when
stored averages were produced by an older filter, and any time you need every
template rewritten. It is safe to repeat.

The script still writes when the rounded value did not change.
`recalcTemplateRating` always `update`s the row. A line is printed only when
`Number(before).toFixed(2)` differs from `Number(after).toFixed(2)`:
`Name (slug): 4.50 -> 4.75`. The closing line is how many templates differed
out of how many were visited.
