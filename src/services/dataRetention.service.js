/**
 * DPDP guest-data retention (privacy-policy Section 6).
 *
 * Guest personal data (guest list, RSVPs, wishes, per-guest invitation
 * activity) is erased 90 days after the invitation expires. The owner gets a
 * warning email at ~day 88 with an export link; deletion only proceeds once
 * the warning is at least 48 hours old, so on the first deploy historic
 * events are warned first and swept on a later run.
 */
const prisma = require('../utils/prisma');
const siteUrls = require('../config/siteUrls');
const { sendGuestDataDeletionWarningEmail } = require('./email.service');

const DAY_MS = 24 * 60 * 60 * 1000;
const WARNING_AFTER_DAYS = 88;
const DELETE_AFTER_DAYS = 90;
const MIN_WARNING_LEAD_MS = 48 * 60 * 60 * 1000;
const BATCH = 200;

function formatDate(d) {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Phase 1 — warn owners whose guest data is inside the 48h deletion window. */
async function sendDeletionWarnings(now = new Date()) {
  const events = await prisma.event.findMany({
    where: {
      expiresAt: { not: null, lte: new Date(now.getTime() - WARNING_AFTER_DAYS * DAY_MS) },
      guestDataWarningSentAt: null,
      guestDataDeletedAt: null,
    },
    select: {
      id: true,
      expiresAt: true,
      owner: { select: { email: true } },
    },
    take: BATCH,
  });

  for (const ev of events) {
    const [guests, wishes] = await Promise.all([
      prisma.guest.count({ where: { eventId: ev.id } }),
      prisma.guestWish.count({ where: { eventId: ev.id } }),
    ]);

    // Nothing personal to erase — mark done so the event is never rescanned.
    if (guests === 0 && wishes === 0) {
      await prisma.event.update({
        where: { id: ev.id },
        data: { guestDataWarningSentAt: now, guestDataDeletedAt: now },
      });
      continue;
    }

    // Mark first so a send failure can't cause repeat emails on the next run
    await prisma.event.update({ where: { id: ev.id }, data: { guestDataWarningSentAt: now } });

    if (ev.owner?.email) {
      const scheduled = new Date(ev.expiresAt.getTime() + DELETE_AFTER_DAYS * DAY_MS);
      const deleteDate = new Date(Math.max(scheduled.getTime(), now.getTime() + MIN_WARNING_LEAD_MS));
      const dashboardUrl = `${siteUrls.coupleDashboardUrl()}/dashboard`;
      await sendGuestDataDeletionWarningEmail({
        to: ev.owner.email,
        deleteDateStr: formatDate(deleteDate),
        exportUrl: dashboardUrl,
        dashboardUrl,
      }).catch((err) => console.error('[Email Error] sendGuestDataDeletionWarningEmail:', err.message));
    }
  }

  return events.length;
}

/** Phase 2 — erase guest data for events warned ≥48h ago and expired ≥90 days. */
async function eraseExpiredGuestData(now = new Date()) {
  const events = await prisma.event.findMany({
    where: {
      expiresAt: { not: null, lte: new Date(now.getTime() - DELETE_AFTER_DAYS * DAY_MS) },
      guestDataDeletedAt: null,
      guestDataWarningSentAt: { not: null, lte: new Date(now.getTime() - MIN_WARNING_LEAD_MS) },
    },
    select: { id: true },
    take: BATCH,
  });

  for (const ev of events) {
    await prisma.$transaction([
      prisma.invitationEvent.deleteMany({ where: { eventId: ev.id } }),
      prisma.rsvp.deleteMany({ where: { eventId: ev.id } }),
      prisma.guestWish.deleteMany({ where: { eventId: ev.id } }),
      prisma.guest.deleteMany({ where: { eventId: ev.id } }),
      prisma.event.update({ where: { id: ev.id }, data: { guestDataDeletedAt: now } }),
    ]);
    console.log(`[retention] erased guest data for event ${ev.id}`);
  }

  return events.length;
}

async function runGuestDataRetentionJob() {
  const now = new Date();
  await sendDeletionWarnings(now);
  await eraseExpiredGuestData(now);
}

/**
 * DPDP Rule 6(e): security logs must be retained for at least one year.
 * Prune beyond 13 months so the statutory year is always covered.
 */
async function pruneAuthAuditLogs() {
  const cutoff = new Date(Date.now() - 396 * DAY_MS);
  const { count } = await prisma.authAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count) console.log(`[retention] pruned ${count} auth audit logs older than 13 months`);
}

module.exports = {
  runGuestDataRetentionJob,
  sendDeletionWarnings,
  eraseExpiredGuestData,
  pruneAuthAuditLogs,
};
