const path         = require('path');
const fs           = require('fs');
const prisma       = require('../utils/prisma');
const slugify      = require('../utils/slugify');
const generateId   = require('../utils/generateId');
const {
  extractTemplateZip,
  snapshotDraftToVersion,
  draftFolderName,
  deleteTemplateFolder,
  saveThumbnail,
} = require('../services/fileManager');
const siteUrls     = require('../config/siteUrls');
const storage      = require('../config/storage');
const objectStorage = require('../services/objectStorage');

// GET /api/v1/templates
async function list(req, res) {
  const { status, community, eventType, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = {};
  if (status === 'active') where.isActive = true;
  if (status === 'draft')  where.isActive = false;
  if (community)           where.community = community;
  // Filter by event type: bestFor is a comma-separated string, use contains
  if (eventType)           where.bestFor = { contains: eventType };

  const [templates, total] = await Promise.all([
    prisma.template.findMany({
      where,
      skip,
      take:    Number(limit),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, slug: true, name: true,
        thumbnailUrl: true, desktopThumbnailUrl: true, mobileThumbnailUrl: true, community: true,
        desktopEntryFile: true, mobileEntryFile: true,
        bestFor: true, languages: true,
        price: true, originalPrice: true,
        isActive: true, buyerCount: true, avgRating: true,
        gstPercent: true, fieldSchema: true, releasedAt: true, createdAt: true,
      },
    }),
    prisma.template.count({ where }),
  ]);

  res.json({ ok: true, data: templates, total, page: Number(page), limit: Number(limit) });
}

// GET /api/v1/templates/:id
async function get(req, res) {
  const template = await prisma.template.findUniqueOrThrow({
    where: { id: req.params.id },
    include: {
      demoData: { include: { functions: { orderBy: { sortOrder: 'asc' } } } },
      reviews:  { include: { user: { select: { username: true, email: true } } }, orderBy: { createdAt: 'desc' } },
      currentVersion: true,
      versions:       { orderBy: { versionNumber: 'desc' }, select: { id: true, versionNumber: true, createdAt: true } },
    },
  });

  // Count events pinned to each version (after publish-changes, typically all on current).
  const versionCounts = await prisma.event.groupBy({
    by: ['templateVersionId'],
    where: { templateId: template.id },
    _count: { _all: true },
  });
  const countByVersion = Object.fromEntries(versionCounts.map(r => [r.templateVersionId, r._count._all]));
  const versionsWithCounts = template.versions.map(v => ({
    ...v,
    eventCount: countByVersion[v.id] || 0,
    isCurrent:  v.id === template.currentVersionId,
  }));

  res.json({ ok: true, data: { ...template, versions: versionsWithCounts } });
}

// POST /api/v1/templates   (multipart: templateZip + desktop/mobile thumbnail files + JSON body fields)
async function create(req, res) {
  const { name, community, bestFor, languages, style, colourPalette, animations,
          price, originalPrice, gstPercent, aboutText, demoData } = req.body;

  if (!name || !community || !price || !aboutText) {
    return res.status(400).json({ ok: false, message: 'name, community, price, aboutText are required' });
  }
  const zipFile = req.files?.templateZip?.[0];
  const desktopThumbFile = req.files?.desktopThumbnailImage?.[0] || req.files?.thumbnailImage?.[0];
  const mobileThumbFile = req.files?.mobileThumbnailImage?.[0];

  if (!zipFile) {
    return res.status(400).json({ ok: false, message: 'templateZip file is required' });
  }

  const slug       = `${slugify(name)}-${generateId()}`;
  const folderPath = slug;

  // New templates start life as a draft. /demo reads from here; publishing
  // snapshots it into v1/.
  const entryFiles = await extractTemplateZip(zipFile.path, draftFolderName(slug));

  // Save thumbnails if provided
  let thumbnailUrl = null;
  let desktopThumbnailUrl = null;
  let mobileThumbnailUrl = null;
  if (desktopThumbFile) {
    desktopThumbnailUrl = await saveThumbnail(desktopThumbFile.path, folderPath, desktopThumbFile.originalname, 'desktop');
    thumbnailUrl = desktopThumbnailUrl; // Backward compatibility with existing frontend usage
  }
  if (mobileThumbFile) {
    mobileThumbnailUrl = await saveThumbnail(mobileThumbFile.path, folderPath, mobileThumbFile.originalname, 'mobile');
  }

  // Build demo data rows if provided
  const parsedDemo = demoData ? JSON.parse(demoData) : null;

  const template = await prisma.template.create({
    data: {
      slug,
      name,
      folderPath,
      thumbnailUrl,
      desktopThumbnailUrl,
      mobileThumbnailUrl,
      desktopEntryFile: entryFiles.desktopEntryFile,
      mobileEntryFile: entryFiles.mobileEntryFile,
      community,
      bestFor:       bestFor       || '',
      languages:     languages     || 'en',
      style:         style         || null,
      colourPalette: colourPalette || null,
      animations:    animations    || null,
      price:         Number(price),
      originalPrice: originalPrice ? Number(originalPrice) : null,
      gstPercent:    Number(gstPercent || 0),
      aboutText,
      isActive:      false,
      fieldSchema:   parsedDemo?.field_schema || null,
      ...(parsedDemo && {
        demoData: {
          create: {
            brideName:    parsedDemo.bride_name    || '',
            groomName:    parsedDemo.groom_name    || '',
            weddingDate:  parsedDemo.wedding_date  || '',
            venueName:    parsedDemo.venue_name    || '',
            venueAddress: parsedDemo.venue_address || null,
            photoUrls:    parsedDemo.photo_urls || [],
            musicUrl:     parsedDemo.music_url  || null,
            language:     parsedDemo.language   || 'en',
            people:       parsedDemo.people     || [],
            customFields: parsedDemo.custom_fields || [],
            mediaSlotDemoUrls: parsedDemo.media_slot_demo_urls || null,
            instagramUrl:      parsedDemo.instagram_url      || null,
            socialYoutubeUrl:  parsedDemo.social_youtube_url || null,
            websiteUrl:        parsedDemo.website_url        || null,
            rsvpEnabled:       parsedDemo.rsvp_enabled       !== undefined ? Boolean(parsedDemo.rsvp_enabled)       : true,
            guestNotesEnabled: parsedDemo.guest_notes_enabled !== undefined ? Boolean(parsedDemo.guest_notes_enabled) : true,
            functions: {
              create: (parsedDemo.functions || []).map((fn, i) => ({
                name:         fn.name,
                date:         fn.date,
                time:         fn.time,
                venueName:    fn.venue_name,
                venueAddress: fn.venue_address || null,
                venueMapUrl:  fn.venue_map_url || null,
                dressCode:    fn.dress_code    || null,
                sortOrder:    fn.sort_order ?? i,
              })),
            },
          },
        },
      }),
    },
    include: { demoData: { include: { functions: true } } },
  });

  res.status(201).json({
    ok:      true,
    data:    template,
    demoUrl: `${siteUrls.apiBaseUrl()}/demo/${slug}`,
  });
}

// PUT /api/v1/templates/:id  (optional desktop/mobile thumbnail files upload)
async function update(req, res) {
  const { name, community, bestFor, languages, style, colourPalette, animations,
          price, originalPrice, gstPercent, aboutText } = req.body;

  // Save new thumbnail(s) if uploaded
  let thumbnailUrl;
  let desktopThumbnailUrl;
  let mobileThumbnailUrl;
  const desktopThumbFile = req.files?.desktopThumbnailImage?.[0] || req.files?.thumbnailImage?.[0];
  const mobileThumbFile = req.files?.mobileThumbnailImage?.[0];
  if (desktopThumbFile || mobileThumbFile) {
    const tpl = await prisma.template.findUniqueOrThrow({ where: { id: req.params.id } });
    if (desktopThumbFile) {
      desktopThumbnailUrl = await saveThumbnail(desktopThumbFile.path, tpl.folderPath, desktopThumbFile.originalname, 'desktop');
      thumbnailUrl = desktopThumbnailUrl; // Backward compatibility
    }
    if (mobileThumbFile) {
      mobileThumbnailUrl = await saveThumbnail(mobileThumbFile.path, tpl.folderPath, mobileThumbFile.originalname, 'mobile');
    }
  }

  const template = await prisma.template.update({
    where: { id: req.params.id },
    data: {
      ...(name          && { name }),
      ...(community     && { community }),
      ...(bestFor       !== undefined && { bestFor }),
      ...(languages     !== undefined && { languages }),
      ...(style         !== undefined && { style }),
      ...(colourPalette !== undefined && { colourPalette }),
      ...(animations    !== undefined && { animations }),
      ...(price         && { price: Number(price) }),
      ...(originalPrice !== undefined && { originalPrice: originalPrice ? Number(originalPrice) : null }),
      ...(gstPercent    !== undefined && { gstPercent: Number(gstPercent || 0) }),
      ...(aboutText     && { aboutText }),
      ...(thumbnailUrl  !== undefined && { thumbnailUrl }),
      ...(desktopThumbnailUrl !== undefined && { desktopThumbnailUrl }),
      ...(mobileThumbnailUrl !== undefined && { mobileThumbnailUrl }),
    },
  });
  res.json({ ok: true, data: template });
}

// PUT /api/v1/templates/:id/files  (re-upload ZIP and/or desktop/mobile thumbnail)
async function updateFiles(req, res) {
  const zipFile = req.files?.templateZip?.[0];
  const desktopThumbFile = req.files?.desktopThumbnailImage?.[0] || req.files?.thumbnailImage?.[0];
  const mobileThumbFile = req.files?.mobileThumbnailImage?.[0];

  if (!zipFile && !desktopThumbFile && !mobileThumbFile) {
    return res.status(400).json({ ok: false, message: 'templateZip or desktop/mobile thumbnail file required' });
  }

  const template = await prisma.template.findUniqueOrThrow({ where: { id: req.params.id } });

  if (zipFile) {
    // Re-upload overwrites the draft only — existing published versions and the
    // Events pinned to them stay untouched. The admin promotes the new draft to
    // a version via POST /publish-changes when ready.
    const entryFiles = await extractTemplateZip(zipFile.path, draftFolderName(template.folderPath));
    await prisma.template.update({
      where: { id: template.id },
      data: {
        desktopEntryFile: entryFiles.desktopEntryFile,
        mobileEntryFile: entryFiles.mobileEntryFile,
      },
    });
  }

  let thumbnailUrl = template.thumbnailUrl;
  let desktopThumbnailUrl = template.desktopThumbnailUrl;
  let mobileThumbnailUrl = template.mobileThumbnailUrl;
  if (desktopThumbFile) {
    desktopThumbnailUrl = await saveThumbnail(desktopThumbFile.path, template.folderPath, desktopThumbFile.originalname, 'desktop');
    thumbnailUrl = desktopThumbnailUrl;
  }
  if (mobileThumbFile) {
    mobileThumbnailUrl = await saveThumbnail(mobileThumbFile.path, template.folderPath, mobileThumbFile.originalname, 'mobile');
  }
  if (desktopThumbFile || mobileThumbFile) {
    await prisma.template.update({
      where: { id: template.id },
      data: { thumbnailUrl, desktopThumbnailUrl, mobileThumbnailUrl },
    });
  }

  res.json({ ok: true, message: 'Template files updated', thumbnailUrl, desktopThumbnailUrl, mobileThumbnailUrl });
}

// PUT /api/v1/templates/:id/demo-data
async function updateDemoData(req, res) {
  const demo = req.body; // expects demo data + field_schema

  const template = await prisma.template.findUniqueOrThrow({
    where:   { id: req.params.id },
    include: { demoData: true },
  });

  if (template.demoData) {
    // Delete existing demo data (cascade deletes functions)
    await prisma.templateDemoData.delete({ where: { templateId: template.id } });
  }

  // Save fieldSchema on the template if provided
  if (demo.field_schema) {
    await prisma.template.update({
      where: { id: template.id },
      data:  { fieldSchema: demo.field_schema },
    });
  }

  const updated = await prisma.templateDemoData.create({
    data: {
      templateId:   template.id,
      brideName:    demo.bride_name    || '',
      groomName:    demo.groom_name    || '',
      weddingDate:  demo.wedding_date  || '',
      venueName:    demo.venue_name    || '',
      venueAddress: demo.venue_address || null,
      photoUrls:    demo.photo_urls    || [],
      musicUrl:     demo.music_url     || null,
      language:     demo.language      || 'en',
      people:           demo.people             || [],
      customFields:     demo.custom_fields      || [],
      mediaSlotDemoUrls: demo.media_slot_demo_urls || null,
      instagramUrl:      demo.instagram_url      || null,
      socialYoutubeUrl:  demo.social_youtube_url || null,
      websiteUrl:        demo.website_url        || null,
      rsvpEnabled:       demo.rsvp_enabled       !== undefined ? Boolean(demo.rsvp_enabled)       : true,
      guestNotesEnabled: demo.guest_notes_enabled !== undefined ? Boolean(demo.guest_notes_enabled) : true,
      functions: {
        create: (demo.functions || []).map((fn, i) => ({
          name:         fn.name,
          date:         fn.date,
          time:         fn.time,
          venueName:    fn.venue_name,
          venueAddress: fn.venue_address || null,
          venueMapUrl:  fn.venue_map_url || null,
          dressCode:    fn.dress_code    || null,
          sortOrder:    fn.sort_order ?? i,
        })),
      },
    },
    include: { functions: { orderBy: { sortOrder: 'asc' } } },
  });

  res.json({ ok: true, data: updated });
}

// DELETE /api/v1/templates/:id/thumbnail/:variant  (desktop | mobile)
async function deleteThumbnail(req, res) {
  const { variant } = req.params;
  const safeVariant = variant === 'mobile' ? 'mobile' : 'desktop';

  const template = await prisma.template.findUniqueOrThrow({ where: { id: req.params.id } });

  const urlToDelete = safeVariant === 'mobile'
    ? template.mobileThumbnailUrl
    : (template.desktopThumbnailUrl || template.thumbnailUrl);

  if (urlToDelete) {
    await objectStorage.tryDeletePublicUrl(urlToDelete).catch(() => {});
  }

  const updateData = safeVariant === 'mobile'
    ? { mobileThumbnailUrl: null }
    : { desktopThumbnailUrl: null, thumbnailUrl: null };

  await prisma.template.update({ where: { id: template.id }, data: updateData });
  res.json({ ok: true });
}

/**
 * Point every invitation on this template at the given version and clear render cache.
 * @returns {Promise<{ count: number }>}
 */
async function repointAllEventsToTemplateVersion(templateId, versionId) {
  const { count } = await prisma.event.updateMany({
    where: { templateId },
    data:  { templateVersionId: versionId },
  });
  await prisma.eventRenderCache.deleteMany({
    where: { event: { templateId } },
  });
  return { count };
}

/**
 * Create a new immutable version snapshot from the current draft folder,
 * then point Template.currentVersionId at it. Returns the new version row.
 *
 * Caller must ensure the draft has a template.zip (always true after
 * create/updateFiles — those store the uploaded zip inside draft/).
 */
async function _snapshotAndRegisterVersion(template) {
  const last = await prisma.templateVersion.findFirst({
    where:   { templateId: template.id },
    orderBy: { versionNumber: 'desc' },
    select:  { versionNumber: true },
  });
  const nextNumber = (last?.versionNumber || 0) + 1;

  const snap = await snapshotDraftToVersion(template.folderPath, nextNumber);

  const version = await prisma.templateVersion.create({
    data: {
      templateId:       template.id,
      versionNumber:    nextNumber,
      folderPath:       snap.folderPath,
      desktopEntryFile: snap.desktopEntryFile,
      mobileEntryFile:  snap.mobileEntryFile,
      fieldSchema:      template.fieldSchema ?? undefined,
    },
  });

  await prisma.template.update({
    where: { id: template.id },
    data:  { currentVersionId: version.id },
  });

  return version;
}

// PATCH /api/v1/templates/:id/publish
// First call: snapshots draft → v1 and activates. Subsequent calls: just
// flip isActive=true (re-activating a previously unpublished template
// without creating a new version). Use /publish-changes to snapshot.
async function publish(req, res) {
  const template = await prisma.template.findUniqueOrThrow({ where: { id: req.params.id } });

  if (!template.currentVersionId) {
    const version = await _snapshotAndRegisterVersion(template);
    await repointAllEventsToTemplateVersion(template.id, version.id);
  }

  const updated = await prisma.template.update({
    where: { id: template.id },
    data:  { isActive: true },
  });
  res.json({ ok: true, data: updated });
}

// POST /api/v1/templates/:id/publish-changes
// Snapshot current draft → v{n+1}, bump currentVersionId, repoint every Event
// on this template to the new version so live invites pick up the new bundle.
async function publishChanges(req, res) {
  const template = await prisma.template.findUniqueOrThrow({ where: { id: req.params.id } });

  if (!template.currentVersionId) {
    return res.status(409).json({
      ok: false,
      message: 'Template has no published version yet — use Publish instead.',
    });
  }

  const version = await _snapshotAndRegisterVersion(template);
  const { count } = await repointAllEventsToTemplateVersion(template.id, version.id);
  res.json({ ok: true, data: { version, eventsUpdated: count } });
}

// PATCH /api/v1/templates/:id/draft
async function draft(req, res) {
  const template = await prisma.template.update({
    where: { id: req.params.id },
    data:  { isActive: false },
  });
  res.json({ ok: true, data: template });
}

// DELETE /api/v1/templates/:id
async function remove(req, res) {
  const template = await prisma.template.findUniqueOrThrow({ where: { id: req.params.id } });

  const activeEvents = await prisma.event.count({ where: { templateId: template.id, isPublished: true } });
  if (activeEvents > 0) {
    return res.status(409).json({
      ok: false,
      message: `Cannot delete: ${activeEvents} published invitation(s) use this template`,
    });
  }

  await prisma.template.delete({ where: { id: req.params.id } });
  await deleteTemplateFolder(template.folderPath);

  res.json({ ok: true, message: 'Template deleted' });
}

/** Prisma/MySQL JSON may deserialize oddly; always merge as a plain object. */
function asMediaSlotDemoRecord(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return { ...raw };
}

// POST /api/v1/templates/:id/demo-media  — upload a file for a demo media slot
async function uploadDemoMedia(req, res) {
  const slotKey = req.body?.slotKey;
  if (!slotKey || typeof slotKey !== 'string') {
    return res.status(400).json({ ok: false, message: 'slotKey is required' });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'No file uploaded' });
  }

  const localPath = req.file.path;

  try {
    const template = await prisma.template.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { demoData: true },
    });

    const safeKey = slotKey.replace(/[^a-z0-9_]/g, '_');
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const filename = `${safeKey}-${Date.now()}${ext}`;

    let publicUrl;

    if (storage.useObjectStorage()) {
      const objectKey = `uploads/demo/${template.id}/${filename}`;
      const body = fs.readFileSync(localPath);
      const contentType = storage.contentTypeForPath(filename);
      await objectStorage.putObject(objectKey, body, contentType);
      publicUrl = `${storage.objectStoragePublicBase()}/${objectKey}`;
      fs.unlink(localPath, () => {});
    } else {
      publicUrl = `/uploads/${req.file.filename}`;
    }

    const existing = asMediaSlotDemoRecord(template.demoData?.mediaSlotDemoUrls);
    const slotData = existing[safeKey];

    let updated;
    if (Array.isArray(slotData)) {
      updated = { ...existing, [safeKey]: [...slotData, publicUrl] };
    } else if (slotData) {
      updated = { ...existing, [safeKey]: [slotData, publicUrl] };
    } else {
      updated = { ...existing, [safeKey]: [publicUrl] };
    }

    const jsonSafe = JSON.parse(JSON.stringify(updated));

    if (template.demoData) {
      await prisma.templateDemoData.update({
        where: { templateId: template.id },
        data: { mediaSlotDemoUrls: jsonSafe },
      });
    } else {
      await prisma.templateDemoData.create({
        data: {
          templateId: template.id,
          brideName: '', groomName: '', weddingDate: '', venueName: '',
          mediaSlotDemoUrls: jsonSafe,
        },
      });
    }

    res.json({ ok: true, url: publicUrl, mediaSlotDemoUrls: updated });
  } catch (err) {
    console.error('[uploadDemoMedia]', err);
    if (storage.useObjectStorage() && localPath && fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch (_) {
        /* ignore */
      }
    }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    const expose = process.env.NODE_ENV !== 'production';
    res.status(status).json({
      ok: false,
      message: expose ? err.message : 'Demo media upload failed',
    });
  }
}

// DELETE /api/v1/templates/:id/demo-media/:slotKey  — remove demo media for a slot
async function deleteDemoMedia(req, res) {
  const { slotKey } = req.params;
  const { url } = req.body || {};

  const template = await prisma.template.findUniqueOrThrow({
    where: { id: req.params.id },
    include: { demoData: true },
  });

  if (!template.demoData) {
    return res.status(404).json({ ok: false, message: 'No demo data' });
  }

  const existing = template.demoData.mediaSlotDemoUrls || {};
  const safeKey = slotKey.replace(/[^a-z0-9_]/g, '_');

  if (!existing[safeKey]) {
    return res.json({ ok: true, mediaSlotDemoUrls: existing });
  }

  let updated = { ...existing };

  if (url) {
    // Remove a specific URL from the array
    const arr = Array.isArray(existing[safeKey]) ? existing[safeKey] : [existing[safeKey]];
    const filtered = arr.filter(u => u !== url);
    if (filtered.length === 0) {
      delete updated[safeKey];
    } else {
      updated[safeKey] = filtered;
    }
    // Delete from R2/disk
    await objectStorage.tryDeletePublicUrl(url).catch(() => {});
  } else {
    // Remove all files for this slot
    const arr = Array.isArray(existing[safeKey]) ? existing[safeKey] : [existing[safeKey]];
    for (const u of arr) {
      await objectStorage.tryDeletePublicUrl(u).catch(() => {});
    }
    delete updated[safeKey];
  }

  await prisma.templateDemoData.update({
    where: { templateId: template.id },
    data: { mediaSlotDemoUrls: Object.keys(updated).length ? updated : null },
  });

  res.json({ ok: true, mediaSlotDemoUrls: updated });
}

module.exports = { list, get, create, update, updateFiles, updateDemoData, uploadDemoMedia, deleteDemoMedia, deleteThumbnail, publish, publishChanges, draft, remove };
