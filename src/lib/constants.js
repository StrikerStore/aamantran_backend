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

// DPDP: bump whenever /privacy or /terms changes materially — stored on
// Payment/User rows as a record of which notice version was consented to.
const POLICY_VERSION = '2026-07-08';

module.exports = { COMMUNITY_VALUES, EVENT_TYPES, LANGUAGE_CODES, TEMPLATE_BADGES, POLICY_VERSION };
