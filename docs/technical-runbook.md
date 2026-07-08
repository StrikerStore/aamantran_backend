# Technical Runbook

This runbook documents recently changed backend workflows that are easy to
operate incorrectly without source context. It is verified against the current
Express routes, controllers, services, and Prisma schema.

## Checkout, PayU, and onboarding

### Intent

The checkout flow creates a pending `Payment`, sends the buyer to PayU, marks
successful payments as paid, and then lets the buyer register or link a couple
dashboard account. A human-readable `orderId` is generated for purchase emails
and support lookup; business logic still uses the payment UUID and PayU IDs.

### Main codepaths

- Routes: `src/routes/publicCheckout.js`, `src/routes/webhook.js`
- PayU helpers: `src/services/payu.service.js`
- Email helpers: `src/services/email.service.js`,
  `src/services/emailTemplates.js`
- IDs: `src/utils/generateId.js`
- Data: `Payment`, `Template`, `User`, `Event` in `prisma/schema.prisma`

### Public flow

1. `POST /api/checkout/coupon-preview`
   - Body: `templateSlug`, optional `couponCode`, `customerEmail`.
   - Returns a price breakup with base amount, discount, GST, and final amount.
2. `POST /api/checkout/order`
   - Creates a pending `Payment` with:
     - generated `payuTxnId`
     - generated `orderId` in `AO-DDMMYY-HHMMSS-XXXX` format
     - normalized `customerEmail`
     - final amount in paise
   - Returns PayU form params unless `DUMMY_PAYMENT_MODE=true`.
3. `POST /api/checkout/payu-success`
   - Verifies the PayU response hash.
   - Marks the payment paid and stores `payuMihpayid`.
   - Increments `Template.buyerCount`.
   - Sends a purchase confirmation email with `orderId` when available.
   - Redirects to landing onboarding with `paymentId`, template slug/name, and
     `orderId`.
4. `POST /api/checkout/register`
   - Requires a paid payment and matching `templateSlug`.
   - Creates or links a `User`.
   - Creates an `Event` pinned to the template's `currentVersionId`.
   - Marks the payment onboarded.

### PayU IPN

`POST /webhooks/payu` is mounted before JSON body parsing and expects
`application/x-www-form-urlencoded`. It verifies the same reverse hash as the
redirect handlers.

The IPN handler covers:

- direct template purchases by `Payment.payuTxnId`
- template swap balance payments by `TemplateSwapRequest.payuLinkId`

The redirect and IPN handlers can both arrive. Direct purchase handling avoids
double-processing paid payments by checking `payment.status !== 'paid'`.

### Development payment mode

When `DUMMY_PAYMENT_MODE=true`, `POST /api/checkout/order` returns a dummy
response instead of PayU form params. Complete it with:

```http
POST /api/checkout/mock-success
Content-Type: application/json

{ "paymentId": "payment_uuid" }
```

The mock endpoint is blocked in production.

### Operational checks

- Missing PayU credentials: direct checkout still builds params with empty key
  and hash inputs, so staging should use either real test credentials or dummy
  mode.
- Failed redirect/IPN with a `txnid` marks pending direct payments as `failed`.
- Refunds use `Payment.payuMihpayid`; payments without it cannot be refunded by
  `POST /api/v1/transactions/:id/refund`.

## Template versioning and rendering

### Intent

Template drafts are mutable so admins can iterate on uploaded ZIPs and demo
data. Published versions are immutable snapshots so live invitations render
against a stable bundle until an admin explicitly publishes changes.

### Main codepaths

- Admin routes: `src/routes/templates.js`
- Controller: `src/controllers/templates.controller.js`
- File operations: `src/services/fileManager.js`
- Rendering: `src/routes/render.js`, `src/services/templateRenderer.js`
- Backfill: `scripts/backfill-template-versions.js`
- Data: `Template`, `TemplateVersion`, `Event.templateVersionId`

### Lifecycle

1. Create template: `POST /api/v1/templates`
   - Requires `templateZip`, `name`, `community`, `price`, and `aboutText`.
   - Extracts the ZIP into `templates/{slug}/draft/`.
   - Creates an inactive `Template`.
2. Preview demo: `GET /demo/:slug`
   - Always renders the latest draft.
   - Adds the public "Buy now" bar and watermark.
3. First publish: `PATCH /api/v1/templates/:id/publish`
   - If no current version exists, snapshots draft to `v1`.
   - Sets `Template.currentVersionId`.
   - Repoints all events on the template to `v1`.
   - Marks the template active.
4. Re-upload files: `PUT /api/v1/templates/:id/files`
   - Overwrites the draft and optionally thumbnails.
   - Does not affect existing live invitations.
5. Publish changes: `POST /api/v1/templates/:id/publish-changes`
   - Requires an existing current version.
   - Snapshots the draft to `v{n+1}`.
   - Repoints every event on that template to the new version.
   - Clears render cache for affected events.
6. Delete old version: `DELETE /api/v1/templates/:id/versions/:versionId`
   - Refuses to delete the current version.
   - Refuses to delete versions still pinned by invitations.
   - Deletes the storage folder only after path safety checks.

### Rendering behavior

- `GET /i/:slug` requires `Event.isPublished=true` and refuses expired invites.
- Live invites render from `Event.templateVersion` when set.
- Legacy fallback renders from `templates/{template.folderPath}/draft/` if an
  event has no version pin.
- `GET /i/:slug/preview` allows draft preview for unpublished events only with a
  signed preview token.
- All HTML render responses set no-cache headers.

### Backfill runbook

`npm run db:deploy` runs:

```bash
npx prisma migrate deploy && node scripts/backfill-template-versions.js --apply
```

The backfill is idempotent. It only acts on templates without
`currentVersionId`. For each eligible template it:

- re-extracts legacy `templates/{slug}/template.zip` into `v1/` and `draft/`
- creates `TemplateVersion(versionNumber=1)`
- pins events without `templateVersionId`
- removes legacy flat template files while keeping thumbnails and the original
  top-level ZIP

If a legacy template has no stored ZIP, the script reports it as skipped.

## Template swaps

### Intent

Admins can swap a user's invitation to a different template. Same-price or
cheaper swaps happen immediately. More expensive swaps create a pending
`TemplateSwapRequest` and email a PayU balance payment link.

### Main codepaths

- Admin user controller: `src/controllers/users.controller.js`
- PayU link helper: `src/services/payu.service.js`
- PayU completion: `src/routes/publicCheckout.js`, `src/routes/webhook.js`
- Data: `TemplateSwapRequest`, `Event`, `Payment`

### Behavior

- Immediate swaps set both `Event.templateId` and `Event.templateVersionId` to
  the new template's current version, then clear render cache.
- Paid upgrades cancel older pending swaps for the affected event(s), create a
  new request, and send an email.
- Paired swaps update both full and subset invitations when `pairedEventId` is
  present.
- `GET /api/checkout/payu-swap-link/:txnid` renders an auto-submitting PayU
  form for balance payments.
- Successful swap payment:
  - verifies PayU hash
  - pins event(s) to the new template version
  - marks the swap paid
  - creates a paid `Payment` record when appropriate
  - increments buyer count

If PayU keys are not configured, swap emails use
`TEMPLATE_SWAP_PLACEHOLDER_PAY_URL` or a default placeholder URL so local admin
flows do not crash.

## Couple planning tools

### Intent

Planning APIs extend the couple dashboard with event-scoped operational tools:
tasks, inventory, budget, vendors, timeline, mood board, gifts, and a photo
wall.

### Main codepaths

- Routes: `src/routes/userEvents.js`
- Controller: `src/controllers/planning.controller.js`
- Upload middleware: `src/middleware/uploadUserMedia.js`
- Data models from `Task` through `PhotoWallItem` in `prisma/schema.prisma`

### API groups

All routes below are under `/api/user/events/:id` and require user JWT auth.
Each handler first verifies the event belongs to the authenticated user.

| Feature | Routes | Required fields |
| --- | --- | --- |
| Tasks | `GET/POST /tasks`, `PATCH/DELETE /tasks/:tid` | `title` on create |
| Inventory | `GET/POST /inventory`, `PATCH/DELETE /inventory/:iid` | `name` on create |
| Budget | `GET/PUT /budget`, `GET/POST/PATCH/DELETE /budget/expenses` | `totalBudget`; expense `description` and `amount` |
| Vendors | `GET/POST /vendors`, `PATCH/DELETE /vendors/:vid` | `name` on create |
| Timeline | `GET/POST /timeline`, `PATCH/DELETE /timeline/:eid` | `time` and `title` on create |
| Mood board | `GET/POST /moodboard`, `DELETE /moodboard/:mid` | image file or `imageUrl` |
| Pinterest oEmbed | `GET /pinterest-oembed?url=...` | HTTPS Pinterest URL |
| Gifts | `GET/POST /gifts`, `PATCH/DELETE /gifts/:gid` | `fromName` on create |
| Photo wall | `GET/POST /photos`, `DELETE /photos/:pid` | image file |

### Constraints and examples

- Date-like values are stored as strings (`YYYY-MM-DD`) for planner features.
- Decimal costs are parsed with `parseFloat` and stored as Prisma decimals.
- Mood board supports either multipart upload (`file`) or JSON/form body
  `imageUrl`.
- Pinterest oEmbed accepts only `pin.it`, `pinterest.com`,
  `www.pinterest.com`, or subdomains ending in `.pinterest.com`; failures
  return `{ ok: true, embedUnavailable: true }` instead of failing the page.

Example mood board upload:

```http
POST /api/user/events/event_uuid/moodboard
Authorization: Bearer user_jwt
Content-Type: multipart/form-data

file=<image>, caption="Mandap inspiration", category="Decor"
```

## Reviews and public ratings

### Intent

Admins can curate landing-page reviews and hide/show them without deleting
history. Public template and featured review endpoints expose only non-hidden
reviews.

### Main codepaths

- Admin routes: `src/routes/adminReviews.js`
- Public routes: `src/routes/publicTemplates.js`
- Data: `TemplateReview`, `Template.avgRating`

### Admin behavior

- `GET /api/v1/reviews` lists reviews with optional `templateId` and `hidden`
  filters plus pagination.
- `POST /api/v1/reviews` creates an admin review. It accepts multipart
  `couplePhoto` plus `templateId`, `rating`, `reviewText`, `coupleNames`, and
  `location`.
- `PATCH /api/v1/reviews/:id/hide` and `/show` toggle visibility.
- `DELETE /api/v1/reviews/:id` deletes the row.
- Hide/show/delete recalculate `Template.avgRating` from non-hidden reviews.

### Public behavior

- `GET /api/reviews/featured` returns recent non-hidden reviews with review text
  and platform-wide non-hidden aggregate rating/count.
- `GET /api/templates/:slug/reviews` returns non-hidden reviews and aggregate
  rating/count for one template.
- `GET /api/templates/:slug` includes `avgRating` and non-hidden `reviewCount`.

### Constraint

Admin review photo upload writes `couplePhotoUrl` only when object storage is
enabled. In local disk mode the upload is accepted, but no local public review
photo URL is assigned.

## Environment checklist

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Prisma | MySQL connection string. |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Admin/user auth | Use a strong secret outside local dev. |
| `API_BASE_URL`, `LANDING_URL`, `ADMIN_URL`, `COUPLE_DASHBOARD_URL` | URLs, CORS, email links | Defaults exist for dev and production. |
| `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_ENV` | PayU checkout/refunds/swaps | `PAYU_ENV=test` uses PayU test endpoint; otherwise production. |
| `DUMMY_PAYMENT_MODE` | Checkout | Use only outside production. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Email | Missing SMTP settings make email sends throw. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` | Storage | All must be present to enable R2 mode. |
| `TEMPLATE_SWAP_PLACEHOLDER_PAY_URL` | Swap emails | Optional placeholder when PayU keys are absent. |
| `RATE_LIMIT_*` | Rate limits | See `src/middleware/rateLimits.js`. |
| `TRUST_PROXY` | Express app | Set `TRUST_PROXY=0` only when not behind a proxy. |
