/**
 * Normalize optional user-entered URLs for Event social links.
 * Empty input → null. Adds https:// when no scheme is present.
 * @param {unknown} value
 * @param {number} [maxLen=2048]
 * @returns {string|null}
 */
function normalizeOptionalHttpUrl(value, maxLen = 2048) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const href = u.href;
    return href.length > maxLen ? href.slice(0, maxLen) : href;
  } catch {
    return null;
  }
}

module.exports = { normalizeOptionalHttpUrl };
