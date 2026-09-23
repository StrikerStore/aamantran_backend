# Template reviews and ratings

Couple-submitted and admin-seeded reviews on invitation templates. Three
HTTP surfaces share `TemplateReview`; they do not share the same filters
or the same `avgRating` writer.

## Architecture

| Surface | Mount | Auth |
| --- | --- | --- |
| Couple submit / edit | `POST /api/user/review` (`multipart`, field `couplePhoto`) | couple JWT |
| Admin list / seed / hide / delete | `/api/v1/reviews` | admin JWT |
| Public gallery + product page | `/api/templates`, `/api/reviews` (same router) | none; `publicInviteLimiter` |

Model (`prisma/schema.prisma`): `rating` (int), optional `reviewText`,
`coupleNames`, `location`, `couplePhotoUrl`, `isHidden` (default false),
`isAdminCreated` (default false), nullable `userId`.

`userId` is nullable so admin-seeded rows and DPDP-erased buyers can exist
without a user. Migration `20260424000000_reviews_hidden_admin` dropped the
`(templateId, userId)` unique index. Prisma `upsert` on that compound key
will throw; couple submit uses `findFirst` then update/create.

## Couple submit

`src/controllers/userDashboard.controller.js` `submitReview`.

| Rule | Behaviour |
| --- | --- |
| Required | `templateId`, `rating` in 1-5 |
| Purchase | a `Payment` for that user + template with `status: 'paid'` |
| Test account | 403 `The testing account cannot submit reviews` |
| Existing row | first review for `{templateId, userId}` is updated; photo is replaced only when a new file is uploaded |
| Photo | optional; jpg/jpeg/png/webp/avif; 5 MB; stored at `review-images/{uuid}{ext}` **only when R2 is configured**. Local disk leaves `couplePhotoUrl` null |
| Mail | team alert (see `docs/internal-notifications.md`) |

A second browser tab can race `findFirst` and insert a duplicate. There is
no remaining unique constraint to prevent that.

## Admin moderation

`src/routes/adminReviews.js`. Test-owned rows are excluded from list and
aggregates via `EXCLUDE_TEST_OWNER` (`NOT user.isTestAccount`; null
`userId` rows are kept).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/reviews` | `templateId`, `hidden=true\|false`, `page`, `limit` (default 50) |
| POST | `/api/v1/reviews` | multipart `couplePhoto`; requires `templateId` and rating 1-5; sets `isAdminCreated: true`, `userId` null; photo key `reviews/{uuid}{ext}` (R2 only) |
| PATCH | `/api/v1/reviews/:id/hide` | `isHidden: true`, then recalc |
| PATCH | `/api/v1/reviews/:id/show` | `isHidden: false`, then recalc |
| DELETE | `/api/v1/reviews/:id` | delete, then recalc |

Admin seed does **not** require a paid purchase and does **not** send the
team review email.

## Public listing

Same handlers are mounted at `/api/templates` and `/api/reviews`
(`src/routes/index.js`), so `/api/reviews/:slug` is the product-page
payload, not a review id.

| Method | Intended path | Rows | Header avg / count |
| --- | --- | --- | --- |
| GET | `/api/reviews/featured` | latest N with `reviewText` not null, `isHidden: false`, not test-owned | **all** non-hidden, not-test-owned reviews (rating-only included) |
| GET | `/api/templates/:slug` | template row | `reviewCount` = non-hidden, not-test-owned; `avgRating` is the **stored** `Template.avgRating` |
| GET | `/api/templates/:slug/reviews` | non-hidden, not-test-owned for that template | same filter as the list |

Featured must be registered before `/:slug` or `featured` is captured as a
slug. `/api/templates/featured` hits the same featured handler.

Hidden reviews disappear from public lists immediately. They do not
disappear from `Template.avgRating` until something recalculates it.

## Who writes `Template.avgRating`

| Writer | Hidden reviews | Test-owned reviews |
| --- | --- | --- |
| Couple `submitReview` | **included** | excluded (`EXCLUDE_TEST_OWNER`) |
| Admin hide / show / delete / seed (`recalcAvgRating`) | excluded | excluded |
| Public `GET /:slug/reviews` (response only, not stored) | excluded | excluded |

After a couple submit, a previously hidden review on that template can pull
the stored average away from what the product page's `/reviews` payload
reports. Hide or show any review on that template (or seed one) to force
the admin recalc.

Gallery cards (`GET /api/templates`) read the stored column, not a live
aggregate.

## `EXCLUDE_TEST_OWNER`

```
{ NOT: { user: { is: { isTestAccount: true } } } }
```

A bare `user: { isTestAccount: false }` would drop `userId: null` rows
(admin-seeded reviews and payments whose buyer was erased). The `NOT`
form keeps those in admin lists and public averages.

## Constraints

- Rating-only reviews (no `reviewText`) count toward featured header
  totals but never appear in the featured carousel.
- Admin can seed many reviews per template; couples are limited to one
  **in application code**, not in the database.
- Photo upload failures are logged and ignored; the review still saves.
- Account deletion deletes the user's reviews and collects
  `couplePhotoUrl` for storage cleanup.

## Pitfalls

- Do not restore `upsert({ where: { templateId_userId } })`. That unique
  key is gone; every couple submit would 500.
- Local / disk-only deploys never persist couple or admin review photos.
- `/api/reviews/featured` averages a different set than it lists. The
  header is platform-wide; the cards are text reviews only.
- Hiding a review does not rewrite `Template.avgRating` until
  `recalcAvgRating` runs. A couple edit in between can put the hidden
  rating back into the stored average.
