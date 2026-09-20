/**
 * Dates as India reads them.
 *
 * A GST period is an IST period. `dayBound` in transactions.controller.js builds
 * UTC day boundaries, which is right for the admin table — an admin filtering
 * "last week" is not filing anything — but wrong here: every order placed
 * between 00:00 and 05:30 IST on the 1st of a month falls in the previous UTC
 * day, and would be filed in the wrong month.
 *
 * IST is a fixed UTC+5:30 with no daylight saving, ever, so this is plain
 * arithmetic rather than `Intl` or `toLocaleString`. That is deliberate: those
 * depend on the ICU data compiled into the running Node, which differs between
 * a developer's machine and the host, and they cannot be unit-tested without
 * pinning the process timezone.
 */

const IST_OFFSET_MS = 330 * 60 * 1000; // +05:30
const DAY_MS = 24 * 60 * 60 * 1000;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 'YYYY-MM-DD' → the UTC instant of 00:00:00.000 IST on that day.
 * 2026-08-01 → 2026-07-31T18:30:00.000Z. Null on anything malformed.
 */
function istDayStartUtc(ymd) {
  const value = String(ymd || '').trim();
  if (!YMD.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms - IST_OFFSET_MS);
  // Date.parse accepts 2026-02-31 and rolls it forward; reject that.
  return formatIstDate(date) === toDdMmYyyy(value) ? date : null;
}

/**
 * An inclusive IST date range → a half-open UTC range, `{ gte, lt }`.
 *
 * Half-open rather than `lte 23:59:59.999`: correct whatever the column's
 * precision is, and there is no last-millisecond to argue about.
 */
function istRangeUtc(fromYmd, toYmd) {
  const gte = istDayStartUtc(fromYmd);
  const end = istDayStartUtc(toYmd);
  if (!gte || !end) return null;
  if (end.getTime() < gte.getTime()) return null;
  return { gte, lt: new Date(end.getTime() + DAY_MS) };
}

/** A Date → 'DD-MM-YYYY' as it reads in IST. The format the report uses. */
function formatIstDate(date) {
  if (!date) return '';
  const t = new Date(date.getTime() + IST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(t.getUTCDate())}-${pad(t.getUTCMonth() + 1)}-${t.getUTCFullYear()}`;
}

/** 'YYYY-MM-DD' → 'DD-MM-YYYY', with no timezone in it at all. */
function toDdMmYyyy(ymd) {
  const [y, m, d] = String(ymd).split('-');
  return `${d}-${m}-${y}`;
}

/** Whole days between two 'YYYY-MM-DD's, inclusive of both ends. */
function daysBetween(fromYmd, toYmd) {
  const from = istDayStartUtc(fromYmd);
  const to = istDayStartUtc(toYmd);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

/**
 * Does this inclusive range cover exactly one whole calendar month?
 * Leap years come out right because day 0 of month m+1 is the last day of m.
 */
function isWholeMonth(fromYmd, toYmd) {
  if (!YMD.test(String(fromYmd)) || !YMD.test(String(toYmd))) return false;
  const [fy, fm, fd] = String(fromYmd).split('-').map(Number);
  const [ty, tm, td] = String(toYmd).split('-').map(Number);
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return fy === ty && fm === tm && fd === 1 && td === lastDay;
}

/** The last complete IST calendar month, as { from, to } in 'YYYY-MM-DD'. */
function lastCompleteMonthIst(now = new Date()) {
  const t = new Date(now.getTime() + IST_OFFSET_MS);
  const year = t.getUTCFullYear();
  const month = t.getUTCMonth(); // 0-based, the month we are IN
  const py = month === 0 ? year - 1 : year;
  const pm = month === 0 ? 11 : month - 1;
  const lastDay = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { from: `${py}-${pad(pm + 1)}-01`, to: `${py}-${pad(pm + 1)}-${pad(lastDay)}` };
}

module.exports = {
  IST_OFFSET_MS,
  istDayStartUtc,
  istRangeUtc,
  formatIstDate,
  daysBetween,
  isWholeMonth,
  lastCompleteMonthIst,
};
