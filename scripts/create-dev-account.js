/**
 * Provision a Template Lab developer account.
 *
 *   npm run dev:account -- --email dev@example.com --handle arjun --name "Arjun S"
 *   npm run dev:account -- --handle arjun --rotate            # new password
 *   npm run dev:account -- --handle arjun --disable            # revoke access
 *   npm run dev:account -- --handle arjun --enable
 *
 * The plaintext password is printed once and never stored recoverably.
 */
require('dotenv').config();
const siteUrls = require('../src/config/siteUrls');
const {
  createDeveloper,
  rotateDeveloperPassword,
  setDeveloperActive,
} = require('../src/services/developerAccount.service');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function has(flag) {
  return process.argv.includes(flag);
}

(async () => {
  const handle = arg('--handle');

  if (has('--disable') || has('--enable')) {
    const dev = await setDeveloperActive(handle, has('--enable'));
    console.log(`[dev-account] ${dev.handle} is now ${dev.isActive ? 'ACTIVE' : 'DISABLED'}`);
    console.log('[dev-account] existing sessions are checked on every request, so this takes effect immediately.');
    return;
  }

  if (has('--rotate')) {
    const { developer, generatedPassword } = await rotateDeveloperPassword(handle, arg('--password'));
    console.log(`[dev-account] password rotated for ${developer.handle}`);
    console.log(`[dev-account] password: ${generatedPassword}`);
    console.log('[dev-account] ^ shown once. Any open Lab session is now signed out.');
    return;
  }

  const { developer, generatedPassword } = await createDeveloper({
    email:         arg('--email'),
    name:          arg('--name'),
    handle,
    password:      arg('--password'),
    templateLimit: arg('--limit'),
  });

  console.log('[dev-account] created');
  console.log(`[dev-account] name:     ${developer.name}`);
  console.log(`[dev-account] handle:   ${developer.handle}`);
  console.log(`[dev-account] email:    ${developer.email}`);
  console.log(`[dev-account] password: ${generatedPassword}`);
  console.log(`[dev-account] lab:      ${siteUrls.labUrl()}`);
  console.log(`[dev-account] invite:   ${siteUrls.apiBaseUrl()}/i/lab-${developer.handle}`);
  console.log(`[dev-account] templates allowed: ${developer.templateLimit}`);
  console.log('[dev-account] ^ password shown once — send it to the developer now.');
})()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[dev-account] failed:', err.message);
    process.exit(1);
  });
