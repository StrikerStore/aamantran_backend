/**
 * Template Lab developer accounts.
 *
 * Each developer owns a paired sandbox `User` flagged `isTestAccount: true`.
 * That pairing is the whole trick: the sandbox Event needs a real owner, and
 * flagging the owner means every existing filter in utils/testFilters.js keeps
 * the developer's experiments out of admin analytics, revenue, cron jobs and
 * DPDP retention without a single new exclusion being written.
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { validateNewPassword } = require('../utils/authSecurity');

const POLICY_VERSION = process.env.POLICY_VERSION || '2026-07-08';

/** 12 chars of base64url — comfortably clears validateNewPassword. */
function generatePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

/** Handles become part of a public invite slug, so keep them URL-clean. */
function normalizeHandle(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

/**
 * Create a developer and their sandbox user.
 *
 * @returns {Promise<{ developer: object, generatedPassword: string }>}
 */
async function createDeveloper({ email, name, handle, password, templateLimit } = {}) {
  const cleanEmail  = String(email || '').trim().toLowerCase();
  const cleanHandle = normalizeHandle(handle || cleanEmail.split('@')[0]);
  const cleanName   = String(name || '').trim() || cleanHandle;

  if (!cleanEmail || !cleanEmail.includes('@')) fail('A valid email is required');
  if (!cleanHandle) fail('A valid handle is required (letters, digits and dashes)');

  const plain = password != null ? String(password) : generatePassword();
  const invalid = validateNewPassword(plain);
  if (invalid) fail(invalid);

  const clash = await prisma.developerAccount.findFirst({
    where:  { OR: [{ email: cleanEmail }, { handle: cleanHandle }] },
    select: { email: true, handle: true },
  });
  if (clash) {
    fail(
      clash.handle === cleanHandle
        ? `Handle "${cleanHandle}" is already taken`
        : `A developer with email ${cleanEmail} already exists`,
      409
    );
  }

  // The sandbox invite lives at /i/lab-<handle> forever, so the slug must be
  // free before we commit to the handle.
  const slugTaken = await prisma.event.findUnique({ where: { slug: `lab-${cleanHandle}` } });
  if (slugTaken) fail(`The invite slug lab-${cleanHandle} is already in use`, 409);

  const passwordHash = await bcrypt.hash(plain, 12);

  const developer = await prisma.$transaction(async (tx) => {
    const sandboxUser = await tx.user.create({
      data: {
        email:         cleanEmail,
        username:      `lab-${cleanHandle}`,
        passwordHash,
        consentAt:     new Date(),
        policyVersion: POLICY_VERSION,
        // Inherits every test-data exclusion already in the codebase.
        isTestAccount: true,
      },
    });

    return tx.developerAccount.create({
      data: {
        email:         cleanEmail,
        name:          cleanName,
        handle:        cleanHandle,
        passwordHash,
        sandboxUserId: sandboxUser.id,
        ...(templateLimit != null ? { templateLimit: Number(templateLimit) } : {}),
      },
      select: {
        id: true, email: true, name: true, handle: true,
        templateLimit: true, isActive: true, createdAt: true, sandboxUserId: true,
      },
    });
  });

  return { developer, generatedPassword: plain };
}

/**
 * Rotate a developer's password, returning the new plaintext exactly once.
 * Also invalidates live sessions — dev JWTs carry a `pv` fingerprint of the hash.
 */
async function rotateDeveloperPassword(handleOrEmail, password) {
  const key = String(handleOrEmail || '').trim().toLowerCase();
  const dev = await prisma.developerAccount.findFirst({
    where: { OR: [{ handle: key }, { email: key }] },
  });
  if (!dev) fail(`No developer found for "${handleOrEmail}"`, 404);

  const plain = password != null ? String(password) : generatePassword();
  const invalid = validateNewPassword(plain);
  if (invalid) fail(invalid);

  const passwordHash = await bcrypt.hash(plain, 12);
  await prisma.$transaction([
    prisma.developerAccount.update({ where: { id: dev.id }, data: { passwordHash } }),
    // Keep the sandbox user's hash in step so the couple-app login (used by the
    // "open the wizard" path) stays usable with the same password.
    prisma.user.update({ where: { id: dev.sandboxUserId }, data: { passwordHash } }),
  ]);

  return { developer: dev, generatedPassword: plain };
}

/** Disable or re-enable access. devAuth re-reads this on every request. */
async function setDeveloperActive(handleOrEmail, isActive) {
  const key = String(handleOrEmail || '').trim().toLowerCase();
  const dev = await prisma.developerAccount.findFirst({
    where: { OR: [{ handle: key }, { email: key }] },
  });
  if (!dev) fail(`No developer found for "${handleOrEmail}"`, 404);

  return prisma.developerAccount.update({
    where:  { id: dev.id },
    data:   { isActive: Boolean(isActive) },
    select: { id: true, handle: true, email: true, isActive: true },
  });
}

module.exports = {
  createDeveloper,
  rotateDeveloperPassword,
  setDeveloperActive,
  generatePassword,
  normalizeHandle,
};
