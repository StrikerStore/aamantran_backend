/**
 * Storefront marketing metadata for a template.
 *
 * `shortDescription` is the one-line sentence shown on gallery cards and above
 * the fold on the product page; `highlights` are the capability chips beside it.
 * Both are optional — the storefront falls back to `aboutText` — so nothing here
 * ever rejects a save: values are normalised, and anything unrecognised is
 * dropped rather than 400'd.
 *
 * Highlights are stored as a comma-separated string to match `bestFor` and
 * `languages`, which already use that shape on this model.
 */
const { TEMPLATE_HIGHLIGHTS } = require('../lib/constants');

const SHORT_DESCRIPTION_MAX = 300;
const HIGHLIGHTS_MAX = 500;
const ABOUT_EXCERPT_WORDS = 30;

/** Case-insensitive lookup so "photo gallery" from an older client still matches. */
const HIGHLIGHT_BY_LOWER = new Map(TEMPLATE_HIGHLIGHTS.map((h) => [h.toLowerCase(), h]));

/** Trim, collapse whitespace, cap length. Empty input becomes null, never ''. */
function normalizeShortDescription(value) {
  if (value == null) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim().slice(0, SHORT_DESCRIPTION_MAX);
  return clean || null;
}

/** Accepts an array or a comma string; keeps known values only, in vocabulary order. */
function normalizeHighlights(value) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const picked = new Set();
  for (const item of raw) {
    const match = HIGHLIGHT_BY_LOWER.get(String(item).trim().toLowerCase());
    if (match) picked.add(match);
  }
  if (!picked.size) return null;
  // Order by the vocabulary so chips read the same on every card.
  const ordered = TEMPLATE_HIGHLIGHTS.filter((h) => picked.has(h));
  return ordered.join(', ').slice(0, HIGHLIGHTS_MAX) || null;
}

/**
 * First words of a longer text, for gallery cards on templates whose admin has
 * not written a short description yet. Tags are stripped in case the about text
 * was pasted from a rich editor, and the full text is never sent with a list:
 * a 100-row catalogue response would carry a lot of prose no card shows.
 */
function excerptWords(value, maxWords = ABOUT_EXCERPT_WORDS) {
  if (value == null) return null;
  const clean = String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const words = clean.split(' ');
  return words.length <= maxWords ? clean : `${words.slice(0, maxWords).join(' ')}…`;
}

/** Stored string back to an array for API responses. */
function parseHighlights(value) {
  if (!value) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  SHORT_DESCRIPTION_MAX,
  ABOUT_EXCERPT_WORDS,
  normalizeShortDescription,
  normalizeHighlights,
  parseHighlights,
  excerptWords,
};
