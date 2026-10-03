# Person slots (person1 and person2)

The couple's two name slots are `person1` and `person2`. They used to be
`groom` and `bride`. Couples only ever saw "Person 1" and "Person 2", and
which slot held the bride was never stored, so the old names were wrong for
half the events.

Every role, variable, and custom-field key follows the slot prefix:
`person1_father`, `{{person2_mother_name}}`, `person1_family_line`.

Code: `src/utils/personSlots.js`, `src/services/templateRenderer.js`,
`src/services/templateIntrospect.service.js`, `src/services/trialDemo.service.js`,
`src/controllers/templates.controller.js`, `src/controllers/devLab.controller.js`,
`src/controllers/userDashboard.controller.js`, `src/controllers/users.controller.js`,
`scripts/backfill-person-slots.js`,
`prisma/migrations/20260925000000_person_slot_names/migration.sql`.

## Columns

The migration is additive. It adds nullable `Event.person1Name` and
`Event.person2Name`, and `TemplateDemoData.person1Name` /
`person2Name` (empty string default). `brideName` and `groomName` stay.
Their values are copied by the backfill script below, which needs each
template's slot order and so cannot be plain SQL. A later release drops
the old columns.

Apply the migration before the backend that reads `person1Name`. The
previous process ignores the new columns, so a rollback of the code still
runs.

Until the backfill has copied names, live HTML still renders: the
renderer falls back to `brideName` / `groomName` through the slot map.
Ticket alerts and admin lists that read `person1Name` directly do not
get that fallback. A ticket email uses the event slug when both new
columns are empty.

## Slot map

`fieldSchema.legacySlotMap` is `{ person1, person2 }`, each value `groom`
or `bride`, and the two values differ. Most designs are
`{ person1: "groom", person2: "bride" }`. A design that listed the bride
first has it the other way.

Resolution order in `legacySlotMapFor`:

1. A valid `legacySlotMap` already on the schema.
2. Else the first `groom` or `bride` role in `fieldSchema.people` becomes
   `person1`, and the other slot gets the remaining role.
3. Else `{ person1: "groom", person2: "bride" }`.

`normalizeFieldSchema` runs on admin demo save
(`PUT /api/v1/templates/:id/demo-data`) and on Lab schema saves. It:

- keeps the previous map when the incoming schema omits one (the admin
  form and the Lab do not send it; dropping it would flip aliases on
  bride-first designs);
- renames `groom` / `bride` roles and custom keys to `person1` / `person2`;
- turns `roleOptions` into a clean list;
- normalizes `dashboard` (below).

An admin tab opened before the rename may still send `bride_name`,
`groom_name`, and `groom` / `bride` roles. `demoSlotFields` translates
them with the template's map. `person1_name` wins when both are present.

Lab `PUT /api/dev/sandbox` still accepts `groomName` / `brideName` as
aliases of `person1Name` / `person2Name` (120 characters, empty becomes
null). It also updates the matching `EventPerson` row. The renderer reads
`{{person1_name}}` from the event column and `{{person_name}}` /
`{{#person}}` from the people rows, so both have to move together.

`POST /api/v1/users/:id/generate-invites` and
`PUT /api/v1/users/:id/event-data` write `person1Name` and `person2Name`
only. They do not fill the old columns.

## What templates can still say

`LEGACY_SLOT_ALIASES` in `templateRenderer.js` is on. Slot variables,
custom fields, and helper roles are also answered under the old name from
that template's map, so `{{groom_name}}` keeps working until the design is
re-uploaded. The map comes from the version being rendered
(`templateVersion.fieldSchema`, else `template.fieldSchema`), so an old
snapshot still gets the names its HTML was written with.

Per person, after the role is normalised to `person1` / `person2`:

| Variable | Value |
| --- | --- |
| `{{<role>_name}}`, `{{<role>_photo}}` | name and photo |
| `{{<role>_<extraKey>}}` | `extraData` entries, including `role_choice` |
| `{{<role>_role}}` | the Bride/Groom-style choice, when set |
| `{{<role>_is_<option>}}` | true for that choice, e.g. `{{person2_is_bride}}` |
| `{{<role>_has_parents}}` | true when `<role>_father` or `<role>_mother` is named |

`{{person1_name}}` prefers the event column, then the people row.
Helpers `people_by_role`, `person`, `person_name`, `person_photo`, and
`if_role` match the role and, while aliases are on, its old name.

Schema check (`templateIntrospect.service.js`) counts an old name as the
`person1` / `person2` key it stands for, and flags it. The aliases go
away once every published design has been re-uploaded.

### Role options

A people row may declare `roleOptions` ("Groom, Bride" or an array).
Saving cleans them: trim, 40 characters, case-insensitive de-dupe, first
spelling kept.

The couple stores the choice on `EventPerson.extraData.role_choice`.
`POST` and `PUT /api/user/events/:id/people` check it against the options
declared for that role and store the declared spelling (`bride` becomes
`Bride`). An unknown choice is **400**. An empty choice removes the key.
The slug in `{{person1_is_<option>}}` is lowercase, with non-alphanumerics
collapsed to `_` (`Co-host` becomes `co_host`).

The template uses these flags for wording ("son of" / "daughter of").
`Task.assignedTo` is a different thing: a task assigned to `bride` meant
the actual bride, not the old bride slot. The backfill leaves it alone.

## Couple dashboard

Couple routes use the user JWT (`issuer: aamantran:user`, `role: user`).

| Method | Path | What it does |
| --- | --- | --- |
| PATCH | `/api/user/events/:id/confirm-names` | Sets `namesAreFrozen`. **400** when the event has no people. A second call returns success and changes nothing. |
| PATCH | `/api/v1/users/:id/freeze-names` | Admin. Body `{ "eventId" }`. Freezes even when the people list is empty. |
| PATCH | `/api/user/events/:id/publish` | **403** until names are confirmed. |
| GET | `/api/user/events/:id/link-available?link=` | Live slug check. See below. |
| POST/PUT/DELETE | `/api/user/events/:id/people` | Name edits. Locked roles after confirm. |

After confirm, a role stays editable only when the template schema
declares it and `required` is false (parents and the like). Required
roles, roles the schema does not declare, and every role on a template
with no people list are locked. The decision is read from
`template.fieldSchema` on the server. A client `required: false` is
ignored.

A locked person can still change `extraData.role_choice` alone. Any
other field on that person, including moving them into or out of a locked
role, returns **403** with "Names are confirmed. Raise a support ticket
to request changes." Adding or deleting a locked role after confirm is
the same 403. An optional name left blank at confirmation can still be
filled in later.

`GET .../link-available` uses the same cleaning and uniqueness as
publish. The response is `{ ok, cleaned, available, reason, isDefault }`.

- `link` is truncated to 80 characters, then slugified.
- Empty: `available: false`, `reason: "empty"`.
- Shorter than 3: `reason: "short"`.
- Taken by another pair: `reason: "taken"`.
- The event's own slug, and its paired invite's slug, count as free.

`isDefault` is true when the cleaned link still looks generated:
`<username>-<template slug>` with an optional `-<number>`, `event-<number>`,
or a link ending in `-all` or `-partial`.

### Which builder steps a design shows

`fieldSchema.dashboard`, when present:

```
{ "guestOptions": ["instagram", "rsvp"], "showMedia": false }
```

Allowed `guestOptions`, in this order: `instagram`, `hashtag`, `youtube`,
`rsvp`, `wishes`. Unknown keys are dropped. `showMedia` is kept only when
it is a boolean. Anything else is removed on save. A missing `dashboard`
block means the couple app shows every guest option and media. This API
stores the block on the template and returns `fieldSchema` with the
event; it does not itself hide those features.

## Backfill

```
node scripts/backfill-person-slots.js           # dry run, counts only
node scripts/backfill-person-slots.js --apply   # write
```

For each template it records `legacySlotMap` on the template and on every
version snapshot, and renames people roles and custom keys in the schema
and in demo data. For each event it renames `EventPerson.role` and
`EventCustomField.fieldKey`, and copies `person1Name` / `person2Name`
from the old columns when the new columns are still empty. Old columns
are left as they are. Trial-demo payloads (kept about a day) get their
people roles renamed. `--apply` then deletes every `EventRenderCache` row.

`npm run db:deploy` and the `prestart` script run `prisma migrate deploy`,
`scripts/backfill-template-versions.js --apply`, and retention. They do
not run this script. The migration comment says otherwise; follow
`package.json`. Run the person-slot backfill once after the migration,
before relying on `person1Name` in the dashboard.

The script is idempotent. A renamed key never matches again, an existing
map is reused, and a name already stored in `person1Name` is not
overwritten. A second `--apply` changes nothing.

`(eventId, fieldKey)` is unique. When both `groom_father` and
`person1_father` already exist, the old row is left in place and the log
names the event, the old key, and the new key that blocked the rename.
Merge that pair by hand. `Task.assignedTo` is not rewritten.
