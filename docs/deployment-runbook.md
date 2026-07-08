# Deployment runbook

Use this runbook for production-style deploys of the Aamantran backend.

## Codepaths

| Concern | Source |
| --- | --- |
| Startup script | `package.json` |
| Server startup | `src/server.js` |
| App middleware and route order | `src/app.js` |
| Canonical URLs | `src/config/siteUrls.js` |
| Storage selection | `src/config/storage.js` |
| Email transport | `src/services/email.service.js` |
| Scheduled email jobs | `src/services/scheduler.js` |
| Rate limits | `src/middleware/rateLimits.js` |

## Required environment checklist

### Database

```env
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/aamantran"
```

### URLs

Set these explicitly in production so CORS, PayU callbacks, invite links, and
emails all point to the deployed surfaces:

```env
API_BASE_URL="https://api.aamantran.online"
LANDING_URL="https://www.aamantran.online"
ADMIN_URL="https://admin.aamantran.online"
COUPLE_DASHBOARD_URL="https://app.aamantran.online"
```

`src/config/siteUrls.js` has production defaults for these values, but explicit
env vars avoid accidental cross-environment links.

### JWT

```env
JWT_SECRET="at-least-32-random-characters"
JWT_EXPIRES_IN="8h"
```

When `NODE_ENV=production`, `src/server.js` exits before listening if
`JWT_SECRET` is missing or shorter than 32 characters.

### Admin login

```env
ADMIN_EMAIL="aamantran@plexzuu.com"
ADMIN_PASSWORD="..."
```

Admin auth uses environment credentials and issues admin JWTs.

### PayU

```env
PAYU_MERCHANT_KEY="..."
PAYU_MERCHANT_SALT="..."
PAYU_ENV="prod"
```

Use `PAYU_ENV=test` only for test gateway forms. See
[`payments-payu.md`](payments-payu.md).

### SMTP

```env
SMTP_HOST="smtp.example.com"
SMTP_PORT=587
SMTP_USER="..."
SMTP_PASS="..."
EMAIL_FROM="Aamantran <noreply@example.com>"
```

The email transport throws if `SMTP_HOST`, `SMTP_USER`, or `SMTP_PASS` is
missing. On every server start, `src/server.js` attempts to send a test email to
`admin@plexzuu.com` and logs success or failure.

### Storage

Local disk:

```env
STORAGE_PATH="./storage"
```

Cloudflare R2:

```env
R2_ACCOUNT_ID="..."
R2_ACCESS_KEY_ID="..."
R2_SECRET_ACCESS_KEY="..."
R2_BUCKET_NAME="aamantran-prod"
R2_PUBLIC_BASE_URL="https://media.aamantran.online"
```

R2 is enabled only when all five R2 vars are non-empty. If any are missing, the
backend uses local disk and serves templates from `/s` and uploads from
`/uploads`.

## Start commands

### Development

```bash
npm install
npm run db:migrate
npm run dev
```

### Production-style migration deploy

```bash
npm run db:deploy
```

This runs:

```bash
npx prisma migrate deploy
node scripts/backfill-template-versions.js --apply
```

### Production start

```bash
npm start
```

Before `node src/server.js`, the `prestart` script:

1. Resolves a fixed list of known rolled-back Prisma migrations.
2. Runs `npx prisma migrate deploy`.
3. Runs `node scripts/backfill-template-versions.js --apply`.

Watch deployment logs for Prisma migration failures, skipped template backfills,
and SMTP test failures.

## Middleware and routing constraints

- Trust proxy defaults to `1` for Railway/reverse proxy deployments. Set
  `TRUST_PROXY=0` only when the API is not behind a proxy.
- Helmet CSP allows PayU frames/forms, configured R2 media origin, Google Fonts,
  and common video embed hosts.
- CORS origins come from `LANDING_URL`, `ADMIN_URL`, `COUPLE_DASHBOARD_URL`,
  `API_BASE_URL`, optional `R2_PUBLIC_BASE_URL`, PayU origins, and localhost
  origins outside production.
- `/webhooks` is mounted with `express.urlencoded()` before global JSON parsing
  because PayU IPN is form-encoded.
- `/r2-proxy` is mounted before other public routes.

## Rate limits

Defaults are in requests per window:

| Env var | Default | Window | Applies to |
| --- | ---: | --- | --- |
| `RATE_LIMIT_GLOBAL_MAX` | 600 | 15 minutes | All routes except `/health` and `/webhooks` |
| `RATE_LIMIT_AUTH_MAX` | 30 | 15 minutes | Auth login |
| `RATE_LIMIT_RECOVERY_MAX` | 10 | 1 hour | Account recovery |
| `RATE_LIMIT_CHECKOUT_MAX` | 120 | 15 minutes | Checkout router |
| `RATE_LIMIT_PUBLIC_INVITE_MAX` | 200 | 15 minutes | Public invite/template routers |
| `RATE_LIMIT_LOOKUP_MAX` | 60 | 15 minutes | Public checkout lookup routes |

## Scheduled jobs

Importing `src/services/scheduler.js` registers cron jobs at app startup:

| Schedule | Job |
| --- | --- |
| `0 * * * *` | Send onboarding reminders for paid, not-onboarded payments after 24 hours |
| `*/30 * * * *` | Send RSVP milestone emails at 10, 25, 50, and 100 attending RSVPs |
| `0 9 * * *` | Send event countdown emails 7 and 1 days before, and thank-you emails after |

Milestone/countdown jobs process published full-scope events (`inviteScope` null
or `full`) with owner email addresses.

## Post-deploy checks

1. `GET {API_BASE_URL}/health` returns `{ ok: true, ts: ... }`.
2. Server logs show the API listening on the expected port.
3. Prisma migrations and template backfill complete without errors.
4. SMTP test log is understood; failure does not stop startup but means emails
   will fail later.
5. A PayU test order posts to the intended PayU environment and returns to the
   configured `API_BASE_URL`.
6. A demo template renders at `/demo/:slug`; a live invitation renders from its
   pinned `TemplateVersion`.
