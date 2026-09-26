# India GST report

Monthly workbook for the accountant, in the same 81-column Shopify
export layout another store already files. Matching that file is the
point: downstream sheets keep working. About 53 columns have no
Aamantran equivalent. They stay blank so the header row stays in the
same order with the same names.

Built by `src/services/gstReport.service.js`, served from
`GET /api/v1/transactions/gst-report`. Dates are India Standard Time
(`src/utils/istDate.js`). The file is `.xlsx` with two sheets,
`revenue` and `refund`.

## Endpoint

Admin JWT, same router as the transactions list
(`/api/v1/transactions`, mounted in `src/routes/transactions.js`).
`/gst-report` is registered before `/:id`.

```
GET /api/v1/transactions/gst-report?from=2026-08-01&to=2026-08-31
```

| Check | Result |
| --- | --- |
| `from` or `to` not `YYYY-MM-DD`, or not a real date | **400** |
| `from` after `to` | **400** |
| Inclusive length over 366 days (`GST_MAX_DAYS`) | **400** |
| India rows in the file would exceed 10,000 (`GST_MAX_ROWS`) | **413**, file not built |

The row cap is checked with two counts before any spreadsheet is
built. A short GST file is worse than a refused one, so this endpoint
does not truncate. The transactions CSV caps at 5,000 on purpose.
This report does not share that behaviour.

Response headers:

```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="Plexzuu_GST_Data_Aug2026.xlsx"
Cache-Control: no-store
```

A whole calendar month uses `Brand_GST_Data_MonYYYY.xlsx`. Any other
inclusive range spells both ends:
`Brand_GST_Data_01Aug2026_to_15Aug2026.xlsx`.

## Which orders are in the file

Fixed query, built in `baseWhere()`. It ignores the filters the admin
left on the transactions table (`q`, gateway, status, and the rest).
An abandoned `gateway=razorpay` filter must not file a partial return.

Included:

- `storefront` `IN` and `currency` `INR` only. International and USD
  orders are export sales and are left out.
- Master test-account orders are excluded (`EXCLUDE_TEST_OWNER`).
  A checkout that has no user yet stays in. The test-account filter
  matches a related user with `isTestAccount: true`.
- Revenue sheet: `status` in `paid` or `refunded`, and `createdAt`
  inside the period. A later refund does not remove the sale from the
  month it was made. That month is not restated.
- Refund sheet: `status` `refunded`, and `refundedAt` inside the
  period. Rows refunded before migration
  `20260920000000_refund_audit` have `refundedAt` null. Those use
  `createdAt` in the same period, and the Notes cell says the refund
  date was not recorded and the row is shown under the order date.

The range is half-open IST. `from=2026-08-01` starts at
`2026-07-31T18:30:00.000Z` (00:00 IST) and runs up to, but not
including, 00:00 IST on the day after `to`. `2026-02-31` is rejected
because it rolls forward.

The transactions list and CSV use UTC day bounds (`dayBound` in
`src/controllers/transactions.controller.js`). An order at 01:00 IST
on the 1st sits in the previous UTC day. It can show up in the
previous day's CSV filter and in the current month's GST file. File
from the GST download, not from a CSV of the same dates.

Deploy `20260920000000_refund_audit` before the code that writes
`refundedAt`. The migration adds nullable `refundedAt`,
`refundAmount`, and `refundReference`. It does not invent dates for
old refunds.

## Money columns

`Payment.amount` is GST-inclusive minor units (paise). The sheet
shows major units, two decimals (`amount / 100`).

For a normal row, `Subtotal`, `Total`, and `Total Revenue` are all
the gross inclusive figure. `Taxes` and `Total Tax` are the GST
portion included in that gross. Taxable value is `Subtotal - Taxes`.
`Shipping` is `0`. `Lineitem quantity` is `1`.

`Lineitem price` is the invite list price before the coupon and
before GST: gross minus stored GST plus `discountAmount`.

`Discount Amount` and `Lineitem discount` are the coupon, in rupees.
`Discount Code` is `couponCode`.

`Payment Method` is `Razorpay` when `gateway` is `razorpay`, and
`PayU` otherwise (including older rows whose gateway defaulted to
`payu`). `Payment Reference`, `Payment ID`, and `Payment References`
prefer `gatewayPaymentId`, then `payuMihpayid`, then `gatewayOrderId`,
then `payuTxnId`.

`Name` is `orderId`, then that same reference, then the payment id.
Swap payments created by the webhook can have no `orderId`.

`Financial Status` is `paid` or `refunded`. On the refund sheet, and
on a refunded revenue row, `Refunded Amount` is `refundAmount` or,
when that is missing, the full gross. Figures on the refund sheet
stay positive.

`Currency` is the row's currency (India rows are `INR`). `Vendor` is
`GST_REPORT_VENDOR` (default `Aamantran`). `Source` is `web`.
`Accepts Marketing` is `yes` or `no` from `marketingOptIn`.
`Billing Country` is `India` when `countryCode` is empty or `IN`.
Any other code is written as stored.

`Phone` is text: country code (default `+91`) plus the user's phone.
A numeric cell would drop a leading `+`. Guest checkouts with no user
leave it blank. Email is `customerEmail`, then the user's email.

`Paid at` and `Created at` are `DD-MM-YYYY` in IST.

## Tax label

The charged amount wins. The template's current `gstPercent` is only
a label, because it is not snapshotted on the order.

| Stored `gstAmount` | Tax 1 Name | Notes |
| --- | --- | --- |
| Greater than 0 | `IGST {charged}%` | If that rate differs from the template's current percent by 0.01 or more, Notes says the two rates |
| 0, and the template has a percent | `IGST {template}% (derived)` | GST is backed out of the inclusive total. Notes says it was derived and was not recorded at checkout |
| 0, and the template percent is 0 | blank, tax 0 | No note |

Derived rows are also counted in the server log:
`[gst-report] N of M revenue rows had no stored GST`. Swap and upgrade
payments, and rows from before the tax split was stored, land here.
The bank total is still reported. The split is an estimate.

The split is always IGST. The supplier is registered in MP, and
checkout does not record the buyer's state, so place of supply cannot
be decided per order. A buyer in MP is an intra-state supply (CGST
plus SGST). This file still reports IGST. The total tax is the amount
charged. Only the head it is filed under is unresolved until state is
collected at checkout.

`Id` is the payment's primary key. `Lineitem name` is the template
name. `Lineitem sku` is the template slug. `Lineitem requires
shipping` is `false`. `Lineitem taxable` is `true`.

Header order is `GST_HEADERS` in `gstReport.service.js`. The module
throws at load if that list is not 81 names, and again if a row is
not 81 cells. Do not reorder, rename, or drop a blank column.

## Labels

Optional. Defaults match the accountant's existing filename and vendor
column.

```
GST_REPORT_BRAND="Plexzuu"     # filename prefix
GST_REPORT_VENDOR="Aamantran"  # Vendor column, the GSTIN name
```

## Filing checklist

1. Refunds issued in the period have `refundedAt` (admin refund path
   sets it). A refund done only by flipping `status` will be missing
   from the refund sheet unless its order date also falls in the range,
   in which case the Notes cell says the date was not recorded.
2. Download a whole month (`from` the 1st, `to` the last day) so the
   filename is `MonYYYY`.
3. If the call returns 413, split the range. One month is the intended
   size. Do not raise the cap to force a truncated file through.
4. Treat any Notes value that starts with `GST derived` or
   `Rate charged` as a row to review before filing. The gross is still
   the amount stored on the payment.
