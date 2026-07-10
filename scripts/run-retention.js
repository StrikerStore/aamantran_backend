/**
 * Manually run the DPDP guest-data retention job (warning emails + erasure)
 * and the auth-audit-log prune. Normally handled by the in-process cron
 * (3:15 AM daily, see src/services/scheduler.js); use this to verify locally
 * or catch up after downtime:  npm run jobs:retention
 */
require('dotenv').config();
const { runGuestDataRetentionJob, pruneAuthAuditLogs } = require('../src/services/dataRetention.service');

(async () => {
  await runGuestDataRetentionJob();
  await pruneAuthAuditLogs();
  console.log('[retention] manual run complete');
  process.exit(0);
})().catch((err) => {
  console.error('[retention] manual run failed:', err.message);
  process.exit(1);
});
