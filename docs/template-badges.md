# Template corner badges

Optional merchandising tag on a template card (`New`, `Trending`, and
so on). A closed list rather than free text: each key has its own
colour on the storefront, and a fixed set is what stops the same idea
arriving as `TRENDING`, `Trending` and `trendy` on three cards.

The value is stored as the lowercase key, never the display label, so
wording can change without a migration. It is validated on write
because the website renders it straight into a CSS class -- an unknown
key would produce an unstyled badge with nothing to say why.

## Closed list

`TEMPLATE_BADGES` in `src/lib/constants.js`:

```
new, trending, bestseller, popular, limited
```

Adding a value means adding it here, in the admin-panel mirror
(`admin-panel/src/lib/constants.js`), and in the website's
`lib/templateBadges.ts`. There is no public constants endpoint; every
client hardcodes the same list.

Blank, omitted, or `null` means no tag. That is stored as SQL `NULL`,
not a sentinel string.

## Data model

`Template.badge` -- `VARCHAR(20) NULL`. Additive migration
`20260910120000_template_badge`. Safe behind `migrate deploy`.

Parser: `parseBadge` in `src/controllers/templates.controller.js`.

```
undefined | null | ""  ->  { value: null }
" Trending "           ->  { value: "trending" }
"hot"                  ->  { error: "Tag must be one of: new, trending, ..." }
```

Trim, then lowercase, then membership check. No other aliases.

## Write API (admin JWT)

Mounted at `/api/v1/templates` (`src/routes/templates.js`).

| Method | Path | Badge behaviour |
| --- | --- | --- |
| POST | `/` | Optional body field `badge`. Invalid -> **400**. Omitted -> `NULL`. |
| PUT | `/:id` | Applied only when `badge !== undefined`. Send `""` to clear. |

Create always writes `badge: tag.value` (null when omitted). Update
uses `!== undefined` rather than a truthiness check -- otherwise a tag
could never be unset.

```
# Set
curl -X PUT "$API/api/v1/templates/$ID" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -F "badge=bestseller"

# Clear
curl -X PUT "$API/api/v1/templates/$ID" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -F "badge="
```

Template Lab create (`/api/dev/templates`) does not accept `badge`.
Sandbox rows are excluded from the public catalogue
(`EXCLUDE_SANDBOX_TEMPLATE`), so a lab upload cannot show a storefront
tag until an admin publishes a non-sandbox template and sets one.

## Read surfaces

| Who | Path | Includes `badge`? |
| --- | --- | --- |
| Landing / product | `GET /api/templates` | Yes |
| Landing / product | `GET /api/templates/:slug` | Yes |
| Admin catalogue table | `GET /api/v1/templates` | **No** -- not in the `select` |
| Admin editor | `GET /api/v1/templates/:id` | Yes (full row) |

Public handlers: `src/routes/publicTemplates.js`. Both currencies still
go out on every public row (`withUsdPrices`); `badge` is independent
of price.

## Not a sort key

`GET /api/templates?sort=new` orders by `releasedAt` desc.
`sort=popular` orders by `buyerCount` desc.

A card tagged `new` is not automatically first, and `sort=new` does
not filter to `badge = 'new'`. The tag is merchandising only.

## Pitfalls

- Keep the three copies of the list in lockstep. A key that exists
  only on the API still writes, then renders as an unstyled class.
- To clear a tag, send an empty `badge`. Omitting the field on PUT
  leaves the current value.
- The admin list endpoint will not show the current tag. Fetch
  `GET /:id` (or add `badge` to that select) before drawing a
  catalogue table.
- Do not treat `badge === 'popular'` as a substitute for
  `buyerCount`. They can disagree.
- Do not store the display label (`"Best Seller"`). The column is the
  key; the website maps it to copy and colour.
