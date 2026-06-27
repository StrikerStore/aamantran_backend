# Aamantran Backend

Express and Prisma backend for the Aamantran wedding invitation platform. It
serves admin APIs, couple dashboard APIs, public invitation rendering, checkout,
webhooks, and operational jobs for template assets.

## Stack

- Node.js + Express
- Prisma ORM with MySQL
- Cloudflare R2-compatible object storage, or local disk in development
- PayU for checkout and refund flows
- SMTP via Nodemailer for transactional email

## Local setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy the environment example and fill required values:

   ```sh
   cp .env.example .env
   ```

3. Generate the Prisma client and apply migrations:

   ```sh
   npm run db:generate
   npm run db:migrate
   ```

4. Start the API:

   ```sh
   npm run dev
   ```

The API defaults to `http://localhost:4000`. The server sends a startup SMTP
test email, so set `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` when you want email
startup checks to pass.

## Runtime configuration

Important environment groups:

- `DATABASE_URL` - MySQL connection string.
- `API_BASE_URL`, `LANDING_URL`, `ADMIN_URL`, `COUPLE_DASHBOARD_URL` - canonical
  public origins for callbacks, emails, CORS, and links.
- `JWT_SECRET` - must be at least 32 characters in production.
- `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_ENV` - PayU checkout,
  callbacks, and refunds.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` - email.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` - enable R2 only when all are set.

See `.env.example` for defaults and optional rate limit overrides.

## API map

- Public rendering: `/demo/:slug`, `/i/:slug`, `/sdk/aamantran-sdk.js`
- Public checkout: `/api/checkout/*`
- PayU IPN webhook: `/webhooks/payu`
- Admin APIs: `/api/v1/*`
- Couple dashboard APIs: `/api/user/*`
- Public template/review/contact helpers: `/api/templates`, `/api/reviews`,
  `/api/public`, `/api/contact`

## Operational scripts

- `npm run db:deploy` - deploy Prisma migrations, then apply template-version
  backfill.
- `npm run db:backfill-versions` - apply only the template-version backfill.
- `npm start` - production entry point. The `prestart` script resolves known
  rolled-back migrations, deploys migrations, and applies the version backfill.

The `db:seed` script currently points at `prisma/seed.js`; that file is not
present in this repository.

## Engineering docs

- [PayU payments and checkout](docs/payments-payu.md)
- [Couple planning API](docs/couple-planning-api.md)
- [Template versioning and backfill](docs/templates-and-versioning.md)

