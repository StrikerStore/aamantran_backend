const bcrypt = require('bcrypt');
const prisma = require('../utils/prisma');
const objectStorage = require('../services/objectStorage');
const { sendAccountDeletedEmail } = require('../services/email.service');
const { logAuthEvent } = require('../utils/authAudit');

/**
 * DELETE /api/user/me — DPDP right to erasure (Act s.12).
 *
 * Deletes the account and all personal data: events (guests, RSVPs, wishes,
 * media, planning data cascade), reviews, support tickets and uploaded files.
 * Payment rows are kept for tax-law compliance but de-identified (userId,
 * customerEmail and eventId cleared).
 */
async function deleteAccount(req, res) {
  const userId = req.user.id;
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ ok: false, message: 'Password confirmation is required to delete your account' });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, username: true, passwordHash: true },
  });
  if (!user) return res.status(404).json({ ok: false, message: 'Account not found' });

  const valid = await bcrypt.compare(String(password), user.passwordHash);
  if (!valid) {
    logAuthEvent('account_delete_denied', req, { userId });
    // 403 (not 401): the dashboard API client treats 401 as an expired session
    return res.status(403).json({ ok: false, message: 'Incorrect password' });
  }

  const events = await prisma.event.findMany({ where: { ownerId: userId }, select: { id: true } });
  const eventIds = events.map((e) => e.id);

  // Collect uploaded-file URLs before the rows are gone
  const fileUrls = [];
  if (eventIds.length) {
    const [media, people, photos, pins] = await Promise.all([
      prisma.media.findMany({ where: { eventId: { in: eventIds } }, select: { url: true } }),
      prisma.eventPerson.findMany({ where: { eventId: { in: eventIds } }, select: { photoUrl: true } }),
      prisma.photoWallItem.findMany({ where: { eventId: { in: eventIds } }, select: { url: true } }),
      prisma.moodBoardPin.findMany({ where: { eventId: { in: eventIds } }, select: { imageUrl: true } }),
    ]);
    fileUrls.push(
      ...media.map((m) => m.url),
      ...people.map((p) => p.photoUrl),
      ...photos.map((p) => p.url),
      ...pins.map((p) => p.imageUrl),
    );
  }
  const reviews = await prisma.templateReview.findMany({ where: { userId }, select: { couplePhotoUrl: true } });
  fileUrls.push(...reviews.map((r) => r.couplePhotoUrl));

  await prisma.$transaction([
    // Children of Event without a cascade path must go first
    prisma.invitationEvent.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.templateSwapRequest.deleteMany({
      where: { OR: [{ userId }, { eventId: { in: eventIds } }] },
    }),
    prisma.supportTicket.deleteMany({ where: { userId } }), // messages cascade
    prisma.templateReview.deleteMany({ where: { userId } }),
    // Keep payments for tax law, but de-identify them (DPDP-permitted retention)
    prisma.payment.updateMany({
      where: { OR: [{ userId }, { eventId: { in: eventIds } }] },
      data: { userId: null, customerEmail: null, eventId: null },
    }),
    // Guests, RSVPs, wishes, media, functions, venues, planning data all cascade
    prisma.event.deleteMany({ where: { ownerId: userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);

  // Best-effort object-storage cleanup after the DB commit
  for (const url of fileUrls) {
    if (url) objectStorage.tryDeletePublicUrl(url).catch(() => {});
  }

  logAuthEvent('account_deleted', req, { userId, events: eventIds.length });
  sendAccountDeletedEmail({ to: user.email, username: user.username })
    .catch((err) => console.error('[Email Error] sendAccountDeletedEmail:', err.message));

  return res.json({ ok: true, message: 'Your account and personal data have been deleted' });
}

module.exports = { deleteAccount };
