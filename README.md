# Aamantran Backend

Express and Prisma API for Aamantran, a wedding invitation platform. The
backend serves public template demos and live invitations, powers the admin and
couple dashboards, handles PayU checkout/onboarding, stores uploaded template
assets, and sends transactional email through SMTP.

## Tech stack

- Node.js + Express
- Prisma ORM with MySQL
- JWT authentication for admin and couple-dashboard APIs
- PayU payment redirects and IPN webhooks
- Nodemailer SMTP email delivery
- Local disk storage by default, with optional Cloudflare R2 object storage

## Local setup

1. Install dependencies.

   ```sh
   npm install
   ```

2. Create a local environment file.

   ```sh
   cp .env.example .env
   ```

3. Set at least these values in `.env`:

   - `DATABASE_URL` for a MySQL database
   - `JWT_SECRET` for admin, user, and preview tokens
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` for admin login
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` for email
   - PayU credentials, or `DUMMY_PAYMENT_MODE=true` for non-production checkout

4. Prepare the database.

   ```sh
   npm run db:migrate
   npm run db:seed
   ```

5. Start the API.

   ```sh
   npm run dev
   ```

   The API listens on `PORT` or `4000`. The health check is `GET /health`.

## Important scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the API with nodemon. |
| `npm start` | Start `src/server.js`. `prestart` runs deployed migrations and the template-version backfill first. |
| `npm run db:migrate` | Run Prisma migrations in development. |
| `npm run db:deploy` | Deploy Prisma migrations and run the template-version backfill. |
| `npm run db:backfill-versions` | Backfill template `draft/` and `v1/` folders for legacy templates. |
| `npm run db:generate` | Regenerate the Prisma client. |
| `npm run db:seed` | Seed initial data from `prisma/seed.js`. |
| `npm run db:studio` | Open Prisma Studio. |

## Runtime URLs and CORS

`src/config/siteUrls.js` defines canonical frontend URLs. Environment variables
override defaults:

| Variable | Used for |
| --- | --- |
| `API_BASE_URL` | Backend callback URLs, invite SDK context, generated links. |
| `LANDING_URL` | Checkout and onboarding redirects. |
| `ADMIN_URL` | Admin frontend CORS origin. |
| `COUPLE_DASHBOARD_URL` | Couple dashboard links and CORS origin. |

In production, `JWT_SECRET` must be set and at least 32 characters long. The API
trusts one reverse proxy by default for Railway-style deployments; set
`TRUST_PROXY=0` only when no reverse proxy is in front of the API.

## API surface

Routes are mounted in `src/routes/index.js`.

| Prefix | Auth | Purpose |
| --- | --- | --- |
| `/api/v1/auth` | Admin credentials | Admin login. |
| `/api/v1/templates` | Admin JWT | Template upload, demo data, publish, version management. |
| `/api/v1/users` | Admin JWT | User/event administration, template changes and swaps. |
| `/api/v1/transactions` | Admin JWT | Payments and refunds. |
| `/api/v1/tickets` | Admin JWT | Support ticket administration. |
| `/api/v1/coupons` | Admin JWT | Coupon management. |
| `/api/v1/assets` | Admin JWT for writes | Global asset management. |
| `/api/assets` | Public GET | Public global asset listing. |
| `/api/v1/reviews` | Admin JWT | Review moderation and admin-created reviews. |
| `/api/user/auth` | User credentials | Couple-dashboard login and recovery. |
| `/api/user/events` | User JWT | Event data, guests, media, publishing, planning tools. |
| `/api/user/tickets` | User JWT | Couple support tickets. |
| `/api/user` | User JWT | Profile and review submission. |
| `/api/templates` | Public | Active template catalog and template detail. |
| `/api/reviews` | Public | Public template reviews. |
| `/api/checkout` | Public, rate limited | Coupons, PayU checkout, onboarding registration. |
| `/api/public` | Public, rate limited | RSVP, guest wishes, public function data. |
| `/api/contact` | Public, rate limited | Landing-page contact form. |
| `/demo/:slug` | Public | Draft template demo render with demo data. |
| `/i/:slug` | Public | Published live invitation render. |
| `/i/:slug/preview?pt=...` | Signed preview token | Draft invitation preview. |
| `/sdk/aamantran-sdk.js` | Public | Browser SDK injected into rendered invitations. |
| `/webhooks/payu` | PayU hash | PayU IPN callback. |
| `/r2-proxy/*` | Public | Proxy for R2 assets when direct browser access is unsafe. |

## Core workflows

### Template lifecycle

Source: `src/routes/templates.js`, `src/controllers/templates.controller.js`,
`src/services/fileManager.js`, `src/routes/render.js`, and
`prisma/schema.prisma`.

1. Admin uploads a template ZIP to `POST /api/v1/templates`.
2. The ZIP is extracted into `templates/{slug}/draft/`.
3. `GET /demo/:slug` always renders the mutable `draft/` folder so admins can
   preview in-progress uploads.
4. `PATCH /api/v1/templates/:id/publish` creates the first immutable
   `TemplateVersion` snapshot at `templates/{slug}/v1/` and marks the template
   active.
5. Re-uploading files with `PUT /api/v1/templates/:id/files` overwrites only the
   draft folder. Existing live invitations stay pinned to their version.
6. `POST /api/v1/templates/:id/publish-changes` snapshots the current draft into
   the next `v{n}/` folder and repoints all events using that template to the new
   version.
7. Historical versions can be deleted only when they are not current and no
   event still pins them.

The `prestart` and `db:deploy` scripts run
`scripts/backfill-template-versions.js --apply` to create `v1/` and `draft/`
folders for legacy templates that do not have `currentVersionId`.

### Checkout and onboarding

Source: `src/routes/publicCheckout.js`, `src/routes/webhook.js`,
`src/services/payu.service.js`, and `src/services/email.service.js`.

1. `POST /api/checkout/coupon-preview` validates a coupon and returns the price
   breakup.
2. `POST /api/checkout/order` creates a pending `Payment`, generates a readable
   `orderId`, and returns PayU form params.
3. PayU redirects back to `/api/checkout/payu-success` or
   `/api/checkout/payu-failure`. PayU IPN posts to `/webhooks/payu`.
4. Successful payments are marked `paid`, template buyer count is incremented,
   and a purchase confirmation email is queued with an onboarding URL.
5. `POST /api/checkout/register` converts a paid purchase into a couple
   dashboard user and event.

For local and staging checkout without PayU, set `DUMMY_PAYMENT_MODE=true` and
call `POST /api/checkout/mock-success`. This endpoint is blocked when
`NODE_ENV=production`.

### Couple dashboard and planning APIs

Source: `src/routes/userEvents.js`,
`src/controllers/userDashboard.controller.js`, and
`src/controllers/planning.controller.js`.

All `/api/user/events/*` routes require a user JWT. The main event resources
cover people, functions, venues, custom fields, media, guests, wishes,
publishing, and statistics.

Planning resources are nested under `/api/user/events/:id`:

| Resource | Endpoints |
| --- | --- |
| Tasks | `GET/POST /tasks`, `PATCH/DELETE /tasks/:tid` |
| Inventory | `GET/POST /inventory`, `PATCH/DELETE /inventory/:iid` |
| Budget | `GET/PUT /budget`, `GET/POST /budget/expenses`, `PATCH/DELETE /budget/expenses/:xid` |
| Vendors | `GET/POST /vendors`, `PATCH/DELETE /vendors/:vid` |
| Timeline | `GET/POST /timeline`, `PATCH/DELETE /timeline/:eid` |
| Mood board | `GET/POST /moodboard`, `GET /pinterest-oembed`, `DELETE /moodboard/:mid` |
| Gifts | `GET/POST /gifts`, `PATCH/DELETE /gifts/:gid` |
| Photo wall | `GET/POST /photos`, `DELETE /photos/:pid` |

Multipart uploads for media, mood-board pins, and photos use a `file` field.

### Live invitation rendering

Source: `src/routes/render.js`, `src/services/templateRenderer.js`, and
`src/services/aamantranSdk.js`.

- `/demo/:slug` renders the template draft with demo data and injects a buy bar.
- `/i/:slug` renders only published events. It rejects unpublished events and
  expired invitations, logs a non-blocking `InvitationEvent`, and injects
  `window.__AAMANTRAN__` context for RSVP, wishes, functions, and photos.
- Desktop or mobile template entry files are selected from the `view` query
  parameter when present, otherwise from the user agent.
- Live invitations render from their pinned `TemplateVersion`; legacy rows fall
  back to the template draft only if backfill has not populated
  `templateVersionId`.

### Full and partial invitations

Events may be paired with `invitePairId` and scoped with `inviteScope`:

- `full` events include all functions.
- `subset` events include only selected functions.

Public RSVP and wish APIs resolve the correct event for the invite slug so guest
activity stays attached to the appropriate full or partial invitation.

### Storage modes

Source: `src/config/storage.js`, `src/services/objectStorage.js`, and
`src/routes/r2Proxy.js`.

Local disk is the default. Template files live under `STORAGE_PATH/templates`
and user uploads under `uploads/`; Express serves them at `/s/*` and
`/uploads/*`.

Cloudflare R2 is enabled only when all of these are set:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_BASE_URL`

When R2 is enabled, browser-facing URLs use `R2_PUBLIC_BASE_URL` and the local
static `/s` and `/uploads` mounts are disabled. The `/r2-proxy/*` route can
serve R2-backed assets through the API when direct CDN access causes CSP or CORS
problems.

## Operational notes and pitfalls

- Current checkout routes use PayU. Do not configure new environments with
  Razorpay-only variables.
- SMTP is required for purchase confirmations, onboarding, support replies,
  contact form delivery, and scheduled reminder emails. `src/server.js` sends a
  startup test email and logs failures without stopping the process.
- `POST /webhooks/payu` must remain mounted before JSON body parsing because
  PayU sends `application/x-www-form-urlencoded` callbacks.
- Rate limits are configured in `src/middleware/rateLimits.js`; override the
  documented `RATE_LIMIT_*` variables when traffic profiles change.
- There are currently no automated tests in the repository. For docs-only or
  config-only changes, verify with targeted source review and `git diff`.
