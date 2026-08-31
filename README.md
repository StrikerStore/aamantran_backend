# Aamantran Backend

Aamantran Backend is the Node.js/Express API for the Aamantran wedding
invitation platform. It serves the public template catalog and invitation
renderer, admin management APIs, couple dashboard APIs, checkout flows, email
automation, and template storage/versioning.

## Stack

- Runtime: Node.js, CommonJS modules
- HTTP: Express, Helmet, CORS, express-rate-limit
- Database: MySQL through Prisma
- Payments: PayU
- Email: SMTP through Nodemailer
- Storage: local disk for development, Cloudflare R2 when all R2 env vars are set
- Templates: ZIP uploads, Handlebars rendering, immutable published versions
- Jobs: node-cron email reminders and event notifications

## Quick start

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

The API listens on `PORT` or `4000` by default. Check the server with:

```bash
curl http://localhost:4000/health
```

`npm install` runs `prisma generate` through `postinstall`. `npm run db:migrate`
uses Prisma development migrations. For production-style deploys, use
`npm run db:deploy` or `npm start` as described in
[`docs/deployment-runbook.md`](docs/deployment-runbook.md).

## URL layout

The backend derives public links, CORS origins, and email links from these env
vars:

| Env var | Development default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:4000` | API, PayU callback, invite SDK base |
| `LANDING_URL` | `http://localhost:3000` | Landing page, checkout, onboarding |
| `COUPLE_DASHBOARD_URL` | `http://localhost:3001` | Couple dashboard redirects and emails |
| `ADMIN_URL` | `http://localhost:5174` | Admin origin for CORS |

Production defaults are set in `src/config/siteUrls.js`, but explicit env vars
should be used in deployed environments.

## Main route groups

| Surface | Prefix | Source |
| --- | --- | --- |
| Health check | `GET /health` | `src/app.js` |
| Public invitation rendering | `/demo/:slug`, `/i/:slug`, `/i/:slug/preview` | `src/routes/render.js` |
| Public checkout | `/api/checkout/*` | `src/routes/publicCheckout.js` |
| Public template catalog and reviews | `/api/templates/*`, `/api/reviews/*` | `src/routes/publicTemplates.js` |
| Public RSVP and wishes | `/api/public/*` | `src/routes/publicInvite.js` |
| Admin API | `/api/v1/*` | `src/routes/index.js` |
| Couple dashboard API | `/api/user/*` | `src/routes/userEvents.js` |
| PayU IPN webhook | `POST /webhooks/payu` | `src/routes/webhook.js` |
| R2 asset proxy | `/r2-proxy/*` | `src/routes/r2Proxy.js` |

Admin endpoints use the admin JWT middleware. Couple dashboard endpoints use the
user JWT middleware.

## Documentation

- [Deployment runbook](docs/deployment-runbook.md) - production env checklist,
  startup behavior, migrations, storage, email, and rate limits.
- [PayU payments](docs/payments-payu.md) - checkout order creation, PayU
  redirects, IPN processing, dummy payments, and swap balance links.
- [Templates and versioning](docs/templates-and-versioning.md) - draft folders,
  published snapshots, publish semantics, backfill, and render behavior.
- [Couple planning API](docs/couple-planning-api.md) - recently expanded couple
  dashboard planning resources, request shapes, uploads, and ownership rules.

## Common pitfalls

- `JWT_SECRET` must be at least 32 characters in production or startup exits.
- PayU webhooks are form-encoded and mounted before JSON parsing; do not move
  `/webhooks` behind `express.json()` without preserving that behavior.
- `DUMMY_PAYMENT_MODE=true` is only for development/staging. `/api/checkout/mock-success`
  is blocked when `NODE_ENV=production`.
- R2 is enabled only when every required R2 env var is present. Otherwise
  templates are served from local `STORAGE_PATH` under `/s`.
- `npm start` runs `prestart`: it resolves known rolled-back migrations, deploys
  Prisma migrations, and runs the template-version backfill with `--apply`.
- `npm run db:seed` currently points at `prisma/seed.js`; ensure that file exists
  before using the script.
