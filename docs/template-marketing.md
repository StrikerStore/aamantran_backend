# Template marketing copy

Optional storefront copy on a template: a one-line `shortDescription` and a
fixed set of `highlights` chips. Both are merchandising text. They are not
the derived capabilities in `docs/template-capabilities.md`. A chip that says
`RSVP` can be saved on a design whose HTML has no RSVP marker, and the
reverse is also possible.

Code: `src/utils/templateMarketing.js`, vocabulary in `TEMPLATE_HIGHLIGHTS`
(`src/lib/constants.js`). Writes go through `src/controllers/templates.controller.js`.
Public reads go through `src/routes/publicTemplates.js`.

The admin mirror of the vocabulary is `admin-panel/src/lib/constants.js`.
Adding a chip means adding it in both places. Unknown values are dropped, so
a new chip that exists only in the admin form never reaches the database.

## Vocabulary

Stored and returned in this order, regardless of the order they were sent:

`Countdown`, `Photo gallery`, `Background music`, `Video`,
`Maps & directions`, `Multi-ceremony`, `Bilingual`, `RSVP`, `Guest wishes`.

Matching is case-insensitive. `photo gallery` is stored as `Photo gallery`.
Duplicates collapse. A list of only unknown names becomes `null`.

## Normalisation

Nothing in this path returns 400 for a bad description or a bad chip. The
create and update handlers still 400 for a missing required template field,
a bad badge, or a markup multiplier outside `0.1` to `20`.

| Field | Input | Stored |
| --- | --- | --- |
| `shortDescription` | `null`, missing, or blank | `null` |
| `shortDescription` | Any other string | Trimmed, inner whitespace collapsed, cut at 300 characters |
| `highlights` | Array or comma-separated string | Canonical names joined with `, `, or `null` |

`shortDescription` is not HTML-stripped. `highlights` are joined and then cut
at 500 characters. The current vocabulary joined is 115 characters, so that
cap does not drop a chip today.

An empty string is how the admin form clears a value. Both normalisers turn
that into `null`.

## Admin API

`POST /api/v1/templates` always writes both columns. A body that omits them
stores `null`. Create still requires `name`, `community`, `price`, and
`aboutText`, and the new row starts `isActive: false`, so the public
catalogue does not show the copy until the template is active.

`PUT /api/v1/templates/:id` updates a column only when the field is present
on the body. Omitting `highlights` leaves the stored chips alone. Sending
`highlights: ""` or `highlights: []` clears them.

Admin list and admin get return the database shape: `highlights` is the
comma-separated string or `null`, not an array. `shortDescription` is the
stored string or `null`.

## Public API

`GET /api/templates` (gallery) and `GET /api/templates/:slug` (product page)
both parse `highlights` into an array of canonical names. An empty stored
value becomes `[]`.

The gallery does not send the full `aboutText`. It sends `aboutExcerpt`:

- Tags are stripped, then whitespace is collapsed.
- Up to 30 words (`ABOUT_EXCERPT_WORDS`).
- A longer text is cut and an ellipsis is appended.
- Blank text becomes `null`.

The product page sends the full `aboutText` and does not send `aboutExcerpt`.
`shortDescription` is sent on both responses and may be `null`. The storefront
is expected to fall back to the about text. This API does not do that
fallback itself.

Sandbox templates are excluded from both public responses.
