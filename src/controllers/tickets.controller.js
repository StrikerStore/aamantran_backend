const prisma = require('../utils/prisma');
const { sendTicketReplyEmail } = require('../services/email.service');
const siteUrls = require('../config/siteUrls');

// GET /api/v1/tickets
async function list(req, res) {
  const { status, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = status ? { status } : {};

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      skip,
      take:    Number(limit),
      orderBy: { updatedAt: 'desc' },
      include: {
        user:  { select: { id: true, username: true, email: true } },
        event: { select: { id: true, slug: true, brideName: true, groomName: true } },
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
      user:     { select: { id: true, username: true, email: true, phone: true } },
      event:    { select: { id: true, slug: true, brideName: true, groomName: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  res.json({ ok: true, data: ticket });
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

module.exports = { list, get, reply, resolve, reopen };
