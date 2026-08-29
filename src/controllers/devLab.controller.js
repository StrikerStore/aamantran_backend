/**
 * Template Lab — endpoints for external template developers.
 *
 * The whole design rests on two facts that already existed:
 *   - `Event.templateVersionId = null` makes routes/render.js fall through to
 *     `templates/{slug}/draft/`, which every ZIP re-upload rewrites. Sandbox
 *     events are therefore *never* pinned to a version, which is what makes the
 *     dev loop "re-upload the ZIP, refresh the tab" with no reload step.
 *   - The sandbox owner is a normal User flagged `isTestAccount`, so every
 *     filter in utils/testFilters.js already keeps this data out of analytics,
 *     revenue, cron jobs and DPDP retention.
 *
 * Every query is scoped by `req.dev.id`. Template ids arriving in a URL are
 * always looked up together with `sandboxOwnerId`, so one developer can never
 * read or overwrite another's folder.
 */
const prisma   = require('../utils/prisma');
const slugify  = require('../utils/slugify');
const siteUrls = require('../config/siteUrls');
const { generateId } = require('../utils/generateId');
const { extractTemplateZip, draftFolderName, deleteTemplateFolder } = require('../services/fileManager');
const { mintInvitePreviewToken } = require('../services/previewToken');
const { purgeTestEvents } = require('../services/testAccount.service');
const { PRESETS, seedSandboxContent, musicSlotKey } = require('../services/sandboxSeed.service');
const { checkSchemaAgainstHtml } = require('../services/templateIntrospect.service');

const DEFAULT_PRESET = 'full';

/* ── Shared shapes ──────────────────────────────────────────────────────── */

const TEMPLATE_SELECT = {
  id: true, slug: true, name: true, folderPath: true,
  desktopEntryFile: true, mobileEntryFile: true,
  fieldSchema: true, createdAt: true, updatedAt: true,
};

function buildUrls(event) {
  if (!event) return {};
  const api = siteUrls.apiBaseUrl();
  const slug = encodeURIComponent(event.slug);
  return {
    invite:  `${api}/i/${slug}`,
    // Signed preview means the developer never has to publish to see their work.
    preview: `${api}/i/${slug}/preview?pt=${encodeURIComponent(mintInvitePreviewToken(event.slug))}`,
    mobile:  `${api}/i/${slug}/preview?view=mobile&pt=${encodeURIComponent(mintInvitePreviewToken(event.slug))}`,
    desktop: `${api}/i/${slug}/preview?view=desktop&pt=${encodeURIComponent(mintInvitePreviewToken(event.slug))}`,
  };
}

function shapeEvent(event) {
  if (!event) return null;
  return {
    id:          event.id,
    slug:        event.slug,
    isPublished: event.isPublished,
    groomName:   event.groomName,
    brideName:   event.brideName,
    template:    event.template
      ? { id: event.template.id, name: event.template.name, slug: event.template.slug }
      : null,
    rsvpEnabled:       event.rsvpEnabled,
    guestNotesEnabled: event.guestNotesEnabled,
    counts: event._count || null,
  };
}

/** The developer's template, or a 404 — never resolvable across accounts. */
async function ownedTemplate(devId, templateId) {
  const template = await prisma.template.findFirst({
    where:  { id: String(templateId), sandboxOwnerId: devId },
    select: { ...TEMPLATE_SELECT, sandboxOwnerId: true },
  });
  if (!template) {
    const err = new Error('Template not found in your sandbox');
    err.status = 404;
    throw err;
  }
  return template;
}

/** The developer's single sandbox event, if a template has been activated. */
function findSandboxEvent(dev) {
  return prisma.event.findFirst({
    where:   { ownerId: dev.sandboxUserId },
    include: { template: { select: { id: true, name: true, slug: true, fieldSchema: true } } },
  });
}

/**
 * Point the sandbox at a template and fill it with content.
 *
 * Delete-and-recreate rather than mutate — the same approach
 * testing.controller.loadTemplate uses, so no counter or flag can survive a
 * reseed and no enumeration rots when a column is added.
 */
async function activateTemplate(dev, template, { preset = DEFAULT_PRESET, musicUrl = null, publish = false } = {}) {
  await purgeTestEvents(dev.sandboxUserId);

  const event = await prisma.event.create({
    data: {
      slug:              `lab-${dev.handle}`,
      ownerId:           dev.sandboxUserId,
      templateId:        template.id,
      // Never pinned: this is what makes a ZIP re-upload show up on refresh.
      templateVersionId: null,
      community:         'universal',
      eventType:         'wedding',
      language:          'en',
      namesAreFrozen:    false,
      isPublished:       Boolean(publish),
      isTestEvent:       true,
    },
  });

  const seeded = await seedSandboxContent({
    eventId:     event.id,
    fieldSchema: template.fieldSchema,
    preset,
    musicUrl,
  });

  // Seeding writes names and toggles onto the event, so re-read it — returning
  // the pre-seed row would hand the Lab a half-empty object to render.
  const fresh = await prisma.event.findUnique({
    where:   { id: event.id },
    include: { template: { select: { id: true, name: true, slug: true } } },
  });

  return { event: fresh, seeded };
}

/* ── Templates ──────────────────────────────────────────────────────────── */

// GET /api/dev/templates
async function listTemplates(req, res) {
  const [templates, activeEvent, dev] = await Promise.all([
    prisma.template.findMany({
      where:   { sandboxOwnerId: req.dev.id },
      orderBy: { updatedAt: 'desc' },
      select:  TEMPLATE_SELECT,
    }),
    findSandboxEvent(req.dev),
    prisma.developerAccount.findUnique({
      where:  { id: req.dev.id },
      select: { templateLimit: true },
    }),
  ]);

  res.json({
    ok: true,
    templates: templates.map((t) => ({
      ...t,
      isActive: activeEvent?.templateId === t.id,
      hasSchema: Boolean(t.fieldSchema),
    })),
    limit: dev?.templateLimit ?? 0,
    event: shapeEvent(activeEvent),
    urls:  buildUrls(activeEvent),
  });
}

// POST /api/dev/templates   multipart: templateZip, name?, fieldSchema?
async function createTemplate(req, res) {
  const zipFile = req.files?.templateZip?.[0] || req.file;
  if (!zipFile) {
    return res.status(400).json({ ok: false, message: 'templateZip file is required' });
  }

  const dev = await prisma.developerAccount.findUnique({
    where:  { id: req.dev.id },
    select: { templateLimit: true, handle: true },
  });
  const used = await prisma.template.count({ where: { sandboxOwnerId: req.dev.id } });
  if (used >= dev.templateLimit) {
    return res.status(409).json({
      ok: false,
      message: `Sandbox limit reached (${dev.templateLimit} templates). Delete one before uploading another.`,
    });
  }

  const rawName = String(req.body?.name || '').trim()
    || String(zipFile.originalname || 'template').replace(/\.zip$/i, '');
  const name = rawName.slice(0, 80);

  let fieldSchema = null;
  if (req.body?.fieldSchema) {
    try {
      fieldSchema = JSON.parse(req.body.fieldSchema);
    } catch {
      return res.status(400).json({ ok: false, message: 'fieldSchema is not valid JSON' });
    }
  }

  // `lab-` prefix keeps sandbox folders and slugs obvious in storage listings.
  const slug = `lab-${dev.handle}-${slugify(name)}-${generateId()}`;
  const entryFiles = await extractTemplateZip(zipFile.path, draftFolderName(slug));

  const template = await prisma.template.create({
    data: {
      slug,
      name,
      folderPath:       slug,
      desktopEntryFile: entryFiles.desktopEntryFile,
      mobileEntryFile:  entryFiles.mobileEntryFile,
      community:        'universal',
      bestFor:          'Wedding',
      languages:        'en',
      // Sandbox templates are never sellable: zero price, never active, and the
      // catalogue queries additionally filter on sandboxOwnerId.
      price:            0,
      aboutText:        'Template Lab sandbox upload — not for sale.',
      isActive:         false,
      fieldSchema,
      sandboxOwnerId:   req.dev.id,
    },
    select: TEMPLATE_SELECT,
  });

  // First upload activates immediately — a developer should get a working link
  // from one action, not two.
  const { event, seeded } = await activateTemplate(req.dev, { ...template, fieldSchema });

  const analysis = await checkSchemaAgainstHtml({ ...template, fieldSchema }, fieldSchema);

  res.status(201).json({
    ok: true,
    template: { ...template, isActive: true },
    event: shapeEvent(event),
    urls:  buildUrls(event),
    seeded,
    analysis,
  });
}

// PUT /api/dev/templates/:id/files   multipart: templateZip
// The dev loop: re-extract over the same draft folder, keep all seeded content.
async function replaceFiles(req, res) {
  const template = await ownedTemplate(req.dev.id, req.params.id);
  const zipFile = req.files?.templateZip?.[0] || req.file;
  if (!zipFile) {
    return res.status(400).json({ ok: false, message: 'templateZip file is required' });
  }

  const entryFiles = await extractTemplateZip(zipFile.path, draftFolderName(template.slug));

  const updated = await prisma.template.update({
    where: { id: template.id },
    data:  {
      desktopEntryFile: entryFiles.desktopEntryFile,
      mobileEntryFile:  entryFiles.mobileEntryFile,
    },
    select: TEMPLATE_SELECT,
  });

  // Render cache is keyed per event; drop it so the refresh really shows the
  // new bundle rather than a cached page.
  const event = await findSandboxEvent(req.dev);
  if (event) await prisma.eventRenderCache.deleteMany({ where: { eventId: event.id } });

  const analysis = await checkSchemaAgainstHtml(updated, updated.fieldSchema);

  res.json({ ok: true, template: updated, urls: buildUrls(event), entryFiles, analysis });
}

// GET /api/dev/templates/:id/schema
async function getSchema(req, res) {
  const template = await ownedTemplate(req.dev.id, req.params.id);
  res.json({ ok: true, fieldSchema: template.fieldSchema || null });
}

// PUT /api/dev/templates/:id/schema   Body: { fieldSchema }
// Saving re-derives the seeded custom values, so a newly declared key is filled
// in on the next refresh without the developer touching anything else.
async function putSchema(req, res) {
  const template = await ownedTemplate(req.dev.id, req.params.id);

  let { fieldSchema } = req.body || {};
  if (typeof fieldSchema === 'string') {
    try {
      fieldSchema = JSON.parse(fieldSchema);
    } catch {
      return res.status(400).json({ ok: false, message: 'fieldSchema is not valid JSON' });
    }
  }
  if (fieldSchema != null && (typeof fieldSchema !== 'object' || Array.isArray(fieldSchema))) {
    return res.status(400).json({ ok: false, message: 'fieldSchema must be a JSON object' });
  }
  for (const key of ['people', 'customFields', 'mediaSlots']) {
    if (fieldSchema?.[key] != null && !Array.isArray(fieldSchema[key])) {
      return res.status(400).json({ ok: false, message: `fieldSchema.${key} must be an array` });
    }
  }

  await prisma.template.update({
    where: { id: template.id },
    data:  { fieldSchema: fieldSchema ?? null },
  });

  // The whole point of saving a schema is to make the template's own keys
  // resolve, so this is where a mismatch between the two is worth surfacing.
  const analysis = await checkSchemaAgainstHtml({ ...template, fieldSchema }, fieldSchema);

  const event = await findSandboxEvent(req.dev);
  let reseeded = null;
  if (event?.templateId === template.id) {
    const preset = String(req.body?.preset || DEFAULT_PRESET);
    const musicUrl = await currentMusicUrl(event.id);
    const result = await activateTemplate(req.dev, { ...template, fieldSchema }, { preset, musicUrl });
    reseeded = result.seeded;
    return res.json({ ok: true, fieldSchema, reseeded, analysis, urls: buildUrls(result.event) });
  }

  res.json({ ok: true, fieldSchema, reseeded, analysis });
}

// POST /api/dev/templates/:id/activate   Body: { preset?, musicUrl?, publish? }
async function activate(req, res) {
  const template = await ownedTemplate(req.dev.id, req.params.id);
  const { preset = DEFAULT_PRESET, musicUrl = null, publish = false } = req.body || {};

  const { event, seeded } = await activateTemplate(req.dev, template, { preset, musicUrl, publish });
  res.json({ ok: true, event: shapeEvent(event), urls: buildUrls(event), seeded });
}

// DELETE /api/dev/templates/:id
async function removeTemplate(req, res) {
  const template = await ownedTemplate(req.dev.id, req.params.id);

  // Events reference the template, so the sandbox event must go first.
  const event = await findSandboxEvent(req.dev);
  if (event?.templateId === template.id) await purgeTestEvents(req.dev.sandboxUserId);

  await prisma.template.delete({ where: { id: template.id } });
  await deleteTemplateFolder(template.folderPath).catch(() => {});
  await deleteTemplateFolder(draftFolderName(template.slug)).catch(() => {});

  res.json({ ok: true });
}

/* ── Sandbox content ────────────────────────────────────────────────────── */

/** The music track currently seeded, so a reseed doesn't silently drop it. */
async function currentMusicUrl(eventId) {
  const row = await prisma.media.findFirst({
    where:  { eventId, type: 'music' },
    select: { url: true },
  });
  return row?.url || null;
}

// GET /api/dev/sandbox
async function getSandbox(req, res) {
  const event = await findSandboxEvent(req.dev);
  if (!event) {
    return res.json({ ok: true, event: null, urls: {}, presets: PRESETS });
  }

  const [people, functions, customFields, media] = await Promise.all([
    prisma.eventPerson.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: 'asc' } }),
    prisma.function.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: 'asc' } }),
    prisma.eventCustomField.findMany({ where: { eventId: event.id } }),
    prisma.media.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: 'asc' } }),
  ]);

  res.json({
    ok: true,
    event: shapeEvent(event),
    urls:  buildUrls(event),
    presets: PRESETS,
    content: {
      links: {
        instagramUrl:     event.instagramUrl,
        instagramHashtag: event.instagramHashtag,
        socialYoutubeUrl: event.socialYoutubeUrl,
        websiteUrl:       event.websiteUrl,
      },
      toggles: { rsvpEnabled: event.rsvpEnabled, guestNotesEnabled: event.guestNotesEnabled },
      people, functions, customFields, media,
    },
  });
}

// PUT /api/dev/sandbox
// Body: { groomName?, brideName?, links?, toggles?, customFields?, musicUrl?, publish? }
async function putSandbox(req, res) {
  const event = await findSandboxEvent(req.dev);
  if (!event) {
    return res.status(404).json({ ok: false, message: 'No template is active in your sandbox yet' });
  }

  const { groomName, brideName, links = {}, toggles = {}, customFields, musicUrl, publish } = req.body || {};

  const data = {};
  if (groomName !== undefined) data.groomName = String(groomName).slice(0, 120) || null;
  if (brideName !== undefined) data.brideName = String(brideName).slice(0, 120) || null;

  // The renderer reads {{groom_name}} from the Event column but {{person_name}}
  // and {{#person}} from the people rows, so both have to move together or the
  // template shows two different names for the same person.
  for (const [role, value] of [['groom', groomName], ['bride', brideName]]) {
    if (value === undefined) continue;
    await prisma.eventPerson.updateMany({
      where: { eventId: event.id, role },
      data:  { name: String(value).slice(0, 120) },
    });
  }
  if (links.instagramUrl     !== undefined) data.instagramUrl     = String(links.instagramUrl || '') || null;
  if (links.socialYoutubeUrl !== undefined) data.socialYoutubeUrl = String(links.socialYoutubeUrl || '') || null;
  if (links.websiteUrl       !== undefined) data.websiteUrl       = String(links.websiteUrl || '') || null;
  if (links.instagramHashtag !== undefined) {
    // Stored bare — templates render {{hashtag_raw}} and add the "#" themselves.
    data.instagramHashtag = String(links.instagramHashtag || '').replace(/^#+/, '').slice(0, 120) || null;
  }
  if (toggles.rsvpEnabled       !== undefined) data.rsvpEnabled       = Boolean(toggles.rsvpEnabled);
  if (toggles.guestNotesEnabled !== undefined) data.guestNotesEnabled = Boolean(toggles.guestNotesEnabled);
  if (publish !== undefined) data.isPublished = Boolean(publish);

  if (Object.keys(data).length) {
    await prisma.event.update({ where: { id: event.id }, data });
  }

  if (Array.isArray(customFields)) {
    for (const row of customFields) {
      const key = String(row?.fieldKey || '').trim();
      if (!key) continue;
      await prisma.eventCustomField.upsert({
        where:  { eventId_fieldKey: { eventId: event.id, fieldKey: key } },
        update: { fieldValue: String(row.fieldValue ?? '') },
        create: {
          eventId: event.id, fieldKey: key,
          fieldValue: String(row.fieldValue ?? ''),
          fieldType: String(row.fieldType || 'text'),
        },
      });
    }
  }

  if (musicUrl !== undefined) {
    await prisma.media.deleteMany({ where: { eventId: event.id, type: 'music' } });
    if (musicUrl) {
      await prisma.media.create({
        data: {
          eventId: event.id, type: 'music', url: String(musicUrl), caption: '',
          slotKey: musicSlotKey(event.template?.fieldSchema), sortOrder: 0,
        },
      });
    }
  }

  await prisma.eventRenderCache.deleteMany({ where: { eventId: event.id } });

  const fresh = await findSandboxEvent(req.dev);
  res.json({ ok: true, event: shapeEvent(fresh), urls: buildUrls(fresh) });
}

// POST /api/dev/sandbox/preset   Body: { preset }
async function applyPreset(req, res) {
  const preset = String(req.body?.preset || '');
  if (!PRESETS[preset]) {
    return res.status(400).json({
      ok: false,
      message: `Unknown preset. Valid: ${Object.keys(PRESETS).join(', ')}`,
    });
  }

  const event = await findSandboxEvent(req.dev);
  if (!event) {
    return res.status(404).json({ ok: false, message: 'No template is active in your sandbox yet' });
  }

  const template = await ownedTemplate(req.dev.id, event.templateId);
  const musicUrl = preset === 'no-media' ? null : await currentMusicUrl(event.id);
  const wasPublished = event.isPublished;

  const result = await activateTemplate(req.dev, template, { preset, musicUrl, publish: wasPublished });

  res.json({
    ok: true,
    preset,
    hint:   PRESETS[preset].hint,
    event:  shapeEvent(result.event),
    urls:   buildUrls(result.event),
    seeded: result.seeded,
  });
}

// POST /api/dev/sandbox/reset — purge and reseed from scratch.
async function resetSandbox(req, res) {
  const event = await findSandboxEvent(req.dev);
  if (!event) {
    const cleared = await purgeTestEvents(req.dev.sandboxUserId);
    return res.json({ ok: true, cleared, event: null, urls: {} });
  }

  const template = await ownedTemplate(req.dev.id, event.templateId);
  const result = await activateTemplate(req.dev, template, { preset: DEFAULT_PRESET });

  res.json({ ok: true, event: shapeEvent(result.event), urls: buildUrls(result.event), seeded: result.seeded });
}

/* ── Assets ─────────────────────────────────────────────────────────────── */

// GET /api/dev/assets — the shared background-music library.
async function listAssets(_req, res) {
  const assets = await prisma.globalAsset.findMany({
    orderBy: { createdAt: 'desc' },
    select:  { id: true, type: true, name: true, url: true },
  });
  res.json({ ok: true, assets });
}

module.exports = {
  listTemplates,
  createTemplate,
  replaceFiles,
  getSchema,
  putSchema,
  activate,
  removeTemplate,
  getSandbox,
  putSandbox,
  applyPreset,
  resetSandbox,
  listAssets,
};
