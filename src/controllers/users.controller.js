const crypto   = require('crypto');
const bcrypt   = require('bcrypt');
const prisma   = require('../utils/prisma');
const { parseGoogleMapsLocation } = require('../utils/mapsParse');
const { createPaymentLinkOrPlaceholder } = require('../services/razorpay.service');
const { sendBalancePaymentEmail, sendInvitationPublishedEmail } = require('../services/email.service');
const { addEventMedia, removeEventMedia } = require('../services/eventMedia.service');
const { normalizeOptionalHttpUrl } = require('../utils/urlNormalize');
const siteUrls = require('../config/siteUrls');
const { mintInvitePreviewToken } = require('../services/previewToken');

function slugifyBase(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'invite';
}

async function ensureUniqueEventSlug(wanted) {
  let base = slugifyBase(wanted);
  if (!base) base = 'invite';
  let slug = base;
  let n = 0;
  while (await prisma.event.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

/** Defaults missing sortOrder to row index; enforces unique non-negative integers */
function resolveFunctionSortOrders(fnList) {
  const nums = [];
  for (let i = 0; i < fnList.length; i++) {
    const f = fnList[i];
    if (f.sortOrder === undefined || f.sortOrder === null || f.sortOrder === '') {
      nums.push(i);
      continue;
    }
    const n = Number(f.sortOrder);
    if (!Number.isInteger(n) || n < 0) {
      return { error: 'Sort order must be a non-negative integer for each function' };
    }
    nums.push(n);
  }
  if (new Set(nums).size !== nums.length) {
    return { error: 'Sort order must be unique for each function in this invitation' };
  }
  return { orders: nums };
}

/**
 * Map link alone is valid (short share URLs often have no parseable coordinates).
 * When lat/lng are sent, both must be set and in range.
 */
function resolveFunctionVenueMap(fn) {
  const urlIn = fn.venueMapUrl != null ? String(fn.venueMapUrl).trim() : '';
  if (urlIn.length > 2048) {
    return { error: 'Map link is too long (max 2048 characters)' };
  }
  let venueMapUrl = urlIn || null;
  if (venueMapUrl && !/^https?:\/\//i.test(venueMapUrl)) {
    return { error: 'Map link must be a valid http(s) URL' };
  }

  let lat = fn.venueLat != null && fn.venueLat !== '' ? Number(fn.venueLat) : null;
  let lng = fn.venueLng != null && fn.venueLng !== '' ? Number(fn.venueLng) : null;
  if (Number.isNaN(lat)) lat = null;
  if (Number.isNaN(lng)) lng = null;

  if (venueMapUrl && lat == null && lng == null) {
    const parsed = parseGoogleMapsLocation(venueMapUrl);
    if (parsed) {
      lat = parsed.lat;
      lng = parsed.lng;
    }
  }

  if (lat != null || lng != null) {
    if (lat == null || lng == null) {
      return { error: 'Provide both latitude and longitude, or only a map link, or leave map fields empty' };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { error: 'Latitude or longitude out of valid range' };
    }
  }

  return { venueLat: lat, venueLng: lng, venueMapUrl };
}

// GET /api/v1/users
async function list(req, res) {
  const { search, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = search
    ? { OR: [
        { email: { contains: search } },
        { username: { contains: search } },
        { phone: { contains: search } },
      ]}
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take:    Number(limit),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, username: true, phone: true, createdAt: true,
        _count: { select: { events: true, payments: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  res.json({ ok: true, data: users, total, page: Number(page), limit: Number(limit) });
}

// GET /api/v1/users/:id
async function get(req, res) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.params.id },
    select: {
      id: true, email: true, username: true, phone: true, createdAt: true,
      events: {
        include: {
          template:     { select: { id: true, name: true, slug: true, price: true, fieldSchema: true } },
          functions:    { orderBy: { sortOrder: 'asc' }, include: { venue: true } },
          people:       { orderBy: { sortOrder: 'asc' } },
          venues:       true,
          customFields: true,
          media:        true,
          payments:     { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
        include: { template: { select: { name: true } } },
      },
      tickets: {
        orderBy: { createdAt: 'desc' },
        select:  { id: true, subject: true, status: true, createdAt: true },
      },
    },
  });

  res.json({ ok: true, data: user });
}

// POST /api/v1/users/:id/generate-invites
// Creates two Event rows: one with all functions (full), one with a subset (subset). Same template & invitePairId.
async function generatePairedInvites(req, res) {
  const userId = req.params.id;
  const {
    paymentId,
    templateId: templateIdBody,
    brideName,
    groomName,
    eventType = 'wedding',
    community = 'universal',
    language = 'en',
    slugFull: slugFullIn,
    slugSubset: slugSubsetIn,
    functions: fnList,
    subsetFunctionIndices,
    people: peopleList,
    venues: venueList,
    customFields: customFieldList,
  } = req.body;

  await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  let resolvedTemplateId = templateIdBody;
  if (paymentId) {
    const pay = await prisma.payment.findFirst({
      where: { id: paymentId, userId },
    });
    if (!pay) return res.status(400).json({ ok: false, message: 'Payment not found for this user' });
    resolvedTemplateId = pay.templateId;
  }
  if (!resolvedTemplateId) {
    return res.status(400).json({ ok: false, message: 'Provide paymentId (preferred) or templateId' });
  }

  const tpl = await prisma.template.findUnique({ where: { id: resolvedTemplateId } });
  if (!tpl) return res.status(400).json({ ok: false, message: 'Template not found' });

  if (!Array.isArray(fnList) || fnList.length < 1) {
    return res.status(400).json({ ok: false, message: 'Add at least one function (event) in the form' });
  }
  if (!Array.isArray(subsetFunctionIndices) || subsetFunctionIndices.length < 1) {
    return res.status(400).json({ ok: false, message: 'Select at least one function for the partial invitation' });
  }

  const n = fnList.length;
  const subsetSet = new Set(subsetFunctionIndices);
  for (const i of subsetFunctionIndices) {
    if (!Number.isInteger(i) || i < 0 || i >= n) {
      return res.status(400).json({ ok: false, message: 'Invalid subset function selection' });
    }
  }
  if (subsetSet.size !== subsetFunctionIndices.length) {
    return res.status(400).json({ ok: false, message: 'Duplicate indices in subset selection' });
  }

  const sortRes = resolveFunctionSortOrders(fnList);
  if (sortRes.error) {
    return res.status(400).json({ ok: false, message: sortRes.error });
  }
  const sortOrders = sortRes.orders;

  const mapList = [];
  for (const fn of fnList) {
    const m = resolveFunctionVenueMap(fn);
    if (m.error) return res.status(400).json({ ok: false, message: m.error });
    mapList.push({ venueLat: m.venueLat, venueLng: m.venueLng, venueMapUrl: m.venueMapUrl });
  }

  const pairId = crypto.randomUUID();
  const baseSlug = slugifyBase(`${brideName || ''}-${groomName || ''}-${Date.now().toString(36)}`);

  const slugFull = await ensureUniqueEventSlug(
    slugFullIn ? slugifyBase(String(slugFullIn)) : `${baseSlug}-all`,
  );
  const slugSubset = await ensureUniqueEventSlug(
    slugSubsetIn ? slugifyBase(String(slugSubsetIn)) : `${baseSlug}-partial`,
  );

  try {
    const { full, subset } = await prisma.$transaction(async (tx) => {
      const evFull = await tx.event.create({
        data: {
          slug:         slugFull,
          ownerId:      userId,
          templateId:   resolvedTemplateId,
          community,
          eventType,
          brideName:    brideName || null,
          groomName:    groomName || null,
          language,
          inviteScope:  'full',
          invitePairId: pairId,
          isPublished:  false,
        },
      });
      const evSubset = await tx.event.create({
        data: {
          slug:         slugSubset,
          ownerId:      userId,
          templateId:   resolvedTemplateId,
          community,
          eventType,
          brideName:    brideName || null,
          groomName:    groomName || null,
          language,
          inviteScope:  'subset',
          invitePairId: pairId,
          isPublished:  false,
        },
      });

      for (let i = 0; i < fnList.length; i++) {
        const fn = fnList[i];
        const d = fn.date ? new Date(fn.date) : new Date();
        const { venueLat, venueLng, venueMapUrl } = mapList[i];
        const dressCode = fn.dressCode != null && String(fn.dressCode).trim() !== ''
          ? String(fn.dressCode).trim()
          : null;
        await tx.function.create({
          data: {
            eventId:      evFull.id,
            name:         String(fn.name || `Event ${i + 1}`),
            date:         d,
            startTime:    fn.startTime || null,
            venueName:    fn.venueName || null,
            venueAddress: fn.venueAddress || null,
            venueLat,
            venueLng,
            venueMapUrl,
            dressCode,
            sortOrder:    sortOrders[i],
          },
        });
      }

      for (let k = 0; k < fnList.length; k++) {
        if (!subsetSet.has(k)) continue;
        const fn = fnList[k];
        const d = fn.date ? new Date(fn.date) : new Date();
        const { venueLat, venueLng, venueMapUrl } = mapList[k];
        const dressCode = fn.dressCode != null && String(fn.dressCode).trim() !== ''
          ? String(fn.dressCode).trim()
          : null;
        await tx.function.create({
          data: {
            eventId:      evSubset.id,
            name:         String(fn.name || `Event ${k + 1}`),
            date:         d,
            startTime:    fn.startTime || null,
            venueName:    fn.venueName || null,
            venueAddress: fn.venueAddress || null,
            venueLat,
            venueLng,
            venueMapUrl,
            dressCode,
            sortOrder:    sortOrders[k],
          },
        });
      }

      // Create people for both events
      if (Array.isArray(peopleList) && peopleList.length) {
        for (const ev of [evFull, evSubset]) {
          for (let i = 0; i < peopleList.length; i++) {
            const p = peopleList[i];
            await tx.eventPerson.create({
              data: {
                eventId:   ev.id,
                role:      String(p.role || 'guest'),
                name:      String(p.name || ''),
                photoUrl:  p.photoUrl || null,
                extraData: p.extraData || null,
                sortOrder: p.sortOrder ?? i,
              },
            });
          }
        }
      }

      // Create venues for both events
      if (Array.isArray(venueList) && venueList.length) {
        for (const ev of [evFull, evSubset]) {
          for (const v of venueList) {
            await tx.venue.create({
              data: {
                eventId: ev.id,
                name:    String(v.name || ''),
                address: v.address || null,
                lat:     v.lat != null ? Number(v.lat) : null,
                lng:     v.lng != null ? Number(v.lng) : null,
                mapUrl:  v.mapUrl || null,
                city:    v.city || null,
                state:   v.state || null,
              },
            });
          }
        }
      }

      // Create custom fields for both events
      if (Array.isArray(customFieldList) && customFieldList.length) {
        for (const ev of [evFull, evSubset]) {
          for (const cf of customFieldList) {
            await tx.eventCustomField.create({
              data: {
                eventId:    ev.id,
                fieldKey:   String(cf.fieldKey || cf.key),
                fieldValue: String(cf.fieldValue || cf.value || ''),
                fieldType:  cf.fieldType || cf.type || 'text',
              },
            });
          }
        }
      }

      return { full: evFull, subset: evSubset };
    });

    const includeAll = {
      template:     { select: { id: true, name: true, slug: true, price: true, fieldSchema: true } },
      functions:    { orderBy: { sortOrder: 'asc' }, include: { venue: true } },
      people:       { orderBy: { sortOrder: 'asc' } },
      venues:       true,
      customFields: true,
    };
    const outFull = await prisma.event.findUnique({
      where: { id: full.id },
      include: includeAll,
    });
    const outSubset = await prisma.event.findUnique({
      where: { id: subset.id },
      include: includeAll,
    });

    res.json({
      ok:   true,
      data: {
        pairId,
        full:    outFull,
        subset:  outSubset,
        message: 'Two invitations created. The couple can build each separately; share both guest links when ready.',
      },
    });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(400).json({ ok: false, message: 'Slug already in use — try different URL slugs' });
    }
    throw e;
  }
}

// PATCH /api/v1/users/:id/reset-password
async function resetPassword(req, res) {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ ok: false, message: 'Password must be at least 8 characters' });
  }

  const hash = await bcrypt.hash(password, 12);
  await prisma.user.update({
    where: { id: req.params.id },
    data:  { passwordHash: hash },
  });

  res.json({ ok: true, message: 'Password updated' });
}

// PATCH /api/v1/users/:id/freeze-names
// Body: { eventId } — freezes names on a specific event
async function freezeNames(req, res) {
  const { eventId } = req.body;
  if (!eventId) return res.status(400).json({ ok: false, message: 'eventId required' });

  const event = await prisma.event.findFirst({
    where: { id: eventId, ownerId: req.params.id },
  });
  if (!event) return res.status(404).json({ ok: false, message: 'Event not found for this user' });

  const updated = await prisma.event.update({
    where: { id: eventId },
    data:  { namesAreFrozen: true },
  });

  res.json({ ok: true, data: updated });
}

// PUT /api/v1/users/:id/event-data
// Admin edits any field on a couple's Event + Functions + Media + People + Venues + Custom Fields
async function updateEventData(req, res) {
  const { eventId, brideName, groomName, language, isPublished, slug, eventType, community,
          functions, media, people, venues, customFields,
          instagramUrl, socialYoutubeUrl, websiteUrl, rsvpEnabled, guestNotesEnabled } = req.body;

  if (!eventId) return res.status(400).json({ ok: false, message: 'eventId required' });

  const event = await prisma.event.findFirst({
    where: { id: eventId, ownerId: req.params.id },
  });
  if (!event) return res.status(404).json({ ok: false, message: 'Event not found for this user' });

  // Update main event fields
  const updated = await prisma.event.update({
    where: { id: eventId },
    data: {
      ...(brideName   !== undefined && { brideName }),
      ...(groomName   !== undefined && { groomName }),
      ...(language    !== undefined && { language }),
      ...(isPublished !== undefined && { isPublished }),
      ...(slug        !== undefined && { slug }),
      ...(eventType   !== undefined && { eventType }),
      ...(community   !== undefined && { community }),
      ...(instagramUrl !== undefined && { instagramUrl: normalizeOptionalHttpUrl(instagramUrl) }),
      ...(socialYoutubeUrl !== undefined && { socialYoutubeUrl: normalizeOptionalHttpUrl(socialYoutubeUrl) }),
      ...(websiteUrl !== undefined && { websiteUrl: normalizeOptionalHttpUrl(websiteUrl) }),
      ...(rsvpEnabled !== undefined && { rsvpEnabled: Boolean(rsvpEnabled) }),
      ...(guestNotesEnabled !== undefined && { guestNotesEnabled: Boolean(guestNotesEnabled) }),
    },
  });

  if (isPublished === true && !event.isPublished) {
    const owner = await prisma.user.findUnique({
      where: { id: event.ownerId },
      select: { email: true },
    });
    if (owner?.email) {
      const inviteUrl = `${siteUrls.apiBaseUrl()}/i/${updated.slug}`;
      sendInvitationPublishedEmail({ to: owner.email, inviteUrl }).catch(() => {});
    }
  }

  // Replace/sync functions: update existing, create new (no id), delete removed
  if (Array.isArray(functions)) {
    if (functions.length < 1) {
      return res.status(400).json({ ok: false, message: 'At least one function (event) is required' });
    }

    const existingRows = await prisma.function.findMany({
      where: { eventId },
      select: { id: true },
    });
    const existingSet = new Set(existingRows.map((r) => r.id));
    const incomingWithId = functions.filter((f) => f.id);
    for (const f of incomingWithId) {
      if (!existingSet.has(f.id)) {
        return res.status(400).json({ ok: false, message: 'One or more function ids do not belong to this invitation' });
      }
    }

    for (const fn of functions) {
      const dateVal = fn.date ? new Date(fn.date) : new Date();
      if (Number.isNaN(dateVal.getTime())) {
        return res.status(400).json({ ok: false, message: 'Invalid function date' });
      }
    }

    const sortResEdit = resolveFunctionSortOrders(functions);
    if (sortResEdit.error) {
      return res.status(400).json({ ok: false, message: sortResEdit.error });
    }
    const sortOrdersEdit = sortResEdit.orders;

    const mapEdit = [];
    for (const fn of functions) {
      const m = resolveFunctionVenueMap(fn);
      if (m.error) return res.status(400).json({ ok: false, message: m.error });
      mapEdit.push({ venueLat: m.venueLat, venueLng: m.venueLng, venueMapUrl: m.venueMapUrl });
    }

    await prisma.$transaction(async (tx) => {
      const incomingIdSet = new Set(incomingWithId.map((f) => f.id));
      const toDelete = [...existingSet].filter((id) => !incomingIdSet.has(id));
      if (toDelete.length) {
        await tx.function.deleteMany({ where: { id: { in: toDelete } } });
      }

      for (let idx = 0; idx < functions.length; idx++) {
        const fn = functions[idx];
        const name = String(fn.name ?? '').trim() || 'Event';
        const dateVal = fn.date ? new Date(fn.date) : new Date();
        const dressCode = fn.dressCode != null && String(fn.dressCode).trim() !== ''
          ? String(fn.dressCode).trim()
          : null;
        const { venueLat, venueLng, venueMapUrl } = mapEdit[idx];
        const base = {
          name,
          date:          dateVal,
          startTime:     fn.startTime != null && fn.startTime !== '' ? fn.startTime : null,
          venueName:     fn.venueName != null && fn.venueName !== '' ? fn.venueName : null,
          venueAddress:  fn.venueAddress != null && fn.venueAddress !== '' ? fn.venueAddress : null,
          venueLat,
          venueLng,
          venueMapUrl,
          dressCode,
          sortOrder:     sortOrdersEdit[idx],
        };
        if (fn.id) {
          await tx.function.update({ where: { id: fn.id }, data: base });
        } else {
          await tx.function.create({ data: { ...base, eventId } });
        }
      }
    });
  }

  // ── Replace people (delete all + re-create) ──
  if (Array.isArray(people)) {
    await prisma.eventPerson.deleteMany({ where: { eventId } });
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      await prisma.eventPerson.create({
        data: {
          eventId,
          role:      String(p.role || 'guest'),
          name:      String(p.name || ''),
          photoUrl:  p.photoUrl || null,
          extraData: p.extraData || null,
          sortOrder: p.sortOrder ?? i,
        },
      });
    }
  }

  // ── Replace venues (delete all + re-create) ──
  if (Array.isArray(venues)) {
    // Unlink functions from old venues first
    await prisma.function.updateMany({
      where: { eventId, venueId: { not: null } },
      data:  { venueId: null },
    });
    await prisma.venue.deleteMany({ where: { eventId } });
    for (const v of venues) {
      await prisma.venue.create({
        data: {
          eventId,
          name:    String(v.name || ''),
          address: v.address || null,
          lat:     v.lat != null ? Number(v.lat) : null,
          lng:     v.lng != null ? Number(v.lng) : null,
          mapUrl:  v.mapUrl || null,
          city:    v.city || null,
          state:   v.state || null,
        },
      });
    }
  }

  // ── Replace custom fields (upsert by key) ──
  if (Array.isArray(customFields)) {
    // Delete keys not in the new list
    const newKeys = customFields.map(cf => String(cf.fieldKey || cf.key));
    await prisma.eventCustomField.deleteMany({
      where: { eventId, fieldKey: { notIn: newKeys } },
    });
    for (const cf of customFields) {
      const key = String(cf.fieldKey || cf.key);
      const val = String(cf.fieldValue || cf.value || '');
      const typ = cf.fieldType || cf.type || 'text';
      await prisma.eventCustomField.upsert({
        where:  { eventId_fieldKey: { eventId, fieldKey: key } },
        update: { fieldValue: val, fieldType: typ },
        create: { eventId, fieldKey: key, fieldValue: val, fieldType: typ },
      });
    }
  }

  // Invalidate render cache when event data changes
  await prisma.eventRenderCache.deleteMany({ where: { eventId } });

  res.json({ ok: true, data: updated });
}

// POST /api/v1/users/:id/swap-template
// Body: { eventId, newTemplateId }
// If new template is more expensive → create Razorpay payment link, send email
// If same or cheaper → swap immediately
async function swapTemplate(req, res) {
  const { eventId, newTemplateId } = req.body;
  if (!eventId || !newTemplateId) {
    return res.status(400).json({ ok: false, message: 'eventId and newTemplateId required' });
  }

  const [user, event, newTemplate] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: req.params.id } }),
    prisma.event.findFirst({
      where: { id: eventId, ownerId: req.params.id },
      include: { template: true },
    }),
    prisma.template.findUniqueOrThrow({ where: { id: newTemplateId } }),
  ]);

  if (!event) return res.status(404).json({ ok: false, message: 'Event not found for this user' });

  const oldPrice = event.template.price;
  const newPrice = newTemplate.price;
  const balance  = newPrice - oldPrice;

  // Same or cheaper — swap immediately
  if (balance <= 0) {
    await prisma.event.update({
      where: { id: eventId },
      data:  { templateId: newTemplateId },
    });
    await prisma.eventRenderCache.deleteMany({ where: { eventId } });
    return res.json({ ok: true, status: 'swapped', message: 'Template swapped immediately (no charge)' });
  }

  // More expensive — cancel older pending swaps for this invite, then payment link + email
  await prisma.templateSwapRequest.updateMany({
    where: { eventId, status: 'pending' },
    data:  { status: 'cancelled' },
  });

  const link = await createPaymentLinkOrPlaceholder({
    amountPaise:   balance,
    description:   `Balance payment to upgrade invitation template to "${newTemplate.name}"`,
    customerName:  user.username || user.email,
    customerEmail: user.email,
    customerPhone: user.phone || undefined,
    notes: {
      userId:         user.id,
      eventId,
      fromTemplateId: event.templateId,
      toTemplateId:   newTemplateId,
    },
  });

  await prisma.templateSwapRequest.create({
    data: {
      userId:          user.id,
      eventId,
      fromTemplateId:  event.templateId,
      toTemplateId:    newTemplateId,
      balanceAmount:   balance,
      razorpayLinkId:  link.id,
      razorpayLinkUrl: link.short_url,
    },
  });

  await sendBalancePaymentEmail({
    to:              user.email,
    name:            user.username || 'there',
    templateName:    newTemplate.name,
    balanceAmount:   balance,
    paymentLink:     link.short_url,
    isPlaceholder:   link.isPlaceholder,
  });

  res.json({
    ok:                true,
    status:            'payment_link_sent',
    paymentLink:       link.short_url,
    balance,
    usedPlaceholderLink: link.isPlaceholder,
    message: link.isPlaceholder
      ? `Email queued for ${user.email} with a placeholder pay link (configure Razorpay + TEMPLATE_SWAP_PLACEHOLDER_PAY_URL for real links). Webhook will apply the template only after a real Razorpay payment.`
      : `Payment link sent to ${user.email}`,
  });
}

// POST /api/v1/users/:id/swap-paired-template
// Body: { invitePairId, newTemplateId } — updates full + partial invites together
async function swapPairedTemplate(req, res) {
  const { invitePairId, newTemplateId } = req.body;
  if (!invitePairId || !newTemplateId) {
    return res.status(400).json({ ok: false, message: 'invitePairId and newTemplateId required' });
  }

  const userId = req.params.id;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const [full, subset] = await Promise.all([
    prisma.event.findFirst({
      where: { ownerId: userId, invitePairId, inviteScope: 'full' },
      include: { template: true },
    }),
    prisma.event.findFirst({
      where: { ownerId: userId, invitePairId, inviteScope: 'subset' },
      include: { template: true },
    }),
  ]);

  if (!full || !subset) {
    return res.status(404).json({ ok: false, message: 'Paired invitations not found for this user' });
  }
  if (full.templateId !== subset.templateId) {
    return res.status(400).json({
      ok:      false,
      message: 'Full and partial invites use different templates; swap them individually from the API or align templates first',
    });
  }

  const newTemplate = await prisma.template.findUniqueOrThrow({ where: { id: newTemplateId } });
  const oldPrice = full.template.price;
  const newPrice = newTemplate.price;
  const balance  = newPrice - oldPrice;

  if (balance <= 0) {
    await prisma.$transaction([
      prisma.event.update({ where: { id: full.id }, data: { templateId: newTemplateId } }),
      prisma.event.update({ where: { id: subset.id }, data: { templateId: newTemplateId } }),
    ]);
    await prisma.eventRenderCache.deleteMany({
      where: { eventId: { in: [full.id, subset.id] } },
    });
    return res.json({
      ok:      true,
      status:  'swapped',
      message: 'Template updated on both full and partial invitations (no extra charge)',
    });
  }

  await prisma.templateSwapRequest.updateMany({
    where: {
      OR: [
        { eventId: full.id, status: 'pending' },
        { eventId: subset.id, status: 'pending' },
      ],
    },
    data: { status: 'cancelled' },
  });

  const link = await createPaymentLinkOrPlaceholder({
    amountPaise:   balance,
    description:   `Balance payment to upgrade both paired invitations to "${newTemplate.name}"`,
    customerName:  user.username || user.email,
    customerEmail: user.email,
    customerPhone: user.phone || undefined,
    notes: {
      userId:         user.id,
      eventId:        full.id,
      pairedEventId:  subset.id,
      fromTemplateId: full.templateId,
      toTemplateId:   newTemplateId,
      pairedSwap:     true,
    },
  });

  await prisma.templateSwapRequest.create({
    data: {
      userId:          user.id,
      eventId:         full.id,
      pairedEventId:   subset.id,
      fromTemplateId:  full.templateId,
      toTemplateId:    newTemplateId,
      balanceAmount:   balance,
      razorpayLinkId:  link.id,
      razorpayLinkUrl: link.short_url,
    },
  });

  await sendBalancePaymentEmail({
    to:              user.email,
    name:            user.username || 'there',
    templateName:    newTemplate.name,
    balanceAmount:   balance,
    paymentLink:     link.short_url,
    isPlaceholder:   link.isPlaceholder,
  });

  res.json({
    ok:                  true,
    status:              'payment_link_sent',
    paymentLink:         link.short_url,
    balance,
    usedPlaceholderLink: link.isPlaceholder,
    message: link.isPlaceholder
      ? `Email queued for ${user.email} with a placeholder pay link. Configure Razorpay for real checkout; webhook applies the template after payment.`
      : `Payment link sent to ${user.email} (covers both full and partial invites)`,
  });
}

// POST /api/v1/users/:id/events/:eventId/media — admin uploads media for a user’s event
async function uploadEventMediaAsAdmin(req, res) {
  const ownerId = req.params.id;
  const { eventId } = req.params;
  const result = await addEventMedia(prisma, { eventId, expectedOwnerId: ownerId, req });
  if (result.error) {
    return res.status(result.error.status).json({ ok: false, message: result.error.message });
  }
  await prisma.eventRenderCache.deleteMany({ where: { eventId } });
  return res.status(201).json({ ok: true, media: result.media });
}

// DELETE /api/v1/users/:id/events/:eventId/media/:mediaId
async function deleteEventMediaAsAdmin(req, res) {
  const ownerId = req.params.id;
  const { eventId, mediaId } = req.params;
  const result = await removeEventMedia(prisma, { eventId, mediaId, expectedOwnerId: ownerId });
  if (result.error) {
    return res.status(result.error.status).json({ ok: false, message: result.error.message });
  }
  await prisma.eventRenderCache.deleteMany({ where: { eventId } });
  return res.json({ ok: true });
}

// GET /api/v1/users/:id/events/:eventId/preview-token — signed draft preview URL (admin)
async function getEventPreviewToken(req, res) {
  const ownerId = req.params.id;
  const { eventId } = req.params;
  const event = await prisma.event.findFirst({
    where: { id: eventId, ownerId },
    select: { slug: true },
  });
  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }
  const pt = mintInvitePreviewToken(event.slug);
  const base = siteUrls.apiBaseUrl().replace(/\/$/, '');
  const previewUrl = `${base}/i/${encodeURIComponent(event.slug)}/preview?pt=${encodeURIComponent(pt)}`;
  return res.json({ ok: true, previewUrl });
}

// PATCH /api/v1/users/:id/profile — admin updates phone (username is immutable here)
async function updateProfile(req, res) {
  const { phone } = req.body;
  if (phone === undefined) {
    return res.status(400).json({ ok: false, message: 'No fields to update' });
  }
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { phone },
    select: { id: true, email: true, username: true, phone: true, createdAt: true },
  });
  res.json({ ok: true, data: user });
}

module.exports = {
  list,
  get,
  resetPassword,
  freezeNames,
  updateEventData,
  swapTemplate,
  swapPairedTemplate,
  updateProfile,
  generatePairedInvites,
  uploadEventMediaAsAdmin,
  deleteEventMediaAsAdmin,
  getEventPreviewToken,
};
