const prisma  = require('../utils/prisma');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { sendInvitationPublishedEmail } = require('../services/email.service');
const { addEventMedia, removeEventMedia } = require('../services/eventMedia.service');
const { normalizeOptionalHttpUrl } = require('../utils/urlNormalize');
const siteUrls = require('../config/siteUrls');
const { mintInvitePreviewToken } = require('../services/previewToken');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function ownerGuard(event, userId) {
  if (!event || event.ownerId !== userId) return false;
  return true;
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function addMonths(date, months) {
  const d = new Date(date);
  const dayOfMonth = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < dayOfMonth) d.setDate(0);
  return d;
}

function computeEventExpiryFromFunctions(functions = []) {
  if (!Array.isArray(functions) || functions.length === 0) return null;
  const maxDate = functions.reduce((latest, fn) => {
    if (!fn?.date) return latest;
    const dt = new Date(fn.date);
    if (Number.isNaN(dt.getTime())) return latest;
    return !latest || dt > latest ? dt : latest;
  }, null);
  return maxDate ? addMonths(maxDate, 6) : null;
}

async function syncEventExpiry(eventId, db = prisma) {
  const functions = await db.function.findMany({
    where: { eventId },
    select: { date: true },
  });
  const expiresAt = computeEventExpiryFromFunctions(functions);
  await db.event.update({
    where: { id: eventId },
    data: { expiresAt },
  });
  return expiresAt;
}

// ─── EVENTS ──────────────────────────────────────────────────────────────────

/** GET /api/user/events */
async function listEvents(req, res) {
  const events = await prisma.event.findMany({
    where: { ownerId: req.user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, slug: true, subdomain: true,
      community: true, eventType: true,
      isPublished: true, namesAreFrozen: true, language: true,
      expiresAt: true, createdAt: true, inviteScope: true, invitePairId: true,
      template: { select: { id: true, name: true, slug: true, thumbnailUrl: true, fieldSchema: true } },
      people: { select: { id: true, role: true, name: true, photoUrl: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } },
      functions: {
        select: { id: true, name: true, date: true, startTime: true, venueName: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      },
      _count: { select: { guests: true, media: true, rsvps: true } },
    },
  });
  return res.json({ ok: true, events });
}

/** POST /api/user/events — create event from payment */
async function createEvent(req, res) {
  const { paymentId, community, eventType, slug: rawSlug } = req.body || {};
  if (!paymentId || !community || !eventType) {
    return res.status(400).json({ ok: false, message: 'paymentId, community, and eventType are required' });
  }

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { template: { select: { id: true, fieldSchema: true } } },
  });
  if (!payment || payment.status !== 'paid') {
    return res.status(400).json({ ok: false, message: 'Payment not completed' });
  }
  if (payment.userId !== req.user.id) {
    return res.status(403).json({ ok: false, message: 'Payment does not belong to this account' });
  }
  if (payment.eventId) {
    return res.status(400).json({ ok: false, message: 'This payment has already been linked to an event' });
  }

  // Generate slug
  let slug = rawSlug ? slugify(rawSlug) : `event-${Date.now()}`;
  const existing = await prisma.event.findUnique({ where: { slug } });
  if (existing) slug = `${slug}-${Date.now()}`;

  const event = await prisma.event.create({
    data: {
      slug,
      ownerId: req.user.id,
      templateId: payment.templateId,
      community,
      eventType,
      language: 'en',
    },
  });

  await prisma.payment.update({ where: { id: paymentId }, data: { eventId: event.id } });

  return res.status(201).json({ ok: true, event });
}

/** GET /api/user/events/:id/preview-token */
async function getPreviewToken(req, res) {
  const event = await prisma.event.findUnique({
    where: { id: req.params.id },
    select: { slug: true, ownerId: true },
  });
  if (!ownerGuard(event, req.user.id)) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }
  const pt = mintInvitePreviewToken(event.slug);
  const base = siteUrls.apiBaseUrl().replace(/\/$/, '');
  const previewUrl = `${base}/i/${encodeURIComponent(event.slug)}/preview?pt=${encodeURIComponent(pt)}`;
  return res.json({ ok: true, previewUrl });
}

/** GET /api/user/events/:id */
async function getEvent(req, res) {
  const event = await prisma.event.findUnique({
    where: { id: req.params.id },
    include: {
      template: { select: { id: true, name: true, slug: true, thumbnailUrl: true, fieldSchema: true, community: true, languages: true } },
      people:   { orderBy: { sortOrder: 'asc' } },
      venues:   true,
      functions: { include: { venue: true }, orderBy: { sortOrder: 'asc' } },
      customFields: true,
      media:    { orderBy: { sortOrder: 'asc' } },
      _count:   { select: { guests: true, rsvps: true, analytics: true } },
    },
  });
  if (!ownerGuard(event, req.user.id)) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  // Attach paired event (subset) if this is a full invite with a pair
  let pairedEvent = null;
  if (event.invitePairId) {
    pairedEvent = await prisma.event.findFirst({
      where: { invitePairId: event.invitePairId, id: { not: event.id } },
      select: {
        id: true, slug: true, inviteScope: true, isPublished: true,
        functions: { select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } },
      },
    });

    // The partial event's functions are *copies* with new IDs.
    // Match them back to the main event's functions by name so the frontend
    // can correctly pre-tick the "Include in partial invite" checkboxes.
    if (pairedEvent) {
      const partialNames = new Set(pairedEvent.functions.map(f => f.name.trim().toLowerCase()));
      const matchedMainIds = event.functions
        .filter(f => partialNames.has(f.name.trim().toLowerCase()))
        .map(f => f.id);
      pairedEvent = { ...pairedEvent, pairedFunctionIds: matchedMainIds };
    }
  }

  return res.json({ ok: true, event: { ...event, pairedEvent } });
}

/** PUT /api/user/events/:id */
async function updateEvent(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const {
    slug,
    language,
    subdomain,
    instagramUrl,
    socialYoutubeUrl,
    websiteUrl,
    rsvpEnabled,
    guestNotesEnabled,
  } = req.body || {};
  const data = {};
  if (slug)        data.slug      = slugify(slug);
  if (language)    data.language  = language;
  if (subdomain !== undefined) data.subdomain = subdomain || null;
  if (instagramUrl !== undefined) data.instagramUrl = normalizeOptionalHttpUrl(instagramUrl);
  if (socialYoutubeUrl !== undefined) data.socialYoutubeUrl = normalizeOptionalHttpUrl(socialYoutubeUrl);
  if (websiteUrl !== undefined) data.websiteUrl = normalizeOptionalHttpUrl(websiteUrl);
  if (rsvpEnabled !== undefined) data.rsvpEnabled = Boolean(rsvpEnabled);
  if (guestNotesEnabled !== undefined) data.guestNotesEnabled = Boolean(guestNotesEnabled);

  // Slug uniqueness check
  if (data.slug) {
    const conflict = await prisma.event.findFirst({ where: { slug: data.slug, id: { not: req.params.id } } });
    if (conflict) return res.status(409).json({ ok: false, message: 'Slug already taken' });
  }

  const updated = await prisma.event.update({ where: { id: req.params.id }, data });
  return res.json({ ok: true, event: updated });
}

/** PATCH /api/user/events/:id/confirm-names */
async function confirmNames(req, res) {
  const event = await prisma.event.findUnique({
    where: { id: req.params.id },
    select: { id: true, ownerId: true, namesAreFrozen: true, people: { select: { name: true } } },
  });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  if (event.namesAreFrozen) return res.json({ ok: true, message: 'Names already confirmed' });
  if (!event.people.length) return res.status(400).json({ ok: false, message: 'Add at least one person before confirming names' });

  await prisma.event.update({ where: { id: req.params.id }, data: { namesAreFrozen: true } });
  return res.json({ ok: true, message: 'Names confirmed and locked' });
}

/** PATCH /api/user/events/:id/publish
 *
 * Body (all optional):
 *   slugFull            — update main event slug before publishing
 *   createPartial       — boolean, create a paired subset event
 *   partialSlug         — slug for the subset event (required if createPartial)
 *   partialFunctionIds  — string[] of function IDs to include in subset
 */
async function publishEvent(req, res) {
  const { slugFull, createPartial, partialSlug, partialFunctionIds } = req.body || {};

  const event = await prisma.event.findUnique({
    where: { id: req.params.id },
    include: {
      people:   { orderBy: { sortOrder: 'asc' } },
      venues:   true,
      functions: { orderBy: { sortOrder: 'asc' } },
      customFields: true,
      media:    { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  if (!event.namesAreFrozen) {
    return res.status(403).json({ ok: false, message: 'Please confirm your names before publishing' });
  }

  // Build update data for main event
  const mainUpdate = {
    isPublished: true,
    expiresAt: computeEventExpiryFromFunctions(event.functions),
  };

  if (slugFull) {
    const newSlug = slugify(slugFull);
    const conflict = await prisma.event.findFirst({ where: { slug: newSlug, id: { not: event.id } } });
    if (conflict) return res.status(409).json({ ok: false, message: 'Full invite slug is already taken' });
    mainUpdate.slug = newSlug;
  }

  // If already has a pair, just publish (no re-creation)
  const wasPublished = Boolean(event.isPublished);
  if (event.invitePairId) {
    await prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id: event.id }, data: mainUpdate });
      const subsetEvent = await tx.event.findFirst({
        where: { invitePairId: event.invitePairId, id: { not: event.id } },
        select: { id: true },
      });
      if (subsetEvent) {
        const subsetExpiry = await syncEventExpiry(subsetEvent.id, tx);
        await tx.event.update({
          where: { id: subsetEvent.id },
          data: { isPublished: true, expiresAt: subsetExpiry },
        });
      }
    });
    if (!wasPublished) {
      const owner = await prisma.user.findUnique({ where: { id: event.ownerId }, select: { email: true } });
      if (owner?.email) {
        const inviteUrl = `${siteUrls.apiBaseUrl()}/i/${mainUpdate.slug || event.slug}`;
        sendInvitationPublishedEmail({ to: owner.email, inviteUrl }).catch(() => {});
      }
    }
    return res.json({ ok: true, message: 'Invitation published' });
  }

  // Create subset event if requested
  if (createPartial && partialFunctionIds?.length) {
    const pSlug = slugify(partialSlug || `${event.slug}-partial`);
    const pConflict = await prisma.event.findFirst({ where: { slug: pSlug } });
    if (pConflict) return res.status(409).json({ ok: false, message: 'Partial invite slug is already taken' });

    const pairId = require('crypto').randomUUID();
    mainUpdate.inviteScope  = 'full';
    mainUpdate.invitePairId = pairId;

    const fnIdSet = new Set(partialFunctionIds);
    const subsetFunctions = event.functions.filter(f => fnIdSet.has(f.id));

    await prisma.$transaction(async (tx) => {
      // Update main event
      await tx.event.update({ where: { id: event.id }, data: mainUpdate });

      // Create subset event
      const subset = await tx.event.create({
        data: {
          slug:         pSlug,
          ownerId:      event.ownerId,
          templateId:   event.templateId,
          community:    event.community,
          eventType:    event.eventType,
          language:     event.language,
          namesAreFrozen: event.namesAreFrozen,
          isPublished:  true,
          expiresAt:    computeEventExpiryFromFunctions(subsetFunctions),
          inviteScope:  'subset',
          invitePairId: pairId,
          instagramUrl:      event.instagramUrl ?? null,
          socialYoutubeUrl:  event.socialYoutubeUrl ?? null,
          websiteUrl:        event.websiteUrl ?? null,
          rsvpEnabled:       event.rsvpEnabled !== false,
          guestNotesEnabled: event.guestNotesEnabled !== false,
        },
      });

      // Copy people
      for (const p of event.people) {
        await tx.eventPerson.create({
          data: { eventId: subset.id, role: p.role, name: p.name, photoUrl: p.photoUrl, extraData: p.extraData, sortOrder: p.sortOrder },
        });
      }
      // Copy venues
      for (const v of event.venues) {
        await tx.venue.create({
          data: { eventId: subset.id, name: v.name, address: v.address, lat: v.lat, lng: v.lng, mapUrl: v.mapUrl, city: v.city, state: v.state },
        });
      }
      // Copy selected functions only
      for (const fn of subsetFunctions) {
        await tx.function.create({
          data: {
            eventId: subset.id, name: fn.name,
            date: fn.date, startTime: fn.startTime, endTime: fn.endTime,
            venueId: null, // venues copied separately, re-link not needed
            venueName: fn.venueName, venueAddress: fn.venueAddress,
            venueLat: fn.venueLat, venueLng: fn.venueLng, venueMapUrl: fn.venueMapUrl,
            dressCode: fn.dressCode, notes: fn.notes, sortOrder: fn.sortOrder,
          },
        });
      }
      // Copy custom fields
      for (const cf of event.customFields) {
        await tx.eventCustomField.create({
          data: { eventId: subset.id, fieldKey: cf.fieldKey, fieldValue: cf.fieldValue, fieldType: cf.fieldType },
        });
      }
      // Copy media
      for (const m of event.media) {
        await tx.media.create({
          data: {
            eventId: subset.id,
            type: m.type,
            url: m.url,
            caption: m.caption,
            sortOrder: m.sortOrder,
            slotKey: m.slotKey ?? null,
          },
        });
      }
    });
  } else {
    // Publish without partial
    await prisma.event.update({ where: { id: event.id }, data: mainUpdate });
  }

  if (!wasPublished) {
    const owner = await prisma.user.findUnique({ where: { id: event.ownerId }, select: { email: true } });
    if (owner?.email) {
      const inviteUrl = `${siteUrls.apiBaseUrl()}/i/${mainUpdate.slug || event.slug}`;
      sendInvitationPublishedEmail({ to: owner.email, inviteUrl }).catch(() => {});
    }
  }

  return res.json({ ok: true, message: 'Invitation published' });
}

/** PATCH /api/user/events/:id/partial-functions
 * Update which functions are included in the paired subset (partial) invite.
 * Body: { partialFunctionIds: string[] }
 */
async function updatePartialFunctions(req, res) {
  const { partialFunctionIds } = req.body || {};
  if (!Array.isArray(partialFunctionIds) || partialFunctionIds.length === 0) {
    return res.status(400).json({ ok: false, message: 'partialFunctionIds array required' });
  }

  const event = await prisma.event.findUnique({
    where: { id: req.params.id },
    include: { functions: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  if (!event.invitePairId) return res.status(400).json({ ok: false, message: 'No paired partial invite found' });

  // Find the subset (partial) event
  const subsetEvent = await prisma.event.findFirst({
    where: { invitePairId: event.invitePairId, id: { not: event.id } },
  });
  if (!subsetEvent) return res.status(404).json({ ok: false, message: 'Paired event not found' });

  const fnIdSet = new Set(partialFunctionIds);
  const selectedFns = event.functions.filter(f => fnIdSet.has(f.id));

  await prisma.$transaction(async (tx) => {
    // Remove all existing functions from the subset event
    await tx.function.deleteMany({ where: { eventId: subsetEvent.id } });
    // Copy the selected functions from the full event
    for (const fn of selectedFns) {
      await tx.function.create({
        data: {
          eventId: subsetEvent.id, name: fn.name,
          date: fn.date, startTime: fn.startTime, endTime: fn.endTime,
          venueId: null, venueName: fn.venueName, venueAddress: fn.venueAddress,
          venueLat: fn.venueLat, venueLng: fn.venueLng, venueMapUrl: fn.venueMapUrl,
          dressCode: fn.dressCode, notes: fn.notes, sortOrder: fn.sortOrder,
        },
      });
    }
    await syncEventExpiry(subsetEvent.id, tx);
  });

  return res.json({ ok: true, message: 'Partial invite functions updated' });
}

/** PATCH /api/user/events/:id/unpublish */
async function unpublishEvent(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.event.update({ where: { id: req.params.id }, data: { isPublished: false } });
  return res.json({ ok: true, message: 'Invitation unpublished' });
}

/** GET /api/user/events/:id/stats */
async function getEventStats(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const [opens, rsvpCount, guestCount, functions] = await Promise.all([
    prisma.invitationEvent.count({ where: { eventId: req.params.id, type: 'opened' } }),
    prisma.rsvp.count({ where: { eventId: req.params.id, attending: true } }),
    prisma.guest.count({ where: { eventId: req.params.id } }),
    prisma.function.findMany({
      where: { eventId: req.params.id },
      select: {
        id: true, name: true,
        rsvps: { select: { attending: true, plusCount: true } },
      },
    }),
  ]);

  const perFunction = functions.map(fn => ({
    id: fn.id, name: fn.name,
    attending:    fn.rsvps.filter(r => r.attending === true).length,
    notAttending: fn.rsvps.filter(r => r.attending === false).length,
    pending:      fn.rsvps.filter(r => r.attending === null).length,
    plusOnes:     fn.rsvps.reduce((s, r) => s + (r.attending ? r.plusCount : 0), 0),
  }));

  return res.json({ ok: true, stats: { opens, rsvpCount, guestCount, perFunction } });
}

// ─── PEOPLE ──────────────────────────────────────────────────────────────────

async function listPeople(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  const people = await prisma.eventPerson.findMany({ where: { eventId: req.params.id }, orderBy: { sortOrder: 'asc' } });
  return res.json({ ok: true, people });
}

async function addPerson(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true, namesAreFrozen: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  if (event.namesAreFrozen) return res.status(403).json({ ok: false, message: 'Names are confirmed. Raise a support ticket to request changes.' });

  const { role, name, photoUrl, extraData, sortOrder } = req.body || {};
  if (!role || !name) return res.status(400).json({ ok: false, message: 'role and name are required' });

  const person = await prisma.eventPerson.create({
    data: { eventId: req.params.id, role, name, photoUrl: photoUrl || null, extraData: extraData || null, sortOrder: sortOrder ?? 0 },
  });
  return res.status(201).json({ ok: true, person });
}

async function updatePerson(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true, namesAreFrozen: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  // Allow updates when frozen only if the caller marks the role as optional.
  // Required names are blocked — the frontend disables those fields.
  const { required } = req.body || {};
  if (event.namesAreFrozen && required !== false) {
    return res.status(403).json({ ok: false, message: 'Names are confirmed. Raise a support ticket to request changes.' });
  }

  const { role, name, photoUrl, extraData, sortOrder } = req.body || {};
  const data = {};
  if (role !== undefined)      data.role      = role;
  if (name !== undefined)      data.name      = name;
  if (photoUrl !== undefined)  data.photoUrl  = photoUrl;
  if (extraData !== undefined) data.extraData = extraData;
  if (sortOrder !== undefined) data.sortOrder = sortOrder;

  const person = await prisma.eventPerson.update({ where: { id: req.params.pid }, data });
  return res.json({ ok: true, person });
}

async function deletePerson(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true, namesAreFrozen: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  if (event.namesAreFrozen) return res.status(403).json({ ok: false, message: 'Names are confirmed. Raise a support ticket to request changes.' });

  await prisma.eventPerson.delete({ where: { id: req.params.pid } });
  return res.json({ ok: true });
}

// ─── FUNCTIONS ───────────────────────────────────────────────────────────────

async function listFunctions(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  const functions = await prisma.function.findMany({ where: { eventId: req.params.id }, include: { venue: true }, orderBy: { sortOrder: 'asc' } });
  return res.json({ ok: true, functions });
}

async function addFunction(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const { name, date, startTime, endTime, venueId, venueName, venueAddress, venueLat, venueLng, venueMapUrl, dressCode, notes, sortOrder } = req.body || {};
  if (!name || !date) return res.status(400).json({ ok: false, message: 'name and date are required' });

  const fn = await prisma.function.create({
    data: {
      eventId: req.params.id, name,
      date: new Date(date),
      startTime: startTime || null, endTime: endTime || null,
      venueId: venueId || null, venueName: venueName || null,
      venueAddress: venueAddress || null,
      venueLat: venueLat ? parseFloat(venueLat) : null,
      venueLng: venueLng ? parseFloat(venueLng) : null,
      venueMapUrl: venueMapUrl || null,
      dressCode: dressCode || null, notes: notes || null,
      sortOrder: sortOrder ?? 0,
    },
  });
  await syncEventExpiry(req.params.id);
  return res.status(201).json({ ok: true, function: fn });
}

async function updateFunction(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const { name, date, startTime, endTime, venueId, venueName, venueAddress, venueLat, venueLng, venueMapUrl, dressCode, notes, sortOrder } = req.body || {};
  const data = {};
  if (name !== undefined)         data.name         = name;
  if (date !== undefined)         data.date         = new Date(date);
  if (startTime !== undefined)    data.startTime    = startTime;
  if (endTime !== undefined)      data.endTime      = endTime;
  if (venueId !== undefined)      data.venueId      = venueId;
  if (venueName !== undefined)    data.venueName    = venueName;
  if (venueAddress !== undefined) data.venueAddress = venueAddress;
  if (venueLat !== undefined)     data.venueLat     = venueLat ? parseFloat(venueLat) : null;
  if (venueLng !== undefined)     data.venueLng     = venueLng ? parseFloat(venueLng) : null;
  if (venueMapUrl !== undefined)  data.venueMapUrl  = venueMapUrl;
  if (dressCode !== undefined)    data.dressCode    = dressCode;
  if (notes !== undefined)        data.notes        = notes;
  if (sortOrder !== undefined)    data.sortOrder    = sortOrder;

  const fn = await prisma.function.update({ where: { id: req.params.fnId }, data });
  await syncEventExpiry(req.params.id);
  return res.json({ ok: true, function: fn });
}

async function deleteFunction(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.function.delete({ where: { id: req.params.fnId } });
  await syncEventExpiry(req.params.id);
  return res.json({ ok: true });
}

// ─── VENUES ──────────────────────────────────────────────────────────────────

async function listVenues(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  const venues = await prisma.venue.findMany({ where: { eventId: req.params.id } });
  return res.json({ ok: true, venues });
}

async function addVenue(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const { name, address, lat, lng, mapUrl, city, state } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, message: 'name is required' });

  const venue = await prisma.venue.create({
    data: {
      eventId: req.params.id, name,
      address: address || null,
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
      mapUrl: mapUrl || null,
      city: city || null, state: state || null,
    },
  });
  return res.status(201).json({ ok: true, venue });
}

async function updateVenue(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const { name, address, lat, lng, mapUrl, city, state } = req.body || {};
  const data = {};
  if (name    !== undefined) data.name    = name;
  if (address !== undefined) data.address = address;
  if (lat     !== undefined) data.lat     = lat ? parseFloat(lat) : null;
  if (lng     !== undefined) data.lng     = lng ? parseFloat(lng) : null;
  if (mapUrl  !== undefined) data.mapUrl  = mapUrl;
  if (city    !== undefined) data.city    = city;
  if (state   !== undefined) data.state   = state;

  const venue = await prisma.venue.update({ where: { id: req.params.vId }, data });
  return res.json({ ok: true, venue });
}

async function deleteVenue(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.venue.delete({ where: { id: req.params.vId } });
  return res.json({ ok: true });
}

// ─── CUSTOM FIELDS ───────────────────────────────────────────────────────────

async function getCustomFields(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  const fields = await prisma.eventCustomField.findMany({ where: { eventId: req.params.id } });
  return res.json({ ok: true, fields });
}

async function upsertCustomFields(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const { fields } = req.body || {};
  if (!Array.isArray(fields)) return res.status(400).json({ ok: false, message: 'fields array required' });

  const ops = fields.map(({ fieldKey, fieldValue, fieldType }) =>
    prisma.eventCustomField.upsert({
      where:  { eventId_fieldKey: { eventId: req.params.id, fieldKey } },
      create: { eventId: req.params.id, fieldKey, fieldValue: String(fieldValue), fieldType: fieldType || 'text' },
      update: { fieldValue: String(fieldValue), fieldType: fieldType || 'text' },
    })
  );
  const results = await prisma.$transaction(ops);
  return res.json({ ok: true, fields: results });
}

// ─── MEDIA ───────────────────────────────────────────────────────────────────

async function listMedia(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });
  const media = await prisma.media.findMany({ where: { eventId: req.params.id }, orderBy: { sortOrder: 'asc' } });
  return res.json({ ok: true, media });
}

async function uploadMedia(req, res) {
  const result = await addEventMedia(prisma, {
    eventId: req.params.id,
    expectedOwnerId: req.user.id,
    req,
  });
  if (result.error) {
    return res.status(result.error.status).json({ ok: false, message: result.error.message });
  }
  await prisma.eventRenderCache.deleteMany({ where: { eventId: req.params.id } });
  return res.status(201).json({ ok: true, media: result.media });
}

async function deleteMedia(req, res) {
  const result = await removeEventMedia(prisma, {
    eventId: req.params.id,
    mediaId: req.params.mediaId,
    expectedOwnerId: req.user.id,
  });
  if (result.error) {
    return res.status(result.error.status).json({ ok: false, message: result.error.message });
  }
  await prisma.eventRenderCache.deleteMany({ where: { eventId: req.params.id } });
  return res.json({ ok: true });
}

// ─── GUESTS ──────────────────────────────────────────────────────────────────

async function listGuests(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const guests = await prisma.guest.findMany({
    where: { eventId: req.params.id },
    include: {
      rsvps: {
        include: { function: { select: { id: true, name: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ ok: true, guests });
}

async function exportGuestsCSV(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true, slug: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const guests = await prisma.guest.findMany({
    where: { eventId: req.params.id },
    include: { rsvps: { include: { function: { select: { name: true } } } } },
  });

  const lines = ['Name,Phone,Email,Side,Tags,Function,Attending,+1s,Meal,Message'];
  for (const g of guests) {
    if (g.rsvps.length === 0) {
      lines.push(`"${g.name}","${g.phone || ''}","${g.email || ''}","${g.side || ''}","${g.tags || ''}","—","Pending","0","",""`);
    } else {
      for (const r of g.rsvps) {
        const attending = r.attending === true ? 'Yes' : r.attending === false ? 'No' : 'Pending';
        lines.push(`"${g.name}","${g.phone || ''}","${g.email || ''}","${g.side || ''}","${g.tags || ''}","${r.function.name}","${attending}","${r.plusCount}","${r.mealPreference || ''}","${(r.message || '').replace(/"/g, '""')}"`);
      }
    }
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="guests-${event.slug}.csv"`);
  return res.send(lines.join('\n'));
}

// ─── GUEST WISHES ────────────────────────────────────────────────────────────

async function listWishes(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const wishes = await prisma.guestWish.findMany({
    where: { eventId: req.params.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      guestName: true,
      message: true,
      isApproved: true,
      createdAt: true,
    },
  });

  return res.json({ ok: true, wishes });
}

async function setWishVisibility(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const { visible } = req.body || {};
  if (typeof visible !== 'boolean') {
    return res.status(400).json({ ok: false, message: 'visible boolean is required' });
  }

  const wish = await prisma.guestWish.findFirst({
    where: { id: req.params.wishId, eventId: req.params.id },
    select: { id: true },
  });
  if (!wish) return res.status(404).json({ ok: false, message: 'Wish not found' });

  const updated = await prisma.guestWish.update({
    where: { id: req.params.wishId },
    data: { isApproved: visible },
    select: { id: true, isApproved: true },
  });

  return res.json({ ok: true, wish: updated });
}

async function deleteWish(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true } });
  if (!ownerGuard(event, req.user.id)) return res.status(404).json({ ok: false, message: 'Event not found' });

  const wish = await prisma.guestWish.findFirst({
    where: { id: req.params.wishId, eventId: req.params.id },
    select: { id: true },
  });
  if (!wish) return res.status(404).json({ ok: false, message: 'Wish not found' });

  await prisma.guestWish.delete({ where: { id: req.params.wishId } });
  return res.json({ ok: true });
}

// ─── SUPPORT TICKETS ─────────────────────────────────────────────────────────

async function listTickets(req, res) {
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: req.user.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ ok: true, tickets });
}

async function createTicket(req, res) {
  const { subject, message, eventId } = req.body || {};
  if (!subject || !message) return res.status(400).json({ ok: false, message: 'subject and message are required' });

  // Verify event belongs to user if provided
  if (eventId) {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { ownerId: true } });
    if (!event || event.ownerId !== req.user.id) {
      return res.status(403).json({ ok: false, message: 'Event not found' });
    }
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      userId: req.user.id,
      eventId: eventId || null,
      subject,
      messages: { create: { senderRole: 'user', body: message } },
    },
    include: { messages: true },
  });
  return res.status(201).json({ ok: true, ticket });
}

async function getTicket(req, res) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!ticket || ticket.userId !== req.user.id) {
    return res.status(404).json({ ok: false, message: 'Ticket not found' });
  }
  return res.json({ ok: true, ticket });
}

// ─── PROFILE ─────────────────────────────────────────────────────────────────

async function updateProfile(req, res) {
  const { email, phone } = req.body || {};
  const existing = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, username: true, email: true, phone: true },
  });
  if (!existing) return res.status(404).json({ ok: false, message: 'User not found' });

  if (email !== undefined) {
    return res.status(403).json({ ok: false, message: 'Email cannot be changed. Please raise a support ticket if needed.' });
  }

  const data = {};
  if (phone !== undefined) {
    const currentPhone = String(existing.phone || '').trim();
    if (currentPhone) {
      return res.status(403).json({ ok: false, message: 'Contact number cannot be changed once filled. Please raise a support ticket if needed.' });
    }
    const nextPhone = String(phone || '').trim();
    if (!nextPhone) {
      return res.status(400).json({ ok: false, message: 'Contact number is required' });
    }
    data.phone = nextPhone;
  }

  if (Object.keys(data).length === 0) {
    return res.json({ ok: true, user: existing });
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data,
    select: { id: true, username: true, email: true, phone: true },
  });
  return res.json({ ok: true, user });
}

// ─── REVIEW ──────────────────────────────────────────────────────────────────

async function submitReview(req, res) {
  const { templateId, rating, reviewText, coupleNames, location } = req.body || {};
  if (!templateId || !rating) return res.status(400).json({ ok: false, message: 'templateId and rating are required' });
  if (rating < 1 || rating > 5) return res.status(400).json({ ok: false, message: 'rating must be 1–5' });

  // Verify user bought this template
  const payment = await prisma.payment.findFirst({
    where: { userId: req.user.id, templateId, status: 'paid' },
  });
  if (!payment) return res.status(403).json({ ok: false, message: 'You can only review templates you have purchased' });

  // ── Upload couple photo to R2 (optional) ────────────────────────────────────
  let couplePhotoUrl = null;
  if (req.file) {
    try {
      const storage       = require('../config/storage');
      const objectStorage = require('../services/objectStorage');
      const path          = require('path');
      const { v4: uuidv4} = require('uuid');

      const ext    = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
      const key    = `review-images/${uuidv4()}${ext}`;
      const ct     = storage.contentTypeForPath(req.file.originalname || `file${ext}`);

      if (storage.useObjectStorage()) {
        await objectStorage.putObject(key, req.file.buffer, ct);
        couplePhotoUrl = `${storage.objectStoragePublicBase()}/${key}`;
      }
      // Local disk mode: skip upload (R2 not configured) — photo URL stays null
    } catch (uploadErr) {
      console.error('[Review] Couple photo upload failed:', uploadErr.message);
      // Non-fatal — proceed without photo
    }
  }

  const review = await prisma.templateReview.upsert({
    where: { templateId_userId: { templateId, userId: req.user.id } },
    create: {
      templateId, userId: req.user.id,
      rating: Number(rating),
      reviewText:     reviewText     || null,
      coupleNames:    coupleNames    || null,
      location:       location       || null,
      couplePhotoUrl: couplePhotoUrl || null,
    },
    update: {
      rating: Number(rating),
      reviewText:     reviewText     || null,
      coupleNames:    coupleNames    || null,
      location:       location       || null,
      // Only overwrite photo if a new one was uploaded
      ...(couplePhotoUrl ? { couplePhotoUrl } : {}),
    },
  });

  // Update template avgRating
  const agg = await prisma.templateReview.aggregate({ where: { templateId }, _avg: { rating: true }, _count: true });
  await prisma.template.update({
    where: { id: templateId },
    data: { avgRating: agg._avg.rating || 0 },
  });

  return res.json({ ok: true, review });
}

module.exports = {
  listEvents, createEvent, getPreviewToken, getEvent, updateEvent, confirmNames, publishEvent, updatePartialFunctions, unpublishEvent, getEventStats,
  listPeople, addPerson, updatePerson, deletePerson,
  listFunctions, addFunction, updateFunction, deleteFunction,
  listVenues, addVenue, updateVenue, deleteVenue,
  getCustomFields, upsertCustomFields,
  listMedia, uploadMedia, deleteMedia,
  listGuests, exportGuestsCSV,
  listWishes, setWishVisibility, deleteWish,
  listTickets, createTicket, getTicket,
  updateProfile,
  submitReview,
};
