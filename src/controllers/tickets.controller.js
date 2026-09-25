const prisma = require('../utils/prisma');
const { sendTicketReplyEmail } = require('../services/email.service');
const siteUrls = require('../config/siteUrls');
const { EXCLUDE_TEST_OWNER } = require('../utils/testFilters');

// GET /api/v1/tickets
async function list(req, res) {
  const { status, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = { ...(status ? { status } : {}), ...EXCLUDE_TEST_OWNER };

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      skip,
      take:    Number(limit),
      orderBy: { updatedAt: 'desc' },
      include: {
        user:  { select: { id: true, username: true, email: true } },
        event: { select: { id: true, slug: true, person1Name: true, person2Name: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  res.json({ ok: true, data: tickets, total, page: Number(page), limit: Number(limit) });
}

// GET /api/v1/tickets/:id
async function get(req, res) {
  const ticket = await prisma.supportTicket.findUniqueOrThrow({
    where: { id: req.params.id },
    include: {
      user:     { select: { id: true, username: true, email: true, phone: true, phoneCountryCode: true } },
      event:    { select: { id: true, slug: true, person1Name: true, person2Name: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  res.json({ ok: true, data: ticket });
}

// GET /api/v1/tickets/:id/messages?since=<ISO>
/**
 * Just the messages, optionally only those newer than `since`.
 *
 * Polled by an open ticket thread so it stays current without re-fetching the
 * whole ticket - user, event and every message - every few seconds. With
 * nothing new this is an empty array and a status.
 *
 * Kept separate from `get` rather than added as a flag on it: that route has
 * callers expecting a full ticket, and a query parameter that quietly changes
 * the response shape is what breaks something months later.
 */
async function messages(req, res) {
  const ticket = await prisma.supportTicket.findUniqueOrThrow({
    where:  { id: req.params.id },
    select: { id: true, status: true },
  });

  // An absent or unparseable `since` returns the whole thread, so a caller with
  // a bad value degrades to a plain refresh instead of an error.
  let where = { ticketId: ticket.id };
  if (req.query.since) {
    const at = new Date(String(req.query.since));
    if (!Number.isNaN(at.getTime())) where.createdAt = { gt: at };
  }

  const list = await prisma.ticketMessage.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });
  res.json({ ok: true, messages: list, status: ticket.status });
}

// POST /api/v1/tickets/:id/reply
async function reply(req, res) {
  const { body } = req.body;
  if (!body?.trim()) {
    return res.status(400).json({ ok: false, message: 'Reply body is required' });
  }

  const ticket = await prisma.supportTicket.findUniqueOrThrow({
    where:   { id: req.params.id },
    include: { user: true },
  });

  const message = await prisma.ticketMessage.create({
    data: {
      ticketId:   ticket.id,
      senderRole: 'admin',
      body:       body.trim(),
    },
  });

  // Bump updatedAt so it surfaces in the sorted list
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data:  { updatedAt: new Date() },
  });

  // Email the user
  const ticketUrl = `${siteUrls.coupleDashboardUrl()}/support/${ticket.id}`;
  await sendTicketReplyEmail({
    to:        ticket.user.email,
    name:      ticket.user.username || 'there',
    subject:   ticket.subject,
    replyBody: body.trim(),
    ticketUrl,
  }).catch(err => console.error('Email send failed:', err.message));

  res.json({ ok: true, data: message });
}

// PATCH /api/v1/tickets/:id/resolve
async function resolve(req, res) {
  const ticket = await prisma.supportTicket.update({
    where: { id: req.params.id },
    data:  { status: 'resolved' },
  });
  res.json({ ok: true, data: ticket });
}

// PATCH /api/v1/tickets/:id/reopen
async function reopen(req, res) {
  const ticket = await prisma.supportTicket.update({
    where: { id: req.params.id },
    data:  { status: 'open' },
  });
  res.json({ ok: true, data: ticket });
}

module.exports = { list, get, messages, reply, resolve, reopen };
