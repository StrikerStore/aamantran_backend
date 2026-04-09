const fs = require('fs/promises');
const {
  getMediaSlots,
  findSlot,
  assertUrlAllowed,
  mediaTypeForSlot,
  inferTypeFromFilename,
} = require('./mediaSlotUtils');
const siteUrls = require('../config/siteUrls');
const storage = require('../config/storage');
const objectStorage = require('./objectStorage');

function publicUploadUrl(req, eventId, filename) {
  if (storage.useObjectStorage()) {
    const key = `uploads/events/${eventId}/${filename}`;
    return `${storage.objectStoragePublicBase()}/${key}`;
  }
  const base = siteUrls.apiBaseUrl();
  if (base) return `${base}/uploads/${filename}`;
  return `${req.protocol}://${req.get('host')}/uploads/${filename}`;
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ eventId: string, expectedOwnerId: string, req: import('express').Request }} opts
 */
async function addEventMedia(prisma, { eventId, expectedOwnerId, req }) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, ownerId: true, template: { select: { fieldSchema: true } } },
  });
  if (!event || event.ownerId !== expectedOwnerId) {
    return { error: { status: 404, message: 'Event not found' } };
  }

  const hasFile = Boolean(req.file);
  let url = String((req.body && req.body.url) || '').trim();
  const caption =
    req.body && req.body.caption != null && String(req.body.caption).trim() !== ''
      ? String(req.body.caption)
      : null;
  let slotKey =
    req.body && req.body.slotKey != null && String(req.body.slotKey).trim()
      ? String(req.body.slotKey).trim()
      : null;
  let type = req.body && req.body.type ? String(req.body.type) : '';

  if (hasFile) {
    if (storage.useObjectStorage()) {
      const filename = req.file.filename;
      const key = `uploads/events/${event.id}/${filename}`;
      const buf = await fs.readFile(req.file.path);
      const ct = storage.contentTypeForPath(req.file.originalname || filename);
      await objectStorage.putObject(key, buf, ct);
      await fs.unlink(req.file.path).catch(() => {});
      url = publicUploadUrl(req, event.id, filename);
    } else {
      url = publicUploadUrl(req, event.id, req.file.filename);
    }
    if (!type) type = inferTypeFromFilename(req.file.originalname);
  }

  const slots = getMediaSlots(event.template?.fieldSchema);
  const slotDef = findSlot(slots, slotKey);

  if (slots && slots.length) {
    if (!slotKey || !slotDef) {
      return {
        error: { status: 400, message: 'slotKey is required and must match this template media sections' },
      };
    }
    const check = assertUrlAllowed(slotDef, url, hasFile);
    if (!check.ok) return { error: { status: 400, message: check.message } };
    type = mediaTypeForSlot(slotDef.type);
  } else {
    const v = assertUrlAllowed(null, url, hasFile);
    if (!v.ok) return { error: { status: 400, message: v.message } };
    if (!type || !['photo', 'music', 'video', 'background', 'ganesh'].includes(type)) {
      if (hasFile) type = inferTypeFromFilename(req.file.originalname);
      if (!type) type = 'photo';
    }
  }

  if (!url) {
    return { error: { status: 400, message: 'Provide a file or a URL' } };
  }

  if (type === 'ganesh') type = 'photo';

  if (slotDef && !slotDef.multiple) {
    const existing = await prisma.media.findMany({
      where: { eventId: event.id, slotKey: slotDef.key },
      select: { id: true, url: true },
    });
    await prisma.media.deleteMany({ where: { eventId: event.id, slotKey: slotDef.key } });
    for (const row of existing) {
      await objectStorage.tryDeletePublicUrl(row.url);
    }
  }

  if (slotDef && slotDef.multiple && slotDef.max) {
    const count = await prisma.media.count({ where: { eventId: event.id, slotKey } });
    if (count >= slotDef.max) {
      return {
        error: { status: 400, message: `This section accepts at most ${slotDef.max} file(s)` },
      };
    }
  }

  const last = await prisma.media.aggregate({
    where: { eventId: event.id, ...(slotKey ? { slotKey } : {}) },
    _max: { sortOrder: true },
  });
  const sortOrder = (last._max.sortOrder ?? -1) + 1;

  const media = await prisma.media.create({
    data: { eventId: event.id, type, url, caption, sortOrder, slotKey },
  });

  return { media };
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ eventId: string, mediaId: string, expectedOwnerId: string }} opts
 */
async function removeEventMedia(prisma, { eventId, mediaId, expectedOwnerId }) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, ownerId: true },
  });
  if (!event || event.ownerId !== expectedOwnerId) {
    return { error: { status: 404, message: 'Event not found' } };
  }

  const row = await prisma.media.findFirst({
    where: { id: mediaId, eventId },
  });
  if (!row) return { error: { status: 404, message: 'Media not found' } };

  await prisma.media.delete({ where: { id: mediaId } });
  await objectStorage.tryDeletePublicUrl(row.url);
  return { ok: true };
}

module.exports = { addEventMedia, removeEventMedia, publicUploadUrl };
