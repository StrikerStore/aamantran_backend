const express = require('express');
const prisma = require('../utils/prisma');
const { publicInviteLimiter } = require('../middleware/rateLimits');

const router = express.Router();
router.use(publicInviteLimiter);

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const requestCounts = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip, key) {
  const now = Date.now();
  const bucket = `${key}:${ip}`;
  const history = requestCounts.get(bucket) || [];
  const recent = history.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    requestCounts.set(bucket, recent);
    return true;
  }
  recent.push(now);
  requestCounts.set(bucket, recent);
  return false;
}

function sanitizeText(value, maxLen) {
  const raw = String(value || '').trim();
  const truncated = maxLen ? raw.slice(0, maxLen) : raw;
  return truncated
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

async function getEventBySlug(eventSlug) {
  return prisma.event.findUnique({
    where: { slug: eventSlug },
    include: {
      functions: { orderBy: { sortOrder: 'asc' } },
    },
  });
}

async function resolveWishOwnerEventId(event) {
  if (!event?.invitePairId) return event?.id || null;
  const fullEvent = await prisma.event.findFirst({
    where: { invitePairId: event.invitePairId, inviteScope: 'full' },
    select: { id: true },
  });
  return fullEvent?.id || event.id;
}

// GET /api/public/functions/:eventSlug
router.get('/functions/:eventSlug', async (req, res) => {
  const event = await getEventBySlug(req.params.eventSlug);
  if (!event || !event.isPublished) {
    return res.status(404).json({ message: 'Invitation not found' });
  }
  const functions = (event.functions || []).map((fn) => ({
    id: fn.id,
    name: fn.name,
    date: fn.date,
  }));
  return res.json({ success: true, functions });
});

// POST /api/public/rsvp
router.post('/rsvp', async (req, res) => {
  const ip = getClientIp(req);
  if (isRateLimited(ip, 'rsvp')) {
    return res.status(429).json({ message: 'Too many RSVP submissions. Please try again later.' });
  }

  const {
    eventSlug,
    guestName,
    phone,
    email,
    attending,
    plusCount,
    mealPreference,
    message,
    functionIds,
  } = req.body || {};

  if (!eventSlug || !guestName || typeof attending !== 'boolean') {
    return res.status(400).json({ message: 'eventSlug, guestName and attending are required' });
  }

  const event = await getEventBySlug(eventSlug);
  if (!event || !event.isPublished) {
    return res.status(404).json({ message: 'Invitation not found' });
  }
  if (event.rsvpEnabled === false) {
    return res.status(403).json({ message: 'RSVP is not enabled for this invitation' });
  }

  const allowedFunctionIds = new Set((event.functions || []).map((fn) => fn.id));
  const requestedFunctionIds = Array.isArray(functionIds) ? functionIds.filter(Boolean) : [];
  const selectedFunctionIds = requestedFunctionIds.length
    ? requestedFunctionIds
    : (event.functions.length === 1 ? [event.functions[0].id] : []);

  if (!selectedFunctionIds.length || selectedFunctionIds.some((id) => !allowedFunctionIds.has(id))) {
    return res.status(400).json({ message: 'Please provide valid functionIds for this invitation' });
  }

  const cleanGuestName = sanitizeText(guestName, 120);
  const cleanPhone = sanitizeText(phone, 30) || null;
  const cleanEmail = sanitizeText(email, 200).toLowerCase() || null;
  const cleanMeal = sanitizeText(mealPreference, 50) || null;
  const cleanMessage = sanitizeText(message, 500) || null;
  const safePlusCount = Number.isFinite(Number(plusCount)) ? Math.max(0, Math.min(20, Number(plusCount))) : 0;

  let guest = null;
  if (cleanPhone) {
    guest = await prisma.guest.findFirst({
      where: { eventId: event.id, name: cleanGuestName, phone: cleanPhone },
    });
  } else if (cleanEmail) {
    guest = await prisma.guest.findFirst({
      where: { eventId: event.id, name: cleanGuestName, email: cleanEmail },
    });
  }

  if (!guest) {
    guest = await prisma.guest.create({
      data: {
        eventId: event.id,
        name: cleanGuestName,
        phone: cleanPhone,
        email: cleanEmail,
      },
    });
  }

  await prisma.$transaction(
    selectedFunctionIds.map((functionId) =>
      prisma.rsvp.upsert({
        where: { guestId_functionId: { guestId: guest.id, functionId } },
        update: {
          attending,
          plusCount: safePlusCount,
          mealPreference: cleanMeal,
          message: cleanMessage,
          submittedAt: new Date(),
        },
        create: {
          eventId: event.id,
          guestId: guest.id,
          functionId,
          attending,
          plusCount: safePlusCount,
          mealPreference: cleanMeal,
          message: cleanMessage,
        },
      })
    )
  );

  await prisma.invitationEvent.create({
    data: {
      eventId: event.id,
      guestId: guest.id,
      type: 'rsvp_submitted',
      metadata: {
        functionIds: selectedFunctionIds,
        ip,
      },
    },
  }).catch(() => {});

  return res.json({ success: true, guestId: guest.id });
});

// GET /api/public/wishes/:eventSlug
router.get('/wishes/:eventSlug', async (req, res) => {
  const event = await prisma.event.findUnique({
    where: { slug: req.params.eventSlug },
    select: { id: true, isPublished: true, invitePairId: true, inviteScope: true, guestNotesEnabled: true },
  });
  if (!event || !event.isPublished) {
    return res.status(404).json({ message: 'Invitation not found' });
  }
  if (event.guestNotesEnabled === false) {
    return res.json({ success: true, wishes: [] });
  }
  const wishOwnerEventId = await resolveWishOwnerEventId(event);

  const wishes = await prisma.guestWish.findMany({
    where: { eventId: wishOwnerEventId, isApproved: true },
    orderBy: { createdAt: 'desc' },
    select: { id: true, guestName: true, message: true, createdAt: true },
  });
  return res.json({ success: true, wishes });
});

// POST /api/public/wishes
router.post('/wishes', async (req, res) => {
  const ip = getClientIp(req);
  if (isRateLimited(ip, 'wish')) {
    return res.status(429).json({ message: 'Too many wish submissions. Please try again later.' });
  }

  const { eventSlug, guestName, message } = req.body || {};
  if (!eventSlug || !guestName || !message) {
    return res.status(400).json({ message: 'eventSlug, guestName and message are required' });
  }

  const event = await prisma.event.findUnique({
    where: { slug: eventSlug },
    select: { id: true, isPublished: true, invitePairId: true, inviteScope: true, guestNotesEnabled: true },
  });
  if (!event || !event.isPublished) {
    return res.status(404).json({ message: 'Invitation not found' });
  }
  if (event.guestNotesEnabled === false) {
    return res.status(403).json({ message: 'Guest notes are not enabled for this invitation' });
  }
  const wishOwnerEventId = await resolveWishOwnerEventId(event);

  const cleanGuestName = sanitizeText(guestName, 120);
  const cleanMessage = sanitizeText(message, 500);
  if (!cleanMessage) {
    return res.status(400).json({ message: 'message is required' });
  }

  const wish = await prisma.guestWish.create({
    data: {
      eventId: wishOwnerEventId,
      guestName: cleanGuestName,
      message: cleanMessage,
      isApproved: true,
    },
    select: {
      id: true,
      guestName: true,
      message: true,
      createdAt: true,
    },
  });

  return res.json({ success: true, wishId: wish.id, wish });
});

module.exports = router;
