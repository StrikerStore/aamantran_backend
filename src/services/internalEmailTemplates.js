/**
 * Team-facing notification emails, plus the customer's ticket acknowledgement.
 *
 * These deliberately skip the branded customer layout: what matters for an
 * internal alert is scanning it on a phone and having the reference to hand,
 * not decoration. The one exception is `ticketReceivedHtml`, which goes to the
 * customer and therefore reuses the normal branding.
 *
 * Everything interpolated here goes through `esc()`. Ticket subjects, ticket
 * bodies and review text are written by users, and these are HTML emails — an
 * unescaped angle bracket would at best break the layout and at worst let a
 * customer inject markup into a mailbox we read.
 */
const {
  wrapInLayout, infoCard, infoRow, divider, BRAND, GOLD,
} = require('./emailTemplates');

/** Escape text destined for an HTML email body. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Preserve the author's line breaks without letting the text emit markup. */
function escMultiline(value) {
  return esc(value).replace(/\r?\n/g, '<br>');
}

function rupees(paise) {
  return `₹${(Number(paise || 0) / 100).toLocaleString('en-IN')}`;
}

function internalLayout(title, rowsHtml, extraHtml = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:640px;margin:24px auto;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden;">
    <div style="background:${BRAND};padding:18px 24px;">
      <div style="font-size:11px;letter-spacing:3px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Aamantran &mdash; internal</div>
      <div style="font-size:19px;font-weight:700;color:#fff;margin-top:4px;">${esc(title)}</div>
    </div>
    <div style="padding:22px 24px;color:#22262b;line-height:1.6;font-size:14px;">
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
        ${rowsHtml}
      </table>
      ${extraHtml}
    </div>
  </div>
</body>
</html>`;
}

function internalRow(label, valueHtml) {
  return `<tr>
    <td style="padding:7px 0;font-size:12px;color:#6b7280;white-space:nowrap;vertical-align:top;width:150px;">${esc(label)}</td>
    <td style="padding:7px 0;font-size:14px;color:#22262b;font-weight:600;">${valueHtml}</td>
  </tr>`;
}

function quoteBlock(heading, bodyHtml) {
  return `<div style="margin-top:20px;">
    <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${esc(heading)}</div>
    <div style="background:#f7f8fa;border-left:3px solid ${BRAND};border-radius:0 6px 6px 0;padding:12px 14px;font-size:14px;color:#22262b;">${bodyHtml}</div>
  </div>`;
}

function internalBtn(text, url) {
  return `<div style="margin-top:20px;">
    <a href="${esc(url)}" style="display:inline-block;padding:10px 20px;background:${BRAND};color:#fff;font-size:14px;font-weight:600;border-radius:6px;text-decoration:none;">${esc(text)} &rarr;</a>
  </div>`;
}

function mailtoLink(email) {
  return `<a href="mailto:${esc(email)}" style="color:${BRAND};">${esc(email)}</a>`;
}

/** Team alert: a template was purchased. */
function adminOrderPlacedHtml({
  orderId, templateName, amount, discountAmount, couponCode,
  customerEmail, paymentId, mihpayid, purchasedAt, adminUrl,
}) {
  const discount = Number(discountAmount || 0);
  const rows = [
    internalRow('Order ID', `<span style="font-family:monospace;letter-spacing:1px;">${esc(orderId || '—')}</span>`),
    internalRow('Template', esc(templateName)),
    internalRow('Amount paid', `<span style="color:#1a7f4b;">${rupees(amount)}</span>`),
    discount > 0
      ? internalRow(
          'Discount',
          `${rupees(discount)}${couponCode ? ` (${esc(couponCode)})` : ''} &nbsp;<span style="color:#6b7280;font-weight:400;">list ${rupees(Number(amount || 0) + discount)}</span>`
        )
      : '',
    internalRow('Customer', customerEmail ? mailtoLink(customerEmail) : '—'),
    internalRow('PayU ref', `<span style="font-family:monospace;">${esc(mihpayid || '—')}</span>`),
    internalRow('Payment ID', `<span style="font-family:monospace;font-size:12px;">${esc(paymentId)}</span>`),
    internalRow('Placed at', esc(purchasedAt)),
  ].filter(Boolean).join('');

  return internalLayout('Order placed', rows, adminUrl ? internalBtn('Open in admin', adminUrl) : '');
}

/** Team alert: a support ticket was opened. */
function adminTicketRaisedHtml({
  ticketRef, ticketId, subject, message, userName, userEmail, eventName, createdAt, adminUrl,
}) {
  const from = `${esc(userName || '—')}${userEmail ? ` &lt;${mailtoLink(userEmail)}&gt;` : ''}`;
  const rows = [
    internalRow('Ticket', `<span style="font-family:monospace;letter-spacing:1px;">${esc(ticketRef)}</span>`),
    internalRow('Subject', esc(subject)),
    internalRow('From', from),
    eventName ? internalRow('Event', esc(eventName)) : '',
    internalRow('Raised at', esc(createdAt)),
    internalRow('Ticket ID', `<span style="font-family:monospace;font-size:12px;">${esc(ticketId)}</span>`),
  ].filter(Boolean).join('');

  return internalLayout(
    'New support ticket',
    rows,
    quoteBlock('Message', escMultiline(message))
      + (adminUrl ? internalBtn('Reply in admin', adminUrl) : '')
  );
}

/** Team alert: a review was posted or edited. */
function adminReviewPostedHtml({
  rating, reviewText, coupleNames, location, templateName,
  userName, userEmail, isUpdate, postedAt, adminUrl,
}) {
  const score = Math.max(0, Math.min(5, Number(rating) || 0));
  const stars = '★'.repeat(score) + '☆'.repeat(5 - score);
  const from = `${esc(userName || '—')}${userEmail ? ` &lt;${mailtoLink(userEmail)}&gt;` : ''}`;

  const rows = [
    internalRow(
      'Rating',
      `<span style="color:${GOLD};font-size:16px;letter-spacing:2px;">${stars}</span>`
      + ` <span style="color:#6b7280;font-weight:400;">${esc(score)}/5</span>`
    ),
    internalRow('Template', esc(templateName)),
    internalRow('From', from),
    coupleNames ? internalRow('Couple', esc(coupleNames)) : '',
    location ? internalRow('Location', esc(location)) : '',
    internalRow('Posted at', esc(postedAt)),
  ].filter(Boolean).join('');

  const body = reviewText
    ? quoteBlock('Review', escMultiline(reviewText))
    : '<p style="margin-top:18px;color:#6b7280;font-size:13px;">No written review &mdash; rating only.</p>';

  return internalLayout(
    isUpdate ? 'Review updated' : 'New review posted',
    rows,
    body + (adminUrl ? internalBtn('Open reviews', adminUrl) : '')
  );
}

/** Customer-facing: their ticket reached us. */
function ticketReceivedHtml({ name, ticketRef, subject, message }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">We have your message${name ? `, ${esc(name)}` : ''}</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">Thank you for reaching out. Your ticket is with our team and we will get back to you within <strong>24&ndash;48 hours</strong>.</p>
    ${infoCard(`
      ${infoRow('Reference', `<span style="font-family:monospace;letter-spacing:1px;font-weight:700;color:${BRAND};">${esc(ticketRef)}</span>`)}
      ${infoRow('Subject', esc(subject))}
    `)}
    ${quoteBlock('What you sent us', escMultiline(message))}
    ${divider()}
    <p style="margin:0;color:#5a3a3a;font-size:14px;">You will get our reply by email, and you can follow the conversation any time from the Support section of your dashboard.</p>
    <p style="margin:20px 0 0;font-size:13px;color:#b09080;">Please keep this reference handy if you need to follow up.</p>
  `, {
    accentEmoji: '\u{1F3AB}',
    heroTitle: 'Support ticket received',
    heroSubtitle: 'Our team will reply within 24-48 hours',
  });
}

module.exports = {
  adminOrderPlacedHtml,
  adminTicketRaisedHtml,
  adminReviewPostedHtml,
  ticketReceivedHtml,
  esc,
};
