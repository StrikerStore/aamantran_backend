const express = require('express');
const { sendMail } = require('../services/email.service');
const { checkoutLimiter } = require('../middleware/rateLimits');
const { normalizePhone, formatPhone } = require('../utils/phone');

const router = express.Router();

const ADMIN_EMAIL = process.env.CONTACT_FORM_TO || process.env.ADMIN_EMAIL;

// Deliberately permissive: the point is to catch a typo or an empty box, not to
// adjudicate RFC 5322. Anything stricter rejects real addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validate the enquiry, in the order the fields appear on the form.
 *
 * This exists because the browser cannot be trusted to have done it: the form
 * previously carried `noValidate` and its manual check omitted phone entirely,
 * and in any case a direct POST skips the page altogether. `normalizePhone` is
 * the same helper checkout and onboarding use, so a number accepted here looks
 * like every other number in the system.
 *
 * @returns {string|null} the first problem, or null when the enquiry is usable.
 */
function firstProblem({ name, phone, phoneCountryCode, email, message }) {
  if (!String(name || '').trim()) return 'Please enter your name.';

  const parsedPhone = normalizePhone(phoneCountryCode, phone);
  if (!parsedPhone.valid) return parsedPhone.reason;

  const mail = String(email || '').trim();
  if (!mail) return 'Please enter your email address.';
  if (!EMAIL_RE.test(mail)) return 'Please enter a valid email address.';

  if (!String(message || '').trim()) return 'Please tell us a little about what you need.';
  return null;
}

// POST /api/contact
router.post('/', checkoutLimiter, async (req, res) => {
  const { name, phone, phoneCountryCode, email, eventType, eventDate, message } = req.body || {};

  const problem = firstProblem({ name, phone, phoneCountryCode, email, message });
  if (problem) {
    return res.status(400).json({ ok: false, message: problem });
  }

  // Shown in full dial-code form so the team can call or WhatsApp it straight
  // from the email, whichever country it came from.
  const parsedPhone = normalizePhone(phoneCountryCode, phone);
  const displayPhone = formatPhone(parsedPhone.countryCode, parsedPhone.national);

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
      <tr><td style="padding:6px 12px;font-weight:bold;">Phone</td><td style="padding:6px 12px;">${sanitize(displayPhone)}</td></tr>
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
