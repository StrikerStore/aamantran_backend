# Template Lab

Sandbox for external template developers. A developer uploads a ZIP, gets a
fully populated invite at `/i/lab-<handle>`, re-uploads, and refreshes --
without a payment, a store listing, or any path into admin or couple APIs.

## Intent

- Let a contractor iterate on HTML/CSS/JS against real renderer output.
- Seed every optional field so `{{#if}}` empty states can be proven, not just
  the happy path.
- Keep sandbox traffic out of revenue, reviews, RSVP emails, retention, and
  the public catalogue.

Source of truth: `src/controllers/devLab.controller.js`,
`src/services/developerAccount.service.js`,
`src/services/sandboxSeed.service.js`.

## Architecture

| Piece | Location |
| --- | --- |
| Dev auth | `src/routes/devAuth.js` at `/api/dev/auth` |
| Lab API (JWT `role: dev`) | `src/routes/devLab.js` at `/api/dev` |
| Dev JWT middleware | `src/middleware/devAuth.js` |
| Account + sandbox user | `src/services/developerAccount.service.js` |
| Seed presets | `src/services/sandboxSeed.service.js` |
| Schema vs HTML warnings | `src/services/templateIntrospect.service.js` |
| Admin provision | `src/routes/testing.js` at `/api/v1/testing/developers` |
| CLI provision | `npm run dev:account` -> `scripts/create-dev-account.js` |
| Catalogue / checkout exclusion | `EXCLUDE_SANDBOX_TEMPLATE` in `src/utils/testFilters.js` |

Each `DeveloperAccount` owns one sandbox `User` (`isTestAccount: true`) and a
permanent invite slug `lab-<handle>`. Sandbox `Event.templateVersionId` is
always `null`, so `routes/render.js` serves `templates/{slug}/draft/` -- the
folder every ZIP re-upload overwrites. Identity on templates is
`Template.sandboxOwnerId`; catalogue queries require that column to be null.

A developer JWT is never interchangeable with admin or couple tokens: issuer
is `aamantran:dev`, secret is `JWT_SECRET_DEV` (falls back to `JWT_SECRET`),
and `/api/v1/*` is a different mount.

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `LAB_URL` | `http://localhost:5175` (dev), `https://lab.aamantran.online` (prod) | CORS allow-list and Lab iframe `frame-ancestors` |
| `JWT_SECRET_DEV` | falls back to `JWT_SECRET` | Preferred so rotating Lab access cannot disturb admin or couple sessions |
| `RATE_LIMIT_LAB_UPLOAD_MAX` | `60` per 15 minutes, keyed on `req.dev.id` | Create + replace ZIP only |
| `POLICY_VERSION` | `2026-07-08` | Written on the sandbox user at create |

`siteUrls.labUrl()` is also added to CORS in `src/app.js`. Helmet still emits
`frame-ancestors 'self'` for live couple invites; `allowLabFraming` in
`src/routes/render.js` widens that directive for **test events only**.

Passwords must pass `validateNewPassword` (`src/utils/authSecurity.js`): 8-128
chars, not a single repeated character, not in the common-password list.

## Provisioning

Plaintext passwords are printed or returned **once** and never stored
recoverably. `--rotate` and the matching admin route also rewrite the sandbox
user hash so the couple-app "open the wizard" login stays in sync.

### CLI

```
npm run dev:account -- --email dev@example.com --handle arjun --name "Arjun S"
npm run dev:account -- --handle arjun --rotate
npm run dev:account -- --handle arjun --disable
npm run dev:account -- --handle arjun --enable
```

Optional: `--password`, `--limit` (default `templateLimit` is 10).

Handle is forced to `[a-z0-9-]` (`normalizeHandle`). The invite slug
`lab-<handle>` must be free before create, or the call 409s.

### Admin API (admin JWT)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/testing/developers` | Includes `labUrl` and `inviteUrl` |
| POST | `/api/v1/testing/developers` | Body: `{ email, name, handle, password?, templateLimit? }` -- returns `generatedPassword` once |
| POST | `/api/v1/testing/developers/:handle/rotate-password` | Body: `{ password? }` |
| PATCH | `/api/v1/testing/developers/:handle/active` | Body: `{ isActive }` -- `devAuth` re-reads this on every request |
| DELETE | `/api/v1/testing/developers/:handle` | Purges sandbox events, deletes the developer + sandbox user, then best-effort folder delete |

`:handle` also accepts the account email.

## Developer auth

Login is rate-limited with the shared auth limiter. Timing is equalized with a
dummy bcrypt hash when the handle is unknown. A disabled account is checked
**after** the password so it cannot be distinguished from a wrong password
unless the caller already knows the password.

```
POST /api/dev/auth/login
{ "handle": "arjun", "password": "..." }
```

`handle` also accepts the account email. Success:

```json
{
  "ok": true,
  "token": "<jwt>",
  "expiresIn": "12h",
  "developer": { "id": "...", "handle": "arjun", "name": "...", "email": "..." }
}
```

Token claims: `role: "dev"`, `id`, `handle`, `email`, `pv` (12-char SHA-256 of
the password hash). Password rotation invalidates every open Lab session.
`GET /api/dev/auth/me` returns `{ id, handle, name, email, templateLimit, createdAt }`.

## Developer API

Every `/api/dev/*` route (except login) requires the Lab JWT. Template ids in
the URL are always looked up with `sandboxOwnerId = req.dev.id`.

### Templates

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/dev/templates` | -- |
| POST | `/api/dev/templates` | multipart: `templateZip` required; `name?`, `fieldSchema?` (JSON string) |
| PUT | `/api/dev/templates/:id/files` | multipart: `templateZip` -- re-extracts over the same draft folder |
| GET | `/api/dev/templates/:id/schema` | -- |
| PUT | `/api/dev/templates/:id/schema` | `{ fieldSchema, preset? }` -- reseeds if this template is active |
| POST | `/api/dev/templates/:id/activate` | `{ preset?, musicUrl?, publish? }` |
| DELETE | `/api/dev/templates/:id` | Purges the sandbox event if this template is active |

The first ZIP upload activates immediately (`preset: full`) so one action
yields a working preview URL. Later uploads only replace files and clear
`EventRenderCache`.

Sandbox templates are created `price: 0`, `isActive: false`, slug
`lab-<handle>-<name>-<id>`. `/demo/:slug` returns 404 for any template with
`sandboxOwnerId` set -- there is no "Buy now" path.

`GET /api/dev/templates` also returns `limit`, the active sandbox `event`, and
preview URLs (`invite`, `preview`, `mobile`, `desktop`). Activate defaults to
`publish: false`, so `/i/lab-<handle>` 403s until published; the signed
`preview` / `mobile` / `desktop` URLs work immediately. Tokens come from
`mintInvitePreviewToken` (`src/services/previewToken.js`). Test-event HTML
sets `X-Robots-Tag: noindex` and allows Lab iframe framing.

### Sandbox content

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/dev/sandbox` | -- |
| PUT | `/api/dev/sandbox` | `{ groomName?, brideName?, links?, toggles?, customFields?, musicUrl?, publish? }` |
| POST | `/api/dev/sandbox/preset` | `{ preset }` |
| POST | `/api/dev/sandbox/reset` | Purge + reseed `full` |
| GET | `/api/dev/assets` | Shared `GlobalAsset` music library (id, type, name, url) |

`PUT /api/dev/sandbox` writes `groomName` / `brideName` onto both the Event
columns and the matching `eventPerson` rows -- the renderer reads
`{{groom_name}}` from the column and `{{#person}}` from the rows.

`instagramHashtag` is stored **bare** (leading `#` stripped, max 120).
Templates should print `{{hashtag}}` (already `#...`) or `{{hashtag_raw}}`.

Activate and schema-save **delete-and-recreate** the sandbox event (same
approach as admin `load-template`) so counters and flags cannot survive a
reseed.

## Seed presets

`PRESETS` in `src/services/sandboxSeed.service.js` -- one row per empty-state
the template guide cares about. Default is `full`.

| Key | What it proves |
| --- | --- |
| `full` | Every optional field populated (10 people, 3 functions, stock photos, links) |
| `minimal` | Custom fields, links, and hashtag cleared |
| `single-function` | One ceremony (the Wedding row, not Mehendi) |
| `many-functions` | Eight ceremonies |
| `no-media` | No photos or music |
| `guest-features-off` | `rsvpEnabled` and `guestNotesEnabled` false |
| `no-date` | Zero functions **and** no `wedding_date` custom field (the only way `{{wedding_date_iso}}` is empty) |

Custom-field values are invented from the developer's own `fieldSchema`
(`deriveCustomFields`). Undeclared `{{keys}}` stay blank -- that is also what
production does. `wedding_date` is seeded even when undeclared so countdowns
have a date, except on `no-date`.

People names used by every preset: Arjun Sharma / Meera Nair plus the eight
parent and grandparent roles the guide documents.

## Schema analysis

`checkSchemaAgainstHtml` compares draft HTML to `fieldSchema`. Findings are
**advisory** -- a warning never rejects a save. The parse is a regex over
Handlebars source, not a compile.

- Used but not declared (`custom-undeclared`, `role-undeclared`,
  `slot-undeclared`) -- will render empty for a real couple.
- Declared but unused -- usually a typo on one side.

Built-ins (`bride_name`, `hashtag`, `rsvp_enabled`, ...) and registered
helpers are never reported as undeclared custom fields.

## Isolation

- Lab JWT cannot reach `/api/v1/*` or `/api/user/*`.
- Sandbox owner is `isTestAccount`; sandbox event is `isTestEvent`. Existing
  `testFilters.js` exclusions apply with no extra Lab-specific clauses.
- Public gallery, checkout, and `/demo` use `EXCLUDE_SANDBOX_TEMPLATE`
  (`sandboxOwnerId: null`). A stray `isActive: true` still cannot list a Lab
  ZIP in front of a buyer.
- `GET /api/dev/assets` is the shared music library, not the developer's
  private files.

## Pitfalls

- Re-upload is "extract + refresh". If the preview looks stale, the render
  cache was not cleared -- `replaceFiles` deletes `EventRenderCache` for the
  sandbox event; a cached CDN or browser tab can still lie.
- `templateLimit` is enforced **before** ZIP extract. Delete an old sandbox
  template before uploading another.
- `PUT /schema` reseeds the active event. Custom values the developer typed
  in the Lab are replaced by derived samples.
- Disabling (`isActive: false`) takes effect on the next authenticated
  request; leftover tokens are not enough.
- Do not publish a sandbox event to a public slug. The invite is always
  `lab-<handle>`; `publish: true` only flips `isPublished` on that row so
  `/i/lab-<handle>` is reachable without a preview token.
- Storage folders are collected before a developer DELETE; leftover objects
  after a failed R2 delete are orphaned. Dry-run first:
  `npm run storage:orphans -- --lab-only`
  (`scripts/cleanup-orphan-templates.js`). `--apply` requires
  `--confirm=<bucket>` so a local `.env` cannot wipe the production bucket.
