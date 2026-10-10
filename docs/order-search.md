# Order search

Admin list of payments. JWT with issuer `aamantran:admin` and `role: admin`
(`src/middleware/auth.js`). Mounted at `/api/v1/transactions`.

| Method | Path | Role |
| --- | --- | --- |
| GET | `/api/v1/transactions` | Filtered page, plus totals for that same filter |
| GET | `/api/v1/transactions/export` | The same filter as CSV |
| GET | `/api/v1/transactions/:id` | One payment |
| POST | `/api/v1/transactions/:id/refund` | Refund through the gateway on the row |

`GET /gst-report` is registered beside these and does not use this filter.
Its dates are IST, and it refuses an oversized range. This list does neither.
See `src/services/gstReport.service.js`.

Code: `listWhere` and `totalsFor` in `src/controllers/transactions.controller.js`.
The list, the totals, and the CSV all call `listWhere`, so an export cannot
cover a different set of orders than the table it came from.

## Search

`q` is trimmed and cut to 120 characters. A non-empty value matches if any
of these `contains` the string:

- `orderId` (the id in the customer email)
- `customerEmail`
- `gatewayOrderId`
- `gatewayPaymentId`
- `payuTxnId`
- `couponCode`
- the account email
- the account username
- the invitation `slug`

`payuMihpayid` is not its own clause. PayU writes that id into
`gatewayPaymentId` as well, and the search hits that column.
`Payment.id`, template name, person names, phone, and amount are not
searched. Matching is a substring, not a token, and case follows the MySQL
collation. There is no separate query syntax.

## Other filters

An unknown value is dropped, which shows every row for that dimension
rather than an empty table.

| Query | Accepted | Bound |
| --- | --- | --- |
| `status` | `pending`, `paid`, `failed`, `refunded` | exact |
| `gateway` | `payu`, `razorpay` | exact |
| `storefront` | `IN`, `INTL` | exact |
| `currency` | `INR`, `USD` | exact |
| `from`, `to` | `YYYY-MM-DD` | UTC day, inclusive |

`from` is `00:00:00.000Z` and `to` is `23:59:59.999Z`. A value that is not
that shape, including a rolled date, is ignored. A `from` after `to` is not
swapped; the range matches nothing. This is not the IST window the analytics
screens and the GST report use. An order placed between 00:00 and 05:30 IST
falls on the previous UTC date. `src/utils/istDate.js` calls that out on
purpose: this table is for finding an order, not for filing a month.

Payments owned by a test account are excluded. A payment whose user was
deleted (`userId` null) is kept (`EXCLUDE_TEST_OWNER`).

## Page and totals

Default page 1, default limit 20, limit clamped to 1..100. Order is
`createdAt` descending.

`totals` is one object per currency. `Payment.amount` is minor units of
that row's currency, so the API never adds rupees to dollars. For each
currency:

| Field | Meaning |
| --- | --- |
| `orders` | Every status in the filter |
| `paidAmount`, `paidOrders` | Current `status` is `paid` |
| `refundedAmount`, `refundedOrders` | Current `status` is `refunded` |

Refunds are not subtracted from `paidAmount`. Pending and failed rows count
in `orders` only. A payment that is later refunded leaves the paid totals.

`data[]` includes the user (`id`, `username`, `email`), the template
(`id`, `name`), and the event (`id`, `slug`, `person1Name`, `person2Name`).

## CSV

`GET /api/v1/transactions/export` takes at most 5000 rows
(`EXPORT_MAX_ROWS`), newest first. It does not 400 when the filter matches
more. The file can be short of the list's `total`. The GST report refuses
instead of truncating; this export does not.

The body is UTF-8 with a leading BOM so Excel does not read names as
Windows-1252. Rows are CRLF. Cells are quoted. A cell that starts with
`=`, `+`, `-`, `@`, a tab, or a carriage return is prefixed with a single
quote so a customer string is not a formula.

Amount columns: minor units, then major units to two decimals (`amount / 100`),
plus GST and discount the same way. The filename is
`aamantran-transactions-YYYY-MM-DD.csv` using the UTC date of the request.
