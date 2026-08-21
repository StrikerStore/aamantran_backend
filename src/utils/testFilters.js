/**
 * Shared Prisma filters that keep the master template-testing account out of
 * admin analytics, public aggregates and background jobs.
 *
 * Spread these into a `where`; none of the call sites use a top-level `NOT`,
 * so the payment/review filters merge cleanly.
 */

/** User-rooted queries: admin user list and counts. */
const EXCLUDE_TEST_USER = { isTestAccount: false };

/** Event-rooted queries: cron jobs, retention, render, delete guards. */
const EXCLUDE_TEST_EVENT = { isTestEvent: false };

/**
 * Payment- and review-rooted queries.
 *
 * `userId` is nullable on both models, and accountDeletion.controller.js
 * de-identifies deleted users' payments to `userId: null` for tax-law
 * retention. A bare `user: { isTestAccount: false }` would silently drop every
 * one of those rows from admin revenue, so this negates the positive match
 * instead: NOT(owned by a test user) keeps null-owner rows in.
 */
const EXCLUDE_TEST_OWNER = { NOT: { user: { is: { isTestAccount: true } } } };

module.exports = {
  EXCLUDE_TEST_USER,
  EXCLUDE_TEST_EVENT,
  EXCLUDE_TEST_OWNER,
};
