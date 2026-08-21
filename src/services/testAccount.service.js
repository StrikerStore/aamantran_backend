/**
 * Master template-testing account.
 *
 * One permanent user that holds exactly one invitation at a time, so a template
 * can be walked end-to-end as a real buyer would — including unpublished drafts —
 * without making it live and without a payment.
 *
 * The account is identified by `User.isTestAccount`, never by a magic username,
 * so renaming it in env doesn't orphan the row or break the analytics filters.
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const objectStorage = require('./objectStorage');
const { validateNewPassword } = require('../utils/authSecurity');

// Username must be lowercase: login looks up `username.trim().toLowerCase()`
// (routes/userAuth.js), so a mixed-case value here would be unloggable.
const TEST_USERNAME = String(process.env.TEST_ACCOUNT_USERNAME || 'aamantran-test').trim().toLowerCase();
const TEST_EMAIL    = String(process.env.TEST_ACCOUNT_EMAIL || 'test@aamantran.online').trim().toLowerCase();
const TEST_SLUG     = String(process.env.TEST_EVENT_SLUG || 'aamantran-test').trim().toLowerCase();

const POLICY_VERSION = process.env.POLICY_VERSION || '2026-07-08';

/** 12 chars of base64url — comfortably clears validateNewPassword. */
function generatePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

/**
 * The test user, or null. Matched on the flag first so an admin can rename
 * TEST_ACCOUNT_USERNAME without losing the account; falls back to the username
 * so a pre-existing row can be adopted on first run.
 */
async function findTestUser() {
  const byFlag = await prisma.user.findFirst({ where: { isTestAccount: true } });
  if (byFlag) return byFlag;
  return prisma.user.findFirst({ where: { username: TEST_USERNAME } });
}

/**
 * Create the test account, or adopt/update an existing one. Idempotent.
 *
 * Rotating the password is a feature, not just maintenance: user JWTs carry a
 * `pv` fingerprint of the hash (middleware/userAuth.js), so a rotation instantly
 * invalidates any session left open on a demo machine.
 *
 * @returns {Promise<{ user: object, generatedPassword: string|null, created: boolean }>}
 */
async function ensureTestAccount({ password } = {}) {
  const duplicates = await prisma.user.count({ where: { isTestAccount: true } });
  if (duplicates > 1) {
    const rows = await prisma.user.findMany({
      where:  { isTestAccount: true },
      select: { id: true, username: true },
    });
    const err = new Error(
      `Multiple test accounts found (${rows.map(r => `${r.username}:${r.id}`).join(', ')}). ` +
      'Clear the isTestAccount flag on all but one.'
    );
    err.status = 409;
    throw err;
  }

  if (password != null) {
    const invalid = validateNewPassword(password);
    if (invalid) {
      const err = new Error(invalid);
      err.status = 400;
      throw err;
    }
  }

  const existing = await findTestUser();

  if (existing) {
    const data = { isTestAccount: true };
    let generatedPassword = null;

    if (password != null) {
      data.passwordHash = await bcrypt.hash(String(password), 12);
    }
    const user = await prisma.user.update({ where: { id: existing.id }, data });
    return { user, generatedPassword, created: false };
  }

  const plain = password != null ? String(password) : generatePassword();
  const user = await prisma.user.create({
    data: {
      email:         TEST_EMAIL,
      username:      TEST_USERNAME,
      passwordHash:  await bcrypt.hash(plain, 12),
      phone:         null,
      consentAt:     new Date(),
      policyVersion: POLICY_VERSION,
      isTestAccount: true,
    },
  });

  return { user, generatedPassword: plain, created: true };
}

/** Rotate the password, returning the new plaintext exactly once. */
async function rotatePassword(password) {
  const existing = await findTestUser();
  if (!existing) {
    const err = new Error('Test account has not been created yet');
    err.status = 404;
    throw err;
  }
  const plain = password != null ? String(password) : generatePassword();
  const invalid = validateNewPassword(plain);
  if (invalid) {
    const err = new Error(invalid);
    err.status = 400;
    throw err;
  }
  const user = await prisma.user.update({
    where: { id: existing.id },
    data:  { passwordHash: await bcrypt.hash(plain, 12), isTestAccount: true },
  });
  return { user, generatedPassword: plain };
}

/**
 * Delete every event owned by the test user and all data hanging off it.
 *
 * Four Event relations have no `onDelete` rule in the schema — InvitationEvent,
 * TemplateSwapRequest, SupportTicket and Payment — so they must go first or the
 * delete fails on a foreign key. Same ordering as
 * controllers/accountDeletion.controller.js; keep the two in sync.
 *
 * @param {string} [userId] Defaults to the test user; pass explicitly to avoid a lookup.
 * @returns {Promise<{ events: number, files: number }>}
 */
async function purgeTestEvents(userId) {
  let ownerId = userId;
  if (!ownerId) {
    const user = await findTestUser();
    if (!user) return { events: 0, files: 0 };
    ownerId = user.id;
  }

  const events = await prisma.event.findMany({ where: { ownerId }, select: { id: true } });
  const eventIds = events.map((e) => e.id);

  // Collect uploaded-file URLs before the rows are gone, or every load leaks
  // the R2 objects for the media just uploaded.
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
  const reviews = await prisma.templateReview.findMany({ where: { userId: ownerId }, select: { couplePhotoUrl: true } });
  fileUrls.push(...reviews.map((r) => r.couplePhotoUrl));

  await prisma.$transaction([
    prisma.invitationEvent.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.templateSwapRequest.deleteMany({
      where: { OR: [{ userId: ownerId }, { eventId: { in: eventIds } }] },
    }),
    prisma.supportTicket.deleteMany({ where: { userId: ownerId } }), // messages cascade
    prisma.templateReview.deleteMany({ where: { userId: ownerId } }),
    // The test account never buys anything, but detach defensively so a stray
    // row can't block the delete.
    prisma.payment.updateMany({
      where: { OR: [{ userId: ownerId }, { eventId: { in: eventIds } }] },
      data:  { eventId: null },
    }),
    // Guests, RSVPs, wishes, media, functions, venues, planning data all cascade
    prisma.event.deleteMany({ where: { ownerId } }),
  ]);

  for (const url of fileUrls) {
    if (url) objectStorage.tryDeletePublicUrl(url).catch(() => {});
  }

  return { events: eventIds.length, files: fileUrls.filter(Boolean).length };
}

module.exports = {
  TEST_USERNAME,
  TEST_EMAIL,
  TEST_SLUG,
  findTestUser,
  ensureTestAccount,
  rotatePassword,
  generatePassword,
  purgeTestEvents,
};
