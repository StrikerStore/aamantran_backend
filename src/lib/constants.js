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

module.exports = { COMMUNITY_VALUES, EVENT_TYPES, LANGUAGE_CODES };
