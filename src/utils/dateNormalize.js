/**
 * Normalize assorted date strings (admin/user input, ISO, DD-MM-YYYY) to YYYY-MM-DD.
 * Used for template countdown / reveal UI and consistent storage.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * @param {unknown} input - Date, ISO string, DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD, etc.
 * @returns {string} '' if unparseable
 */
function parseFlexibleDateInputToYyyyMmDd(input) {
  if (input == null || input === '') return '';
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return ymd(input.getFullYear(), input.getMonth() + 1, input.getDate());
  }
  const s0 = String(input).trim();
  if (!s0) return '';

  // ISO / starts with YYYY-MM-DD (allow trailing time)
  let m = s0.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // YYYY/MM/DD or YYYY.MM.DD
  m = s0.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})/);
  if (m) return ymd(m[1], parseInt(m[2], 10), parseInt(m[3], 10));

  // DD-MM-YYYY or DD/MM/YYYY (day first when ambiguous)
  m = s0.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    if (a > 12 && b <= 12) return ymd(y, b, a);
    if (b > 12 && a <= 12) return ymd(y, a, b);
    return ymd(y, b, a);
  }

  const d = new Date(s0);
  if (!Number.isNaN(d.getTime())) return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return '';
}

/** Value for <input type="date" value> (YYYY-MM-DD or ''). */
function toHtmlDateInputValue(stored) {
  return parseFlexibleDateInputToYyyyMmDd(stored);
}

/** @returns {Set<string>} custom field keys declared with type "date" */
function getDateCustomFieldKeysFromSchema(fieldSchema) {
  const keys = new Set();
  if (!fieldSchema) return keys;
  let fs = fieldSchema;
  if (typeof fs === 'string') {
    try { fs = JSON.parse(fs); } catch { return keys; }
  }
  const arr = Array.isArray(fs?.customFields)
    ? fs.customFields
    : (Array.isArray(fs) ? fs : []);
  for (const cf of arr) {
    const key = cf.key || cf.fieldKey;
    if (key && cf.type === 'date') keys.add(String(key));
  }
  return keys;
}

/** Admin demo payload: [{ key, value }] - coerce date-type values to YYYY-MM-DD */
function normalizeDemoCustomFieldRows(fieldSchema, rows) {
  if (!Array.isArray(rows)) return rows || [];
  const dateKeys = getDateCustomFieldKeysFromSchema(fieldSchema);
  return rows
    .map((row) => {
      const key = row.key ?? row.fieldKey;
      const raw = row.value ?? row.fieldValue ?? '';
      if (!key) return null;
      if (dateKeys.has(String(key)) && raw !== '' && raw != null) {
        const iso = parseFlexibleDateInputToYyyyMmDd(raw);
        return { key, value: iso || String(raw) };
      }
      return { key, value: raw === null || raw === undefined ? '' : String(raw) };
    })
    .filter(Boolean);
}

module.exports = {
  parseFlexibleDateInputToYyyyMmDd,
  toHtmlDateInputValue,
  getDateCustomFieldKeysFromSchema,
  normalizeDemoCustomFieldRows,
};
