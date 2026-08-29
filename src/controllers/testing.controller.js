/**
 * Master template-testing account — admin endpoints.
 *
 * Loads exactly one template at a time into a permanent test user so it can be
 * walked end-to-end as a real buyer would, including unpublished drafts, with
 * no payment and without making the template live.
 *
 * Two things make this work without new machinery:
 *   - Ownership is just `Event.ownerId`; there is no User↔Template join table.
 *   - `Event.templateVersionId = null` makes the renderer fall through to
 *     `templates/{slug}/draft/` (routes/render.js), which every ZIP re-upload
 *     rewrites — so template fixes appear on a browser refresh with no re-load.
 */
const jwt    = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const siteUrls = require('../config/siteUrls');
const { userJwtSecret, passwordVersion } = require('../utils/authSecurity');
const { mintInvitePreviewToken } = require('../services/previewToken');
const { deleteTemplateFolder, draftFolderName } = require('../services/fileManager');
const {
  TEST_USERNAME, TEST_EMAIL, TEST_SLUG,
  findTestUser, ensureTestAccount, rotatePassword, purgeTestEvents,
} = require('../services/testAccount.service');
const {
  createDeveloper, rotateDeveloperPassword, setDeveloperActive,
} = require('../services/developerAccount.service');

/** Mirrors the helper in routes/publicCheckout.js — first entry of `bestFor`. */
function inferEventTypeFromTemplate(template) {
  const first = String(template?.bestFor || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .find(Boolean);
  return first || 'wedding';
}

const EVENT_INCLUDE = {
  template: {
    select: {
      id: true, name: true, slug: true, isActive: true,
      thumbnailUrl: true, community: true, currentVersionId: true,
    },
  },
  templateVersion: { select: { id: true, versionNumber: true, folderPath: true } },
};

function buildUrls(event) {
  const api = siteUrls.apiBaseUrl();
  if (!event) return {};
  return {
    invite:        `${api}/i/${encodeURIComponent(event.slug)}`,
    preview:       `${api}/i/${encodeURIComponent(event.slug)}/preview?pt=${encodeURIComponent(mintInvitePreviewToken(event.slug))}`,
    userDashboard: `${siteUrls.coupleDashboardUrl()}/events/${event.id}/${event.isPublished ? 'edit' : 'generate'}`,
  };
}

function shapeEvent(event) {
  if (!event) return null;
  return {
    id:           event.id,
    slug:         event.slug,
    isPublished:  event.isPublished,
    community:    event.community,
    eventType:    event.eventType,
    language:     event.language,
    createdAt:    event.createdAt,
    // 'draft' renders the mutable draft folder; 'current' a frozen version snapshot
    renderSource: event.templateVersionId ? 'current' : 'draft',
    versionNumber: event.templateVersion?.versionNumber || null,
    template:     event.template,
  };
}

// GET /api/v1/testing/status
// Never 500s on a missing user — the Testing page renders an empty state from it.
async function status(req, res) {
  const user = await findTestUser();
  if (!user) {
    return res.json({
      ok: true,
      provisioned: false,
      config: { username: TEST_USERNAME, email: TEST_EMAIL, slug: TEST_SLUG },
      user: null, event: null, urls: {},
    });
  }

  const event = await prisma.event.findFirst({
    where:   { ownerId: user.id },
    orderBy: { createdAt: 'desc' },
    include: EVENT_INCLUDE,
  });

  res.json({
    ok: true,
    provisioned: true,
    config: { username: TEST_USERNAME, email: TEST_EMAIL, slug: TEST_SLUG },
    user:  { id: user.id, username: user.username, email: user.email, createdAt: user.createdAt },
    event: shapeEvent(event),
    urls:  buildUrls(event),
  });
}

// POST /api/v1/testing/account   Body: { password? }
// Idempotent create-or-adopt. Returns the plaintext password exactly once.
async function ensureAccount(req, res) {
  const { password } = req.body || {};
  const { user, generatedPassword, created } = await ensureTestAccount({ password });
  res.json({
    ok: true,
    created,
    user: { id: user.id, username: user.username, email: user.email },
    generatedPassword,
  });
}

// POST /api/v1/testing/rotate-password   Body: { password? }
async function rotate(req, res) {
  const { password } = req.body || {};
  const { user, generatedPassword } = await rotatePassword(password);
  res.json({
    ok: true,
    user: { id: user.id, username: user.username },
    generatedPassword,
  });
}

// POST /api/v1/testing/load-template
// Body: { templateId, renderSource?: 'draft'|'current', community?, eventType?,
//         language?, publish? }
//
// Deliberately no `isActive` filter on the template lookup — loading drafts is
// the whole point. Contrast publicCheckout.js, which requires isActive: true.
async function loadTemplate(req, res) {
  const {
    templateId,
    renderSource = 'draft',
    community,
    eventType,
    language = 'en',
    publish = false,
  } = req.body || {};

  if (!templateId) {
    return res.status(400).json({ ok: false, message: 'templateId is required' });
  }
  if (!['draft', 'current'].includes(renderSource)) {
    return res.status(400).json({ ok: false, message: "renderSource must be 'draft' or 'current'" });
  }

  const user = await findTestUser();
  if (!user) {
    return res.status(404).json({ ok: false, message: 'Test account has not been created yet' });
  }

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) return res.status(404).json({ ok: false, message: 'Template not found' });

  if (renderSource === 'current' && !template.currentVersionId) {
    return res.status(400).json({
      ok: false,
      message: 'This template has never been published, so it has no version snapshot. Load it as a draft instead.',
    });
  }

  // Delete-and-recreate rather than mutate: guarantees every counter and flag
  // resets without an enumeration that rots when a column is added.
  const cleared = await purgeTestEvents(user.id);

  const event = await prisma.event.create({
    data: {
      slug:              TEST_SLUG,
      ownerId:           user.id,
      templateId:        template.id,
      templateVersionId: renderSource === 'current' ? template.currentVersionId : null,
      community:         community || template.community || 'universal',
      eventType:         eventType || inferEventTypeFromTemplate(template),
      language:          language || 'en',
      brideName:         null,
      groomName:         null,
      namesAreFrozen:    false,
      isPublished:       Boolean(publish),
      isTestEvent:       true,
    },
    include: EVENT_INCLUDE,
  });

  // No sendTemplateChangedEmail here — unlike users.controller.changeTemplate,
  // there is no real owner to notify.
  res.json({
    ok: true,
    event:    shapeEvent(event),
    urls:     buildUrls(event),
    cleared,
  });
}

// POST /api/v1/testing/publish   Body: { publish?: boolean }
// One-click publish so /i/<slug> goes live without walking the wizard. The
// wizard's own namesAreFrozen gate is intentionally bypassed — this is the
// admin shortcut, not the buyer path.
async function setPublished(req, res) {
  const { publish = true } = req.body || {};
  const user = await findTestUser();
  if (!user) return res.status(404).json({ ok: false, message: 'Test account has not been created yet' });

  const existing = await prisma.event.findFirst({ where: { ownerId: user.id } });
  if (!existing) return res.status(404).json({ ok: false, message: 'No template is loaded in the test account' });

  const event = await prisma.event.update({
    where:   { id: existing.id },
    data:    { isPublished: Boolean(publish) },
    include: EVENT_INCLUDE,
  });

  res.json({ ok: true, event: shapeEvent(event), urls: buildUrls(event) });
}

// POST /api/v1/testing/repin   Body: { renderSource: 'draft'|'current' }
// Flip between the live draft folder and the frozen version snapshot without
// losing the data already entered in the wizard.
async function repin(req, res) {
  const { renderSource } = req.body || {};
  if (!['draft', 'current'].includes(renderSource)) {
    return res.status(400).json({ ok: false, message: "renderSource must be 'draft' or 'current'" });
  }

  const user = await findTestUser();
  if (!user) return res.status(404).json({ ok: false, message: 'Test account has not been created yet' });

  const existing = await prisma.event.findFirst({
    where:   { ownerId: user.id },
    include: { template: { select: { currentVersionId: true } } },
  });
  if (!existing) return res.status(404).json({ ok: false, message: 'No template is loaded in the test account' });

  if (renderSource === 'current' && !existing.template.currentVersionId) {
    return res.status(400).json({
      ok: false,
      message: 'This template has no published version yet — nothing to pin to.',
    });
  }

  const event = await prisma.event.update({
    where: { id: existing.id },
    data:  {
      templateVersionId: renderSource === 'current' ? existing.template.currentVersionId : null,
    },
    include: EVENT_INCLUDE,
  });
  await prisma.eventRenderCache.deleteMany({ where: { eventId: event.id } });

  res.json({ ok: true, event: shapeEvent(event), urls: buildUrls(event) });
}

// POST /api/v1/testing/session
// Mint a short-lived user JWT so the admin can open the user app already signed
// in. Narrow by construction: 400s unless the target is the flagged test
// account, which owns no real data and is blocked from checkout.
async function createSession(req, res) {
  const user = await findTestUser();
  if (!user) return res.status(404).json({ ok: false, message: 'Test account has not been created yet' });
  if (!user.isTestAccount) {
    return res.status(400).json({ ok: false, message: 'Refusing to mint a session for a non-test account' });
  }

  const token = jwt.sign(
    {
      role: 'user',
      id: user.id,
      username: user.username,
      email: user.email,
      pv: passwordVersion(user.passwordHash),
    },
    userJwtSecret(),
    { expiresIn: '30m', issuer: 'aamantran:user' }
  );

  res.json({
    ok: true,
    token,
    expiresIn: 1800,
    dashboardUrl: siteUrls.coupleDashboardUrl(),
  });
}

// POST /api/v1/testing/reset
// Wipe with no replacement — releases the template for deletion and version cleanup.
async function reset(req, res) {
  const user = await findTestUser();
  if (!user) return res.status(404).json({ ok: false, message: 'Test account has not been created yet' });

  const cleared = await purgeTestEvents(user.id);
  res.json({ ok: true, cleared });
}

/* ── Template Lab developer accounts ──────────────────────────────────────
 *
 * The Lab is used by external contractors, so credentials are issued and
 * revoked here rather than over a shell. Passwords are shown exactly once at
 * creation or rotation and are never retrievable afterwards.
 */

// GET /api/v1/testing/developers
async function listDevelopers(_req, res) {
  const developers = await prisma.developerAccount.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, handle: true, email: true,
      isActive: true, templateLimit: true, lastLoginAt: true, createdAt: true,
      _count: { select: { templates: true } },
    },
  });

  const api = siteUrls.apiBaseUrl();
  res.json({
    ok: true,
    labUrl: siteUrls.labUrl(),
    developers: developers.map((d) => ({
      ...d,
      templateCount: d._count.templates,
      _count: undefined,
      inviteUrl: `${api}/i/lab-${d.handle}`,
    })),
  });
}

// POST /api/v1/testing/developers
// Body: { email, name, handle, password?, templateLimit? }
// Returns the plaintext password exactly once.
async function createDeveloperAccount(req, res) {
  const { email, name, handle, password, templateLimit } = req.body || {};
  const { developer, generatedPassword } = await createDeveloper({
    email, name, handle, password, templateLimit,
  });
  res.status(201).json({
    ok: true,
    developer,
    generatedPassword,
    labUrl: siteUrls.labUrl(),
    inviteUrl: `${siteUrls.apiBaseUrl()}/i/lab-${developer.handle}`,
  });
}

// POST /api/v1/testing/developers/:handle/rotate-password   Body: { password? }
async function rotateDeveloper(req, res) {
  const { password } = req.body || {};
  const { developer, generatedPassword } = await rotateDeveloperPassword(req.params.handle, password);
  res.json({
    ok: true,
    developer: { id: developer.id, handle: developer.handle },
    generatedPassword,
  });
}

// PATCH /api/v1/testing/developers/:handle/active   Body: { isActive }
// devAuth re-reads this flag on every request, so revocation is immediate.
async function setDeveloperAccess(req, res) {
  const { isActive } = req.body || {};
  const developer = await setDeveloperActive(req.params.handle, isActive);
  res.json({ ok: true, developer });
}

// DELETE /api/v1/testing/developers/:handle
// Removes the developer, their sandbox templates (FK cascade), the paired
// sandbox user, and the uploaded template folders.
//
// Storage is collected BEFORE the cascade runs: once the Template rows are
// gone there is nothing left pointing at those folders, and they would sit in
// the bucket forever with no way to attribute them.
async function removeDeveloper(req, res) {
  const key = String(req.params.handle || '').trim().toLowerCase();
  const dev = await prisma.developerAccount.findFirst({
    where:  { OR: [{ handle: key }, { email: key }] },
    select: { id: true, handle: true, sandboxUserId: true },
  });
  if (!dev) return res.status(404).json({ ok: false, message: 'Developer not found' });

  const templates = await prisma.template.findMany({
    where:  { sandboxOwnerId: dev.id },
    select: { slug: true, folderPath: true },
  });

  // The sandbox event references a template, so it has to go before the
  // cascade removes them.
  const cleared = await purgeTestEvents(dev.sandboxUserId);
  await prisma.developerAccount.delete({ where: { id: dev.id } });
  await prisma.user.delete({ where: { id: dev.sandboxUserId } });

  // After the rows are committed: a storage failure must not leave a
  // half-deleted account behind, so these are best-effort.
  let foldersRemoved = 0;
  for (const t of templates) {
    for (const folder of [draftFolderName(t.slug), t.folderPath]) {
      try {
        await deleteTemplateFolder(folder);
        foldersRemoved += 1;
      } catch (err) {
        console.error(`[testing] could not delete template folder ${folder}:`, err.message);
      }
    }
  }

  res.json({ ok: true, cleared, templates: templates.length, foldersRemoved });
}

module.exports = {
  status,
  ensureAccount,
  rotate,
  loadTemplate,
  setPublished,
  repin,
  createSession,
  reset,
  listDevelopers,
  createDeveloperAccount,
  rotateDeveloper,
  setDeveloperAccess,
  removeDeveloper,
};
