# Deployment env check

`npm run check:env` runs `scripts/check-env.js`. Use it on the host after the
variables are in the environment, before taking traffic. It loads `.env` via
`dotenv` and prints names only. A value is never printed.

The process always exits 0 unless you pass `--strict`. `--strict` exits 1
when at least one required item is missing. Advised items never fail the
process. Nothing here opens the database or reads `AppSetting`, so it cannot
see which payment gateway an admin actually selected.

Production boot (`src/server.js`) does not run this script. In production it
exits if `JWT_SECRET` is missing or shorter than 32 characters, and it warns
on a missing `RAZORPAY_WEBHOOK_SECRET`, a `rzp_test` key, and a missing
`TRIAL_IP_SALT`. Every other gap below is silent at boot.

## Required

Reported as `MISSING`. These fail `--strict`.

| Name | Why the script complains |
| --- | --- |
| `DATABASE_URL` | nothing works without the database |
| `JWT_SECRET` | any non-empty string counts; length is not checked here |
| `TRIAL_IP_SALT` | the per-IP preview cap cannot be applied |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | template and photo storage |

`JWT_SECRET=short` is `MISSING`-clean and then production refuses to start.
Audience secrets (`JWT_SECRET_ADMIN`, `JWT_SECRET_USER`, `JWT_SECRET_DEV`)
are not checked. They fall back to `JWT_SECRET` in `src/utils/authSecurity.js`.

`TRIAL_IP_SALT` unset does not turn off the daily demo cap. `hashIp` returns
null, the per-IP count is treated as 0, and only that cap is skipped. The
route rate limiter still applies. See the trial comments in
`src/services/trialDemo.service.js`.

R2 is not actually on until `R2_PUBLIC_BASE_URL` is set as well
(`useObjectStorage`). That variable is advised, below. Without it the proxy
and the CDN rewrite stay off (`docs/r2-proxy.md`).

### Gateways

The checker does not know the India vs global admin setting. It only asks
whether some complete pair exists for each storefront.

A pair is complete when both halves are non-empty after trim:

- India PayU: `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT`
- International PayU: `PAYU_INTL_MERCHANT_KEY` and `PAYU_INTL_MERCHANT_SALT`
- Razorpay: `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`

| Condition | Reported name |
| --- | --- |
| India PayU incomplete and Razorpay incomplete | `PAYU_MERCHANT_KEY/SALT or RAZORPAY_KEY_ID/SECRET` |
| Razorpay incomplete and international PayU incomplete | `RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET` |
| Exactly one of `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` is set | `RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET` |
| Razorpay complete, webhook secret empty | `RAZORPAY_WEBHOOK_SECRET` |

A PayU key without its salt is simply "not configured". It is not called out
as a half pair. If Razorpay is complete, a missing or half-set PayU pair is
not a `MISSING` line, even when the admin setting still says PayU. Orders on
that setting are refused later, at checkout, not here.

An incomplete Razorpay pair does not count as configured. Setting only
`RAZORPAY_KEY_ID` (or only the secret) reports the half-pair line and the
India and global lines together.

When `NODE_ENV=production`:

- Razorpay complete and the key id starts with `rzp_test`: `MISSING` on
  `RAZORPAY_KEY_ID`.
- India PayU complete and `PAYU_ENV` is `test`: `MISSING` on `PAYU_ENV`.
  Unset `PAYU_ENV` counts as `prod` (`PAYU_ENV || 'prod'`).
- `DUMMY_PAYMENT_MODE=true` (any case): `MISSING`. Purchases complete without
  a charge.

The last line of output names the configured gateways. An empty side is an
em dash in the script. Razorpay is preferred over international PayU in that
label when both are set. The label is not the admin selection.

## Advised

Reported as `ADVISED`. `--strict` ignores them.

| Name | Note in the report |
| --- | --- |
| `R2_PUBLIC_BASE_URL` | media is served through the API instead of the CDN |
| `SMTP_HOST` | no email is sent, including purchase confirmations |
| `LANDING_URL_INTL` | falls back to the built-in default for the global storefront |
| `ADMIN_EMAIL` | nobody can sign in to the admin panel |

`SMTP_HOST` set with no user or password is still "present". The script does
not open a socket.

## Not checked

These are real switches this script never reads:

- `WEBSITE_REVALIDATE_SECRET` and `WEBSITE_REVALIDATE_ORIGINS` (missing secret
  is a silent five-minute website cache, not a boot failure)
- `INTERNAL_NOTIFY_TO`, `CONTACT_FORM_TO`
- `GST_REPORT_BRAND`, `GST_REPORT_VENDOR`
- `JWT_SECRET_*` audience overrides
- SMTP user, password, and from-address

A clean report means the names above are non-empty. It does not mean the
deployment can take a payment on the gateway the admin page has selected.
