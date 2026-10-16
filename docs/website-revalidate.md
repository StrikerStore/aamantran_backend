# Website cache revalidation

After a published blog post changes, the API asks both website
deployments to drop their cached blog pages. The post then shows on the
next page load. With the secret unset, the websites keep their
five-minute cache and this call does nothing.

Code: `src/utils/websiteRevalidate.js`, `src/controllers/blog.controller.js`.
Admin blog routes are `/api/v1/blog` (admin JWT). Public reads are
`/api/blog`.

## When it runs

`revalidateBlog()` POSTs `{ "scope": "blog" }` to each origin. It runs
after the database write:

| Admin action | Revalidate |
| --- | --- |
| `POST /api/v1/blog` (create) | No. New posts are `draft`. |
| `PUT /api/v1/blog/:id` | Yes, when the saved row is `published` (text, cover, or slug). |
| `PATCH /api/v1/blog/:id/publish` | Yes. |
| `PATCH /api/v1/blog/:id/unpublish` | Yes, when the post was `published`. |
| `DELETE /api/v1/blog/:id` | Yes, when the post was `published`. |

The admin response is the blog row (or `{ ok: true }` on delete). It does
not include the website results. A website that fails does not fail the
save.

## Configuration

| Variable | Role |
| --- | --- |
| `WEBSITE_REVALIDATE_SECRET` | Bearer token. The same value as `REVALIDATE_SECRET` on both website deployments. Empty or unset: the function returns `{ skipped: "WEBSITE_REVALIDATE_SECRET is not set" }` and calls nothing. |
| `WEBSITE_REVALIDATE_ORIGINS` | Optional comma-separated origins, trailing slashes stripped, duplicates removed. When set, these replace the defaults. Use this for private network URLs. |
| `LANDING_URL`, `LANDING_URL_INTL` | Used when `WEBSITE_REVALIDATE_ORIGINS` is empty. Production defaults are `https://www.aamantran.online` and `https://www.aamantranglobal.com` (`src/config/siteUrls.js`). |

Each call is `POST {origin}/api/revalidate` with
`Authorization: Bearer <secret>`, `Content-Type: application/json`, and
body `{ "scope": "blog" }`. The timeout is 5 seconds. A non-2xx response
or a network error is logged as `[revalidate]` and that origin is
skipped. The function does not throw.

`npm run check:env` does not look at these variables. A missing secret
is a quiet stale cache, not a failed boot.

## Troubleshooting

The save succeeded and the public site still shows the old post:

1. Confirm `WEBSITE_REVALIDATE_SECRET` is set on the API and matches
   `REVALIDATE_SECRET` on both websites. A mismatch is a non-2xx warning
   in the API log.
2. Confirm the origins. The default list follows `LANDING_URL` and
   `LANDING_URL_INTL` (or the production defaults when those are unset).
   A private website URL belongs in `WEBSITE_REVALIDATE_ORIGINS`.
3. A slow or down website is skipped after 5 seconds. Its own cache
   still expires within five minutes.
4. Draft edits do not revalidate. Publish does.
