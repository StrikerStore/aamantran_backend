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

/**
 * Normalize an optional user-entered hashtag. Stored bare — no leading "#" —
 * so the renderer can add exactly one. Strips whitespace and anything that is
 * not valid inside a hashtag. Combining marks are kept, or Indic scripts lose
 * their vowel signs ("शादी" would collapse to "शद"). Empty input → null.
 * @param {unknown} value
 * @param {number} [maxLen=120]
 * @returns {string|null}
 */
function normalizeOptionalHashtag(value, maxLen = 120) {
  const s = String(value ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}\p{M}_]/gu, '');
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

module.exports = { normalizeOptionalHttpUrl, normalizeOptionalHashtag };
