/**
 * The monthly GST report, in the layout the accountant already reads.
 *
 * The file this reproduces is a Shopify order export from another store the
 * same company runs: 81 columns, two sheets named `revenue` and `refund`,
 * `DD-MM-YYYY` dates, and `Total Revenue` / `Total Tax` appended past Shopify's
 * own columns. Matching it exactly is the point — it means nothing downstream
 * has to change. About 53 of the 81 columns have no Aamantran equivalent
 * (shipping, SKUs, billing addresses); those are deliberately blank rather than
 * dropped, so the header row stays byte-identical.
 *
 * Money conventions, taken from the sample and NOT invented here:
 *   - `Subtotal` = `Total` = `Total Revenue` = the gross, tax-inclusive figure.
 *     `Taxes` is the portion INCLUDED in it. The taxable value is therefore
 *     `Subtotal - Taxes`, which is how the accountant already derives it.
 *   - The refund sheet keeps every figure POSITIVE.
 *
 * Aamantran stores `Payment.amount` GST-inclusive (pricing.service.js
 * computeBreakup: finalAmount = taxableAmount + gstAmount), so the gross is
 * `amount` and the taxable value is `amount - gstAmount` exactly, with no
 * rounding loss.
 */
const prisma = require('../utils/prisma');
const { EXCLUDE_TEST_OWNER } = require('../utils/testFilters');
const { buildXlsx } = require('../utils/xlsx');
const { istRangeUtc, formatIstDate, isWholeMonth } = require('../utils/istDate');

/** The operating company, as the accountant's filename has it. */
const BRAND = process.env.GST_REPORT_BRAND || 'Plexzuu';
/** Goes in the `Vendor` column: the name registered on the GSTIN. */
const VENDOR = process.env.GST_REPORT_VENDOR || 'Aamantran';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A GST return is not a convenience export: a silently-short one is the worst
 * thing this can produce, so going over the cap is refused rather than
 * truncated (unlike the transactions CSV, which caps at 5,000 on purpose).
 */
const GST_MAX_ROWS = 10000;
const GST_MAX_DAYS = 366;

/**
 * The 81 headers, in order, exactly as the sample file has them.
 *
 * Do not reorder, rename or "tidy" these. They are an external interface.
 */
const GST_HEADERS = Object.freeze([
  'Name', 'Email', 'Financial Status', 'Paid at', 'Fulfillment Status', 'Fulfilled at',
  'Accepts Marketing', 'Currency', 'Subtotal', 'Shipping', 'Taxes', 'Total',
  'Discount Code', 'Discount Amount', 'Shipping Method', 'Created at',
  'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem compare at price',
  'Lineitem sku', 'Lineitem requires shipping', 'Lineitem taxable',
  'Lineitem fulfillment status', 'Billing Name', 'Billing Street', 'Billing Address1',
  'Billing Address2', 'Billing Company', 'Billing City', 'Billing Zip', 'Billing Province',
  'Billing Country', 'Billing Phone', 'Shipping Name', 'Shipping Street',
  'Shipping Address1', 'Shipping Address2', 'Shipping Company', 'Shipping City',
  'Shipping Zip', 'Shipping Province', 'Shipping Country', 'Shipping Phone', 'Notes',
  'Note Attributes', 'Cancelled at', 'Payment Method', 'Payment Reference',
  'Refunded Amount', 'Vendor', 'Outstanding Balance', 'Employee', 'Location', 'Device ID',
  'Id', 'Tags', 'Risk Level', 'Source', 'Lineitem discount', 'Tax 1 Name', 'Tax 1 Value',
  'Tax 2 Name', 'Tax 2 Value', 'Tax 3 Name', 'Tax 3 Value', 'Tax 4 Name', 'Tax 4 Value',
  'Tax 5 Name', 'Tax 5 Value', 'Phone', 'Receipt Number', 'Duties',
  'Billing Province Name', 'Shipping Province Name', 'Payment ID', 'Payment Terms Name',
  'Next Payment Due At', 'Payment References', 'Total Revenue', 'Total Tax',
]);

if (GST_HEADERS.length !== 81) {
  throw new Error(`gstReport: expected 81 headers, found ${GST_HEADERS.length}`);
}

/** Minor units → a 2-decimal number, the way a spreadsheet wants it. */
function money(minor) {
  return Math.round(Number(minor) || 0) / 100;
}

/**
 * What tax this row carries, and what to call it.
 *
 * The amount is what was charged (`gstAmount`); the rate is the invite's own
 * (`template.gstPercent`). Where those two disagree the charged amount always
 * wins and the row says why, rather than being quietly reconciled.
 *
 * The split is always IGST. The supplier is registered in MP and no buyer state
 * is recorded anywhere, so place of supply cannot be determined per order — a
 * buyer who is themselves in MP is an intra-state supply whose tax should be
 * CGST + SGST, and this file reports it as IGST. The total is right either way;
 * only its division between heads is not. Collecting State at checkout is the
 * fix, and is a separate piece of work.
 */
function taxFor(payment) {
  const gross = Math.round(Number(payment.amount) || 0);
  const stored = Math.round(Number(payment.gstAmount) || 0);
  const templatePct = Number(payment.template?.gstPercent || 0);

  if (stored > 0) {
    const taxable = gross - stored;
    const chargedPct = taxable > 0 ? (stored / taxable) * 100 : 0;
    const rounded = Math.abs(chargedPct - Math.round(chargedPct)) < 0.05
      ? Math.round(chargedPct)
      : Number(chargedPct.toFixed(2));
    // The template's rate is not snapshotted per order, so an edit since the
    // sale makes the two disagree. Label it with what was actually charged.
    const mismatched = templatePct > 0 && Math.abs(rounded - templatePct) >= 0.01;
    return {
      gst: stored,
      percent: rounded,
      note: mismatched
        ? `Rate charged ${rounded}% differs from the invite's current ${templatePct}%`
        : null,
    };
  }

  // No tax was stored. Swap and upgrade payments are created with only an
  // amount, and rows predating the international-pricing migration never had
  // the split persisted at all — but the money reached the bank either way, and
  // omitting it would be a worse error than a marked estimate. Back the tax out
  // of the inclusive total at the invite's rate.
  if (templatePct > 0 && gross > 0) {
    const taxable = Math.round((gross * 100) / (100 + templatePct));
    return {
      gst: gross - taxable,
      percent: templatePct,
      derived: true,
      note: 'GST derived from inclusive total — not recorded at checkout',
    };
  }

  return { gst: 0, percent: null, note: null };
}

/**
 * One payment → 81 cells.
 *
 * `sheet` is 'revenue' or 'refund'; it changes only the status column, the
 * refunded amount and the undated-refund note.
 */
function mapPaymentToRow(payment, sheet) {
  const tax = taxFor(payment);
  const gross = Math.round(Number(payment.amount) || 0);
  const discount = Math.round(Number(payment.discountAmount) || 0);
  const reference =
    payment.gatewayPaymentId || payment.payuMihpayid ||
    payment.gatewayOrderId || payment.payuTxnId || null;
  // Swap payments created by the webhook have no orderId at all.
  const name = payment.orderId || reference || payment.id;
  const refunded = payment.status === 'refunded';
  const refundAmount = Math.round(Number(payment.refundAmount) || 0) || gross;

  const notes = [];
  if (tax.note) notes.push(tax.note);
  if (sheet === 'refund' && !payment.refundedAt) {
    notes.push('Refund date not recorded — shown under the order date');
  }

  const row = new Array(81).fill(null);
  row[0] = name;                                                    // Name
  row[1] = payment.customerEmail || payment.user?.email || null;    // Email
  row[2] = refunded ? 'refunded' : 'paid';                          // Financial Status
  row[3] = formatIstDate(payment.createdAt);                        // Paid at
  row[6] = payment.marketingOptIn ? 'yes' : 'no';                   // Accepts Marketing
  row[7] = payment.currency || 'INR';                               // Currency
  row[8] = money(gross);                                            // Subtotal (gross)
  row[9] = 0;                                                       // Shipping
  row[10] = money(tax.gst);                                         // Taxes
  row[11] = money(gross);                                           // Total
  row[12] = payment.couponCode || null;                             // Discount Code
  row[13] = money(discount);                                        // Discount Amount
  row[15] = formatIstDate(payment.createdAt);                       // Created at
  row[16] = 1;                                                      // Lineitem quantity
  row[17] = payment.template?.name || null;                         // Lineitem name
  // The invite's list price: before the coupon and before GST.
  row[18] = money(gross - tax.gst + discount);                      // Lineitem price
  row[20] = payment.template?.slug || null;                         // Lineitem sku
  row[21] = 'false';                                                // requires shipping
  row[22] = 'true';                                                 // Lineitem taxable
  // An unexpected country is shown raw rather than papered over as India.
  row[32] = !payment.countryCode || payment.countryCode === 'IN'
    ? 'India'
    : payment.countryCode;                                          // Billing Country
  row[44] = notes.length ? notes.join('; ') : null;                 // Notes
  row[47] = payment.gateway === 'razorpay' ? 'Razorpay' : 'PayU';   // Payment Method
  row[48] = reference;                                              // Payment Reference
  row[49] = sheet === 'refund' || refunded ? money(refundAmount) : 0; // Refunded Amount
  row[50] = VENDOR;                                                 // Vendor
  row[51] = 0;                                                      // Outstanding Balance
  row[55] = payment.id;                                             // Id
  row[58] = 'web';                                                  // Source
  row[59] = money(discount);                                        // Lineitem discount
  row[60] = tax.percent == null                                     // Tax 1 Name
    ? null
    : `IGST ${tax.percent}%${tax.derived ? ' (derived)' : ''}`;
  row[61] = money(tax.gst);                                         // Tax 1 Value
  // Phone as text, or a leading + and the country code are lost to a number.
  row[70] = payment.user?.phone
    ? `${payment.user.phoneCountryCode || '+91'}${payment.user.phone}`
    : null;                                                         // Phone
  row[75] = reference;                                              // Payment ID
  row[78] = reference;                                              // Payment References
  row[79] = money(gross);                                           // Total Revenue
  row[80] = money(tax.gst);                                         // Total Tax

  if (row.length !== 81) {
    throw new Error(`gstReport: row has ${row.length} cells, expected 81`);
  }
  return row;
}

/** `Plexzuu_GST_Data_Aug2026.xlsx` for a whole month, a spelt-out range otherwise. */
function gstReportFilename(fromYmd, toYmd) {
  const [fy, fm, fd] = String(fromYmd).split('-').map(Number);
  const [ty, tm, td] = String(toYmd).split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const suffix = isWholeMonth(fromYmd, toYmd)
    ? `${MONTHS[fm - 1]}${fy}`
    : `${pad(fd)}${MONTHS[fm - 1]}${fy}_to_${pad(td)}${MONTHS[tm - 1]}${ty}`;
  return `${BRAND}_GST_Data_${suffix}.xlsx`;
}

/** Only the columns the report reads — never `include`, which would pull whole rows. */
const REPORT_SELECT = {
  id: true, orderId: true, status: true, createdAt: true,
  amount: true, gstAmount: true, discountAmount: true, currency: true,
  couponCode: true, customerEmail: true, countryCode: true, marketingOptIn: true,
  gateway: true, gatewayOrderId: true, gatewayPaymentId: true,
  payuTxnId: true, payuMihpayid: true,
  refundedAt: true, refundAmount: true,
  user: { select: { email: true, phone: true, phoneCountryCode: true } },
  template: { select: { name: true, slug: true, gstPercent: true } },
};

/**
 * India orders only, in INR, excluding the master test account.
 *
 * Deliberately built from scratch rather than through `listWhere`: the GST
 * report must not inherit whatever the admin left selected in the table, or an
 * abandoned "gateway = razorpay" filter would file a partial return.
 */
function baseWhere() {
  return { ...EXCLUDE_TEST_OWNER, storefront: 'IN', currency: 'INR' };
}

/**
 * The revenue sheet: everything SOLD in the period.
 *
 * `refunded` rows are included. A sale belongs to the month it was made in even
 * after a later refund — that is both the correct GST treatment and what stops
 * an already-filed month being silently restated when a refund is issued. The
 * credit note goes on the refund sheet, in the month the refund happened.
 */
function revenueWhere(range) {
  return { ...baseWhere(), status: { in: ['paid', 'refunded'] }, createdAt: range };
}

/**
 * The refund sheet: refunds MADE in the period.
 *
 * Refunds recorded before the refund-audit migration have no date. Rather than
 * dropping them, they fall back to the order date and the row says so.
 */
function refundWhere(range) {
  return {
    ...baseWhere(),
    status: 'refunded',
    OR: [{ refundedAt: range }, { AND: [{ refundedAt: null }, { createdAt: range }] }],
  };
}

/** How many rows the file would have, so the cap is checked before building it. */
async function countRows(fromYmd, toYmd) {
  const range = istRangeUtc(fromYmd, toYmd);
  if (!range) return null;
  const [revenue, refund] = await Promise.all([
    prisma.payment.count({ where: revenueWhere(range) }),
    prisma.payment.count({ where: refundWhere(range) }),
  ]);
  return { revenue, refund, total: revenue + refund };
}

/** The whole file as a Buffer, plus its name and what went into it. */
async function buildGstReport(fromYmd, toYmd) {
  const range = istRangeUtc(fromYmd, toYmd);
  if (!range) throw new Error('gstReport: invalid date range');

  const [revenue, refund] = await Promise.all([
    prisma.payment.findMany({ where: revenueWhere(range), select: REPORT_SELECT, orderBy: { createdAt: 'asc' } }),
    prisma.payment.findMany({ where: refundWhere(range), select: REPORT_SELECT, orderBy: { createdAt: 'asc' } }),
  ]);

  const header = [...GST_HEADERS];
  const sheets = [
    { name: 'revenue', rows: [header, ...revenue.map((p) => mapPaymentToRow(p, 'revenue'))] },
    { name: 'refund', rows: [header, ...refund.map((p) => mapPaymentToRow(p, 'refund'))] },
  ];

  // Surface the estimates in the logs, not only in a file nobody reads.
  const derived = revenue.filter((p) => taxFor(p).derived).length;
  if (derived > 0) {
    console.warn(
      '[gst-report] %d of %d revenue rows had no stored GST; derived from the inclusive total',
      derived, revenue.length,
    );
  }

  return {
    buffer: buildXlsx(sheets, { columnCount: 81 }),
    filename: gstReportFilename(fromYmd, toYmd),
    counts: { revenue: revenue.length, refund: refund.length, derived },
  };
}

module.exports = {
  GST_HEADERS,
  GST_MAX_ROWS,
  GST_MAX_DAYS,
  taxFor,
  mapPaymentToRow,
  gstReportFilename,
  countRows,
  buildGstReport,
};
