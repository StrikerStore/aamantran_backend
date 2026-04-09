const prisma       = require('../utils/prisma');
const slugify      = require('../utils/slugify');
const generateId   = require('../utils/generateId');
const { extractTemplateZip, deleteTemplateFolder, saveThumbnail } = require('../services/fileManager');
const siteUrls = require('../config/siteUrls');

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
    },
  });
  res.json({ ok: true, data: template });
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

  // Extract uploaded zip into storage/templates/{slug}/
  const entryFiles = await extractTemplateZip(zipFile.path, folderPath);

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
            functions: {
              create: (parsedDemo.functions || []).map((fn, i) => ({
                name:         fn.name,
                date:         fn.date,
                time:         fn.time,
                venueName:    fn.venue_name,
                venueAddress: fn.venue_address || null,
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
    const entryFiles = await extractTemplateZip(zipFile.path, template.folderPath);
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
      people:       demo.people        || [],
      customFields: demo.custom_fields || [],
      functions: {
        create: (demo.functions || []).map((fn, i) => ({
          name:         fn.name,
          date:         fn.date,
          time:         fn.time,
          venueName:    fn.venue_name,
          venueAddress: fn.venue_address || null,
          sortOrder:    fn.sort_order ?? i,
        })),
      },
    },
    include: { functions: { orderBy: { sortOrder: 'asc' } } },
  });

  res.json({ ok: true, data: updated });
}

// PATCH /api/v1/templates/:id/publish
async function publish(req, res) {
  const template = await prisma.template.update({
    where: { id: req.params.id },
    data:  { isActive: true },
  });
  res.json({ ok: true, data: template });
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

module.exports = { list, get, create, update, updateFiles, updateDemoData, publish, draft, remove };
