# Template swaps

Admin-only change of the design on an invitation the couple already has.
All three routes use the admin JWT (`src/routes/users.js`). List prices are
`Template.price` in paise. The balance is `newPrice - oldPrice` in paise,
not the amount the customer originally paid.

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/v1/users/:id/swap-template` | `{ eventId, newTemplateId }` |
| POST | `/api/v1/users/:id/swap-paired-template` | `{ invitePairId, newTemplateId }` |
| PATCH | `/api/v1/users/:id/change-template` | `{ eventId, newTemplateId }` |

`change-template` is not a swap. It is a forced switch: the event is
unpublished, every custom field and media row is deleted, and people,
functions, venues, language, links, and the RSVP and guest-note flags are
left as they were. The response `cleared` object reports the render cache
as cleared. No charge, no `TemplateSwapRequest`. It updates
only that event, not the paired invite.

## Price check

`balance <= 0` (same price or a cheaper design) swaps immediately. The event's
`templateId` and `templateVersionId` become the new template and its
`currentVersionId` (null when the design has never been published). Status in
the JSON is `swapped`. The paired route writes both rows in one transaction,
and only when both exist, the user owns them, and both already use the same
`templateId`. Different designs on the two rows is 400. A missing pair is 404.

A positive balance is refused with 409 when this user has any `Payment` with
`status: paid` and `storefront: INTL` (`blockPaidUpgradeForIntlBuyer`). The
check is not "this event was bought on the global site". One international
paid order blocks later paid upgrades for that user. The message names the
currency stored on the row it found, or `USD` when that column is empty.
Downgrades are not blocked. The balance is the INR list-price gap either way,
so the refusal exists to avoid charging that gap in rupees to someone who
paid a derived dollar price.

## Paying the gap

The India PayU account is the only one used. `createPaymentLinkOrPlaceholder`
defaults `storefront` to `IN`. International keys are not consulted.

When `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT` are both set, the email link
is `{API_BASE_URL}/api/checkout/payu-swap-link/{txnid}`. `txnid` is a UUID
with the dashes removed, cut to 25 characters. That same string is stored on
`TemplateSwapRequest.payuLinkId`. `payuLinkUrl` is the email link. The GET
route returns a short HTML 404 when the request is not `pending`. Otherwise
it builds a PayU form for the India account and posts it. Amount on the
form is paise divided by 100.

When the India key or salt is missing, no PayU form is built. `payuLinkId`
is `placeholder_` plus the current time, and the email link is
`TEMPLATE_SWAP_PLACEHOLDER_PAY_URL` or, if that is unset,
`https://aamantran.online/configure-payu`. The JSON flag is
`usedPlaceholderLink: true`. The placeholder id will never match a PayU
`txnid`, so the request stays `pending`.

Older `pending` rows are marked `cancelled` only on this paid branch, and
only then is the new row inserted. The single-invite route cancels pending
rows for that `eventId`. The paired route cancels pending rows whose
`eventId` is the full invite or the partial invite (a paired request is
stored with `eventId` = full and `pairedEventId` = partial, so it matches).
The free branch returns before that cancel. A customer who still has an
older payment link can pay it later and move the invite to that older
target design.

The email shows the balance in rupees (paise / 100) and says the design
changes after payment. It is the one money email that always uses INR.

`TemplateSwapRequest.balanceAmount` is paise. `status` is `pending`, `paid`,
or `cancelled`.

## After PayU says success

Two handlers apply a `pending` row whose `payuLinkId` equals the PayU
`txnid`. Neither takes a lock. `Payment.payuTxnId` is not unique.

| | Browser redirect | PayU IPN |
| --- | --- | --- |
| Route | `POST /api/checkout/payu-swap-success` | `POST /webhooks/payu` |
| Hash | India salt only | Salt of an existing `Payment` with that `txnid`, otherwise the India salt. A swap has no payment row yet, so the first IPN uses India. |
| Template write | `templateId` + current `currentVersionId` on `eventId`, and on `pairedEventId` when set | Same |
| Request | `status: paid` | `status: paid` |
| Payment row | Inserted when `mihpayid` is present. No lookup for an existing row. Sets `orderId`. | Inserted only when `mihpayid` is present and no `Payment` has that `payuTxnId`. `orderId` is left null. |
| `buyerCount` | Incremented on the destination template whenever the handler still saw `pending`, including when `mihpayid` was missing and no payment row was written | Incremented only in the branch that inserts a payment |

Both inserts set `gateway` `payu`, `amount` to `balanceAmount`, `eventId` to
the primary event only, and `templateId` to the new design. `currency` and
`storefront` stay the defaults `INR` and `IN`. `customerEmail` and
`gstAmount` are not set (`gstAmount` defaults to 0). The GST report names a
row from `orderId`, then a gateway id, then the payment id
(`src/services/gstReport.service.js`), which is why an IPN-created swap
payment has no `AO-...` order id.

If the redirect and the IPN overlap, both can pass the `pending` read before
either marks the row paid. The template write is the same either way. The
payment insert and `buyerCount` are not: the redirect always inserts when
`mihpayid` is set, and it always increments. The result can be two `Payment`
rows and `buyerCount` increased by two. If one handler finishes the status
update first, the other sees no `pending` row. The redirect then sends the
couple to `?payment=already_processed` and does not insert or increment.

`POST /api/checkout/payu-swap-failure` does not read the body and does not
change the request. The link still works. A non-success IPN updates a
`Payment` when one exists and leaves the swap `pending`.

Neither success path deletes `EventRenderCache`. The free swap does. Nothing
reads that table (`docs/invite-render-cache.md`).

The redirect sends the browser to `COUPLE_DASHBOARD_URL`. Failed hash, a
non-success `status`, and a thrown error use `?payment=failed` with
`reason=invalid_signature`, the PayU status, or `server_error`.
