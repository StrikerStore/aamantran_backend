# Unpublished invite preview

`GET /i/:slug/preview` renders an invitation without the public-open side
effects. An unpublished event needs a signed `pt` query parameter. A published
event does not.

Code: `verifyInvitePreviewToken` in `src/routes/render.js`, minting in
`src/services/previewToken.js`.

## Token

`mintInvitePreviewToken(slug)` signs a JWT with `process.env.JWT_SECRET`
(HS256, jsonwebtoken default). It does not use `JWT_SECRET_ADMIN`,
`JWT_SECRET_USER`, or `JWT_SECRET_DEV`. Rotating an audience secret leaves
existing preview links valid. Rotating `JWT_SECRET` invalidates them, and
minting throws if that variable is missing. Production boot already refuses to
start when `JWT_SECRET` is missing or shorter than 32 characters.

| Claim | Value |
| --- | --- |
| `typ` | `inv_preview` |
| `slug` | `String(slug)` from the event row |
| `iss` | `aamantran:preview` |
| lifetime | `24h` from the moment of mint |

`verifyInvitePreviewToken` returns false when `pt` or the expected slug is
missing, the signature or issuer or expiry fails, `typ` is not `inv_preview`,
or `slug` is not exactly the event's slug. A token for one slug does not open
another. There is no audience, no `pv` password version, no one-time use, and
no binding to the admin or couple who minted it. Anyone who has the URL can
fetch the HTML until it expires.

The token sits in the query string (`pt`). It will show up in access logs,
browser history, and any same-origin `Referer`. The preview response does not
set its own `Referrer-Policy`. Helmet on the app sets
`strict-origin-when-cross-origin`.

Each mint is a new JWT. Lab responses mint three (preview, mobile, desktop)
because `view` is not inside the token. Testing status and lab payloads mint
again on every response, so a bookmarked `urls.preview` dies 24 hours after
that response, not 24 hours after the event was created.

## Who mints

| Caller | Route | Auth |
| --- | --- | --- |
| Couple dashboard | `GET /api/user/events/:id/preview-token` | Couple JWT (`src/routes/userEvents.js`). Owner only. Anyone else gets 404 `{ ok: false, message: "Event not found" }`. |
| Admin user page | `GET /api/v1/users/:id/events/:eventId/preview-token` | Admin JWT. The event must belong to `:id`, else 404. |
| Template testing | `urls.preview` on testing status, load, publish, and repin | Admin JWT. Built in `testing.controller.js` `buildUrls`. |
| Template Lab | `urls.preview`, `urls.mobile`, `urls.desktop` | Developer JWT. `view=mobile` or `view=desktop` is only on the mobile and desktop URLs. |

The couple and admin token routes respond `{ ok: true, previewUrl }` and do
not return the raw JWT on its own. `previewUrl` is
`{API_BASE_URL}/i/{slug}/preview?pt={token}` with the trailing slash stripped
from the base.

## What the preview route does

`GET /i/:slug/preview`:

1. Loads the event by slug, with the same relations as the live invite. Unknown
   slug is HTML 404 `Invitation not found`.
2. If `isPublished` is false, requires a valid `pt` for that slug. Failure is
   HTML 403 `Preview not available` (not JSON).
3. If `isPublished` is true, `pt` is ignored. The page is public.
4. Overlays the paired full invite's people and media when this row is a
   `subset` (`withPairPhotos`). Functions stay on this row.
5. Renders the pinned `templateVersion` when `templateVersionId` is set,
   otherwise `{folderPath}/draft`. The route comment says "draft preview". The
   branch above is what actually runs. A published couple invite with a pinned
   version does not show the mutable draft. Loading the testing event as
   `draft` (or repinning to `draft`) sets `templateVersionId` null, which is
   what makes this route read the draft folder. `current` pins the snapshot.
6. `?view=mobile` or `?view=desktop` forces the variant. Anything else uses the
   User-Agent test in `detectVariant`.

Compared with `GET /i/:slug`, preview does not:

- return 410 after `expiresAt` or six months past the last function
- write an `InvitationEvent` of type `opened`
- inject the RSVP/wishes SDK or social meta

An expired published invite can still render here. Refreshing preview does not
move the couple's open count. RSVP and wish forms on this HTML have no SDK.

Cache headers are `no-store` (same helper as the live invite). A test event
(`isTestEvent`) also gets `X-Robots-Tag: noindex, nofollow, noarchive` and
`frame-ancestors` widened to the lab origin. Every other preview keeps
helmet's `frame-ancestors 'self'`.

This is not `GET /try/:token` and not `GET /demo/:slug`. Those render demo
data. Preview renders the event row.
