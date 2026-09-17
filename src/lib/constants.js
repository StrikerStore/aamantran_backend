/**
 * Shared platform constants — event types, communities, languages.
 * Keep in sync with admin-panel/src/lib/constants.js
 */

const COMMUNITY_VALUES = ['hindu', 'muslim', 'sikh', 'christian', 'jain', 'parsi', 'universal'];

const EVENT_TYPES = [
  // Wedding & Related
  'Wedding', 'Engagement', 'Reception', 'Sangeet', 'Haldi', 'Mehendi',
  // Religious Ceremonies
  'Nikah', 'Anand Karaj', 'Thread Ceremony', 'Naming Ceremony', 'Griha Pravesh',
  // Celebrations
  'Birthday', 'First Birthday', 'Baby Shower', 'House Warming', 'Anniversary', 'Retirement',
];

const LANGUAGE_CODES = ['en', 'hi', 'gu', 'ur', 'pa', 'mr', 'kn', 'te', 'ml', 'ta'];

/**
 * Optional merchandising tag shown in the corner of a template card.
 *
 * A fixed set rather than free text: each value carries its own colour on the
 * storefront, and a closed list is the only thing that stops the same idea
 * arriving as TRENDING, Trending and trendy on three different cards. Adding a
 * value means adding it here, in the admin mirror, and in the website's
 * lib/templateBadges.ts.
 */
const TEMPLATE_BADGES = ['new', 'trending', 'bestseller', 'popular', 'limited'];

// Capability chips shown on storefront cards and the product page. A fixed
// vocabulary rather than free text, so the gallery can filter on them later and
// two templates never describe the same capability in two different words.
const TEMPLATE_HIGHLIGHTS = [
  'Countdown', 'Photo gallery', 'Background music', 'Video',
  'Maps & directions', 'Multi-ceremony', 'Bilingual', 'RSVP', 'Guest wishes',
];

// DPDP: bump whenever /privacy or /terms changes materially — stored on
// Payment/User rows as a record of which notice version was consented to.
// 2026-09-16: free previews ("try it with your names") added to /privacy.
const POLICY_VERSION = '2026-09-16';

module.exports = { COMMUNITY_VALUES, EVENT_TYPES, LANGUAGE_CODES, TEMPLATE_BADGES, TEMPLATE_HIGHLIGHTS, POLICY_VERSION };
