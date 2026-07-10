/**
 * One-time DPDP notice (Act s.5(2)) to all existing customers: registered
 * users plus paid-but-never-onboarded purchasers. Dedupes by email.
 *
 * Usage:
 *   node scripts/send-dpdp-notice.js                       # dry run — lists recipients only
 *   node scripts/send-dpdp-notice.js --preview you@x.com   # send a single test email to yourself
 *   node scripts/send-dpdp-notice.js --send                # actually send to everyone
 */
require('dotenv').config();
const prisma = require('../src/utils/prisma');
const siteUrls = require('../src/config/siteUrls');
const { sendDpdpNoticeEmail } = require('../src/services/email.service');

const SEND = process.argv.includes('--send');
const previewIdx = process.argv.indexOf('--preview');
const PREVIEW_TO = previewIdx !== -1 ? process.argv[previewIdx + 1] : null;
const DELAY_MS = 500; // be gentle with the SMTP provider

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectRecipients() {
  const [users, payments] = await Promise.all([
    prisma.user.findMany({ select: { email: true } }),
    prisma.payment.findMany({
      where: { status: 'paid', customerEmail: { not: null } },
      select: { customerEmail: true },
    }),
  ]);
  const emails = new Set();
  for (const u of users) if (u.email) emails.add(u.email.trim().toLowerCase());
  for (const p of payments) if (p.customerEmail) emails.add(p.customerEmail.trim().toLowerCase());
  return [...emails].sort();
}

(async () => {
  const privacyUrl = `${siteUrls.landingUrl()}/privacy`;
  const dashboardUrl = `${siteUrls.coupleDashboardUrl()}/dashboard`;

  if (PREVIEW_TO) {
    await sendDpdpNoticeEmail({ to: PREVIEW_TO, privacyUrl, dashboardUrl });
    console.log(`[dpdp-notice] preview sent to ${PREVIEW_TO}`);
    process.exit(0);
  }

  const recipients = await collectRecipients();
  console.log(`[dpdp-notice] ${recipients.length} unique recipients`);

  if (!SEND) {
    for (const email of recipients) console.log('  ', email);
    console.log('[dpdp-notice] dry run — re-run with --send to deliver, or --preview <email> to test');
    process.exit(0);
  }

  let sent = 0;
  let failed = 0;
  for (const email of recipients) {
    try {
      await sendDpdpNoticeEmail({ to: email, privacyUrl, dashboardUrl });
      sent++;
      console.log(`[dpdp-notice] sent ${sent}/${recipients.length}: ${email}`);
    } catch (err) {
      failed++;
      console.error(`[dpdp-notice] FAILED ${email}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`[dpdp-notice] done — ${sent} sent, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('[dpdp-notice] fatal:', err.message);
  process.exit(1);
});
