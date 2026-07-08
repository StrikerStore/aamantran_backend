# Aamantran Backend

Backend API for the Aamantran wedding invitation platform. It serves the admin
API, couple dashboard API, public template catalog, checkout flow, invitation
rendering, PayU callbacks, and scheduled email reminders.

## Tech stack

- Node.js and Express (`src/server.js`, `src/app.js`)
- Prisma with MySQL (`prisma/schema.prisma`)
- Cloudflare R2-compatible object storage for production media/templates, with
  local disk fallback for development
- PayU for checkout, swap-balance payments, and refunds
- SMTP via Nodemailer for transactional email

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from `.env.example` and fill at least:

   ```bash
   cp .env.example .env
   ```

   Required for a working API:

   - `DATABASE_URL`
   - `JWT_SECRET`
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD`
   - `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` when exercising email flows

3. Run database migrations and Prisma generation:

   ```bash
   npm run db:migrate
   npm run db:generate
   ```

4. Start the API:

   ```bash
   npm run dev
   ```

5. Check health:

   ```bash
   curl http://localhost:4000/health
   ```

## Runtime scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the API with nodemon. |
| `npm start` | Run `src/server.js`. `prestart` deploys migrations and runs the template-version backfill. |
| `npm run db:deploy` | Deploy Prisma migrations and apply template-version backfill. |
| `npm run db:migrate` | Create/apply migrations in local development. |
| `npm run db:seed` | Run `prisma/seed.js` when available. |

`prestart` resolves several historical rolled-back migrations before deploying.
Keep that behavior in mind when comparing local migration state with production.

## Route map

All routes are mounted from `src/routes/index.js` except PayU IPN, which is
mounted directly at `/webhooks` before JSON body parsing.

| Area | Base path | Auth | Notes |
| --- | --- | --- | --- |
| Admin auth | `/api/v1/auth` | Public login | Issues admin JWTs. |
| Admin templates | `/api/v1/templates` | Admin JWT | Upload ZIPs/thumbnails, edit demo data, publish versions. |
| Admin users/events | `/api/v1/users` | Admin JWT | Manage users, invitations, media, and template swaps. |
| Admin transactions | `/api/v1/transactions` | Admin JWT | List payments and initiate PayU refunds. |
| Admin reviews | `/api/v1/reviews` | Admin JWT | Create, hide/show, delete template reviews. |
| Couple auth/profile | `/api/user/auth`, `/api/user` | User JWT | Dashboard login and profile APIs. |
| Couple events | `/api/user/events` | User JWT | Invitation editing plus planning tools. |
| Public templates/reviews | `/api/templates`, `/api/reviews` | Public | Gallery, template detail, featured reviews. |
| Public checkout | `/api/checkout` | Public | Coupon preview, order creation, PayU redirects, onboarding. |
| Public invites | `/i/:slug`, `/demo/:slug`, `/api/public` | Public | Invitation rendering and guest interactions. |
| PayU IPN | `/webhooks/payu` | PayU hash | Form-encoded body; bypasses global rate limit. |

See [`docs/technical-runbook.md`](docs/technical-runbook.md) for the checkout,
template versioning, planning, and review workflows.

## Data and storage model

- Monetary values are stored in paise (`Template.price`, `Payment.amount`,
  `discountAmount`, swap balances).
- Template ZIP uploads are extracted under `templates/{slug}/draft/` until
  published. Published snapshots live under `templates/{slug}/v{n}/`.
- Live invitations render from `Event.templateVersionId` when present. Demo pages
  render from the mutable draft.
- Local storage serves templates from `/s/...` and uploads from `/uploads/...`.
  R2 storage serves public object URLs and rewrites template assets through
  `/r2-proxy` for same-origin browser behavior.

## Common pitfalls

- PayU redirect/IPN bodies are form-encoded. Do not move `/webhooks` behind
  `express.json()` without preserving `express.urlencoded()`.
- `DUMMY_PAYMENT_MODE=true` is for development/staging only. The mock success
  endpoint is blocked when `NODE_ENV=production`.
- Template ZIP re-upload updates only the draft. Existing live invitations do
  not change until an admin calls `POST /api/v1/templates/:id/publish-changes`.
- `publish-changes` repoints all events on the template and clears render cache.
- Review photo upload currently persists a public URL only when R2 is enabled.
- Planning tool IDs are event-scoped by owner guard, but item update/delete calls
  rely on the route-level event ownership check rather than a composite item
  lookup. Keep dashboard calls scoped to the user's own event IDs.
