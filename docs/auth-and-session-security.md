# Auth and session security

Couple-dashboard login, admin login with optional TOTP, password recovery,
password policy, and JWT session invalidation. Source of truth is the
codepaths below.

## Architecture

| Audience | Login route | Middleware | JWT issuer | Secret helper |
| --- | --- | --- | --- | --- |
| Admin | `POST /api/v1/auth/login` (`src/routes/auth.js`) | `verifyAdminJWT` (`src/middleware/auth.js`) | `aamantran:admin` | `adminJwtSecret()` |
| Couple user | `POST /api/user/auth/login` (`src/routes/userAuth.js`) | `verifyUserJWT` (`src/middleware/userAuth.js`) | `aamantran:user` | `userJwtSecret()` |

Shared helpers live in `src/utils/authSecurity.js` and `src/utils/totp.js`.
Auth attempts and recovery events are written by `src/utils/authAudit.js`
to console and `AuthAuditLog` (retained ~13 months; see DPDP retention docs).

Rate limits (`src/middleware/rateLimits.js`):

- Login (admin + user + account delete): `authLoginLimiter` - default 30 / 15 min (`RATE_LIMIT_AUTH_MAX`)
- Recovery steps: `recoveryLimiter` - default 10 / 60 min (`RATE_LIMIT_RECOVERY_MAX`)

## JWT secrets

Both helpers fall back to `JWT_SECRET` when the audience-specific var is unset,
so existing deployments keep working:

```text
JWT_SECRET_ADMIN || JWT_SECRET   -> admin tokens
JWT_SECRET_USER  || JWT_SECRET   -> user + recovery tokens
```

Production startup (`src/server.js`) exits if `JWT_SECRET` is missing or
shorter than 32 characters. Prefer setting dedicated admin/user secrets once
you are ready to rotate audiences independently; preview tokens still use
`JWT_SECRET` only (`src/services/previewToken.js`).

Admin token TTL: `JWT_EXPIRES_IN` (default `8h`).
User token TTL: `7d` when `rememberMe` is true (default), else `1d`.

## Admin login and TOTP

`POST /api/v1/auth/login` body: `{ email, password, otp? }`.

Credential checks always run the same work whether or not the email matches
(timing-safe email compare + bcrypt against a dummy hash when needed) so
failures do not leak which field was wrong.

Password sources (checked in this order):

1. `ADMIN_PASSWORD_HASH` - bcrypt hash (preferred)
2. else plaintext `ADMIN_PASSWORD` - warned in production when the hash is unset

Optional second factor: when `ADMIN_TOTP_SECRET` (base32) is set, the server
requires a 6-digit `otp` and verifies it with RFC 6238 TOTP
(`src/utils/totp.js`, +/- 1 thirty-second step of clock drift).

| Outcome | Status | Body |
| --- | --- | --- |
| Missing email/password | `400` | `Email and password required` |
| Bad credentials | `401` | `Invalid credentials` (audited `admin_login_failed`) |
| TOTP configured, `otp` omitted | `401` | `{ code: "OTP_REQUIRED", ... }` |
| Bad TOTP | `401` | `{ code: "OTP_INVALID", ... }` (audited `admin_login_otp_failed`) |
| Success | `200` | `{ ok, token, expiresIn }` (audited `admin_login_success`) |

Generate a bcrypt hash for production:

```bash
node -e "console.log(require('bcrypt').hashSync(process.argv[1], 12))" 'your-admin-password'
```

Point an authenticator app at a standard `otpauth://totp/...` URI whose
secret matches `ADMIN_TOTP_SECRET`, then:

```bash
curl -X POST "$API_BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"...","otp":"123456"}'
```

## Couple-user login

`POST /api/user/auth/login` body: `{ username, password, rememberMe? }`.

- Username is trimmed and lowercased for lookup.
- bcrypt runs even when the user is missing (dummy hash) to reduce
  username enumeration via timing.
- Issued JWT includes `pv`: a 12-hex fingerprint of the current password hash
  (`passwordVersion` in `authSecurity.js`).

`verifyUserJWT` rejects tokens whose `pv` no longer matches the stored hash,
so a password reset invalidates every existing session. Tokens issued before
`pv` shipped skip that check and simply expire normally.

```bash
curl -X POST "$API_BASE_URL/api/user/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"couple","password":"...","rememberMe":true}'
```

`GET /api/user/auth/me` returns the user plus owned events (requires Bearer
user JWT).

## Password recovery (in-memory handshake)

Recovery state lives in a process-local `Map` (`accountRecoveryStore`), not
the database. Codes and reset nonces are lost on process restart. Expired
entries are swept every 5 minutes.

| Step | Route | Limits / TTL |
| --- | --- | --- |
| Request code | `POST /api/user/auth/recovery/request` | 6-digit code, 10 min TTL; email always returns the same success message |
| Verify code | `POST /api/user/auth/recovery/verify` | Max 5 wrong guesses then code is burned; returns single-use `resetToken` (15 min, issuer `aamantran:recovery`) |
| Reset password | `POST /api/user/auth/recovery/reset-password` | Requires matching email + nonce in store; deletes store entry after success |

Code hashes are SHA-256; comparisons use `timingSafeEqualStr`. Unknown emails
still return `{ ok: true, message: "If this email exists, a recovery code has been sent." }`
and audit `recovery_requested_unknown_email`.

After a successful reset the API audits `password_reset`, updates
`passwordHash` (bcrypt cost 12), and best-effort sends
`sendPasswordChangedEmail`. All prior user JWTs with `pv` become invalid.

Constraint: multi-instance deployments do not share the recovery Map. The
verify/reset requests must hit the same process that handled the request,
or recovery fails with an invalid/expired session. Sticky sessions or a
shared store would be required to scale this horizontally.

## Password policy

`validateNewPassword` (`src/utils/authSecurity.js`) is used for recovery reset
and onboarding password creation in `src/routes/publicCheckout.js`:

- Length 8..128
- Rejects a single repeated character
- Rejects a small denylist of common passwords (case-insensitive)

## Common pitfalls

- Setting `ADMIN_TOTP_SECRET` without updating the admin UI to collect `otp`
  makes every admin login return `OTP_REQUIRED`.
- Leaving plaintext `ADMIN_PASSWORD` in production logs a warning; prefer
  `ADMIN_PASSWORD_HASH` and remove the plaintext var.
- Rotating only `JWT_SECRET` while `JWT_SECRET_ADMIN` / `JWT_SECRET_USER`
  are unset invalidates all tokens; when audience secrets are set, rotate
  the matching one.
- Recovery codes never leave the instance memory - do not expect them to
  survive deploys or load-balanced hops.
- Wrong password on `DELETE /api/user/me` returns `403` (not `401`) so the
  dashboard does not treat it as session expiry; see DPDP account-erasure docs.
