/**
 * Manually run the website-analytics daily rollup + raw-data prune.
 * Normally handled by the in-process cron (2:30 AM daily, see src/services/scheduler.js);
 * use this to backfill after downtime or verify locally:  npm run jobs:analytics-rollup
 */
require('dotenv').config();
const { runWebsiteAnalyticsRollupJob, pruneOldWebsiteData } = require('../src/services/analyticsRollup.service');

(async () => {
  await runWebsiteAnalyticsRollupJob();
  await pruneOldWebsiteData();
  console.log('[analytics] manual rollup + prune complete');
  process.exit(0);
})().catch((err) => {
  console.error('[analytics] manual rollup failed:', err.message);
  process.exit(1);
});
