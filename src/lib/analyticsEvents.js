/**
 * Website analytics event names — the single allowlist for POST /api/track.
 *
 * Two kinds share the WebsiteEvent table:
 *   - FUNNEL_STAGES are conversions. The admin funnel and the nightly
 *     WebsiteDailyStat.conversions breakdown are built from these alone.
 *   - INTERACTION_EVENTS record storefront engagement (demo opens, checkout
 *     retries, personal try-it demos). They are stored and queryable, but they
 *     are never counted as conversions.
 *
 * Guest invitation opens are NOT here. They are InvitationEvent rows written by
 * routes/render.js — a separate table this list never touches — so nothing in
 * this file can affect a live invitation or the couple dashboard's open counts.
 *
 * Keep in sync with aamantran_website/lib/track.ts TrackEventType.
 */

/** WebsiteEvent.type is VARCHAR(32). */
const TYPE_MAX_LENGTH = 32;

const FUNNEL_STAGES = ['view_template', 'initiate_checkout', 'purchase', 'register_complete'];

const INTERACTION_EVENTS = [
  'demo_opened',               // live template demo opened from the storefront
  'guest_demo_interaction',    // sample RSVP / wishes demo used
  'planning_demo_interaction', // sample planning workspace used
  'checkout_error',            // checkout validation or API error shown
  'payment_failed_return',     // buyer came back after a failed payment
  'checkout_retry',            // buyer retried checkout after a failure
  'try_demo_started',          // "Try it with your names" sheet opened
  'try_demo_created',          // personal demo link generated
  'try_demo_opened',           // personal demo link opened
  'try_demo_to_checkout',      // buyer went from a personal demo to checkout
];

const EVENT_TYPES = ['pageview', ...FUNNEL_STAGES, ...INTERACTION_EVENTS];

// Fail at startup rather than at insert time: a name longer than the column
// would make every beacon of that type return 500 in production.
for (const type of EVENT_TYPES) {
  if (type.length > TYPE_MAX_LENGTH) {
    throw new Error(`Analytics event type "${type}" exceeds ${TYPE_MAX_LENGTH} characters`);
  }
}
if (new Set(EVENT_TYPES).size !== EVENT_TYPES.length) {
  throw new Error('Duplicate analytics event type in lib/analyticsEvents.js');
}

module.exports = { FUNNEL_STAGES, INTERACTION_EVENTS, EVENT_TYPES };
