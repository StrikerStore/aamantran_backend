const express = require('express');
const { sendMail } = require('../services/email.service');
const { checkoutLimiter } = require('../middleware/rateLimits');

const router = express.Router();

const ADMIN_EMAIL = process.env.CONTACT_FORM_TO || process.env.ADMIN_EMAIL;

// POST /api/contact
router.post('/', checkoutLimiter, async (req, res) => {
  const { name, phone, email, eventType, eventDate, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, message: 'Name, email, and message are required' });
  }

  if (!ADMIN_EMAIL) {
    console.error('[Contact] No CONTACT_FORM_TO or ADMIN_EMAIL configured');
    return res.status(500).json({ ok: false, message: 'Contact form is not configured' });
  }

  const sanitize = (v) => String(v || '').replace(/[<>]/g, '').trim();

  const html = `
    <h2>New Contact Form Submission</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;">
      <tr><td style="padding:6px 12px;font-weight:bold;">Name</td><td style="padding:6px 12px;">${sanitize(name)}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold;">Email</td><td style="padding:6px 12px;"><a href="mailto:${sanitize(email)}">${sanitize(email)}</a></td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold;">Phone</td><td style="padding:6px 12px;">${sanitize(phone) || '—'}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold;">Event Type</td><td style="padding:6px 12px;">${sanitize(eventType) || '—'}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold;">Event Date</td><td style="padding:6px 12px;">${sanitize(eventDate) || '—'}</td></tr>
    </table>
    <h3>Message</h3>
    <p style="white-space:pre-wrap;">${sanitize(message)}</p>
  `;

  try {
    await sendMail({
      to: ADMIN_EMAIL,
      subject: `Aamantran Contact: ${sanitize(name)}`,
      html,
    });
    return res.json({ ok: true, message: 'Message sent successfully' });
  } catch (err) {
    console.error('[Contact] Failed to send email:', err.message);
    return res.status(500).json({ ok: false, message: 'Failed to send message. Please try again.' });
  }
});

module.exports = router;
