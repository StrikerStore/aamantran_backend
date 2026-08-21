/**
 * Create or adopt the master template-testing account. Idempotent — safe to
 * re-run. Normally done from the admin Testing page; use this when you only
 * have shell access, or to recover after the row was deleted directly in the DB.
 *
 *   npm run test:account                 # create, printing a generated password
 *   npm run test:account -- --password X # create or rotate to a chosen password
 *
 * The plaintext password is printed once and never stored recoverably.
 */
require('dotenv').config();
const { ensureTestAccount, TEST_USERNAME, TEST_EMAIL } = require('../src/services/testAccount.service');

const pwIndex  = process.argv.indexOf('--password');
const password = pwIndex !== -1 ? process.argv[pwIndex + 1] : undefined;

(async () => {
  const { user, generatedPassword, created } = await ensureTestAccount({ password });

  console.log(`[test-account] ${created ? 'created' : 'already exists — updated'}`);
  console.log(`[test-account] id:       ${user.id}`);
  console.log(`[test-account] username: ${TEST_USERNAME}`);
  console.log(`[test-account] email:    ${TEST_EMAIL}`);
  if (generatedPassword) {
    console.log(`[test-account] password: ${generatedPassword}`);
    console.log('[test-account] ^ shown once — save it now.');
  } else {
    console.log('[test-account] password unchanged (pass --password to rotate).');
  }
  process.exit(0);
})().catch((err) => {
  console.error('[test-account] failed:', err.message);
  process.exit(1);
});
