# Template capabilities

Buyer-facing description of what a published design supports. The product page
asks for it. Checkout uses the same template endpoint and leaves it off.

Code: `src/services/templateCapabilities.service.js`, loaded by
`loadCapabilities` in `src/routes/publicTemplates.js`.

The payload is labels and booleans. It does not include `fieldSchema`, schema
keys, demo values, or storage paths. A couple's RSVP or wish toggle is a
separate setting on the invite. This payload says what the design contains.

## Request

```
GET /api/templates/:slug?include=capabilities
```

`include` is a comma-separated list. The token `capabilities` must match
exactly after trimming. Any other call to `GET /api/templates/:slug` omits the
`capabilities` key. Checkout relies on that: the handler does an extra read
only when the token is present.

The template must be `isActive` and not a Template Lab sandbox
(`EXCLUDE_SANDBOX_TEMPLATE`). Otherwise the route is 404 and capabilities are
not loaded.

The router also sits on `publicInviteLimiter` (default 200 requests per 15
minutes, `RATE_LIMIT_PUBLIC_INVITE_MAX`).

## Response

`capabilities` is an object, or `null` when the loader throws. `null` means
the product page should skip the section. The route never fails the template
response because of this read.

| Field | When it is `null` | Otherwise |
| --- | --- | --- |
| `people` | `fieldSchema.people` is not an array | `{ label, photo }` for each row that has a `role` |
| `ceremonyFields` | `functionFields` is missing or not an object | Labels of entries with `enabled` set |
| `mediaSlots` | No `mediaSlots` array, or it is empty | `{ label, type, multiple }` and `max` when `multiple` is true |
| `customFieldLabels` | `customFields` is not an array | Label for each row that has a `key` |
| `languages` | Never `null` | Codes from the template `languages` CSV. May be `[]` |
| `rsvp` | HTML was not read in time | `true` or `false` from the desktop markup |
| `wishes` | HTML was not read in time | `true` or `false` from the desktop markup |

An empty array means the section was declared and nothing in it qualified
(no role, no enabled ceremony field, no custom key). That is different from
`null`, which means the section was not declared.

`languages` is always an array, including when the CSV is empty.

### Labels

A missing label is derived from the key so a raw identifier is not shown:

- `dressCode` becomes `Dress code`
- `background_music` becomes `Background music`
- `person1_father` becomes `Person1 father`

Media slots pass through `getMediaSlots` in `src/services/mediaSlotUtils.js`.
That helper copies the key into `label` when no label was set, and this
service then humanizes any label that still equals the key. Slot `type` is
`music`, `video`, or `photo`. Any other type is stored as `photo`. `max` is
included only for `multiple` slots. A multiple slot with no positive `max`
reports `24`.

`photo` on a person is a boolean. A person row without `photo` reports
`false`.

## Which version is read

The published `currentVersion` is used when it has a `folderPath`. Its
`fieldSchema` and entry-file names are preferred. A null schema or entry file
on the version falls back to the draft columns on `Template`.

A template that was never versioned is read from `<folderPath>/draft` and the
draft schema. `folderPath` is the column, which is usually the slug and is
not always equal to it.

## RSVP and wishes

`analyseHtml` in `src/services/templateIntrospect.service.js` looks for
`data-aamantran="rsvp"` and `data-aamantran="wish"` after Handlebars comments
are removed. Spaces around `=` are allowed. The quotes are double quotes. A
single-quoted attribute does not match.

The read uses the desktop entry file first (`preferredFile` is
`desktopEntryFile`, then `index.html`). The mobile file is opened only when
the desktop file is missing. A marker that exists only in the mobile HTML is
reported `false` when the desktop file is present and lacks it.

The read has a 2.5 second cap (`HTML_READ_TIMEOUT_MS`). A timeout, a throw,
or a missing file sets `rsvp` and `wishes` to `null` and `readOk` to false.
`false` means the file was read and the marker was absent. The schema fields
are still returned on that failed read.

## Cache

In-process only. One entry per `slug`, version key, and `Template.updatedAt`.

| Case | Lifetime |
| --- | --- |
| HTML read succeeded | 10 minutes from the start of that computation |
| HTML read failed or timed out | 60 seconds from the moment it failed |
| Calls already waiting on that key | Share the same promise |

The version key is `v:<version id>` or `draft`. Publishing a new version
changes the id, so the next request misses. A draft HTML edit that does not
change `Template.updatedAt` stays on the old entry until the TTL ends.

The map keeps at most 200 entries and drops the oldest insertion. There is no
flush route. A restart clears it. `clearCapabilitiesCache` is a test hook and
nothing in the app calls it.

The catalogue list does not call this service. Asking for capabilities on
every card would be one storage read per design.
