const nodemailer = require('nodemailer');
const {
  purchaseConfirmationHtml,
  onboardingReminderHtml,
  abandonedCheckoutHtml,
  onboardingCompleteHtml,
  invitationPublishedHtml,
  rsvpMilestoneHtml,
  eventCountdownHtml,
  postEventThankYouHtml,
  templateChangedHtml,
  guestDataDeletionWarningHtml,
  accountDeletedHtml,
  dpdpNoticeHtml,
} = require('./emailTemplates');
const {
  adminOrderPlacedHtml,
  adminTicketRaisedHtml,
  adminReviewPostedHtml,
  ticketReceivedHtml,
} = require('./internalEmailTemplates');

let _transport = null;
function getTransport() {
  if (_transport) return _transport;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.');
  }

  _transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return _transport;
}

const FROM = process.env.EMAIL_FROM || process.env.SMTP_USER || 'aamantran@plexzuu.com';

async function sendMail({ to, subject, html }) {
  return getTransport().sendMail({ from: FROM, to, subject, html });
}

/**
 * Send a balance payment link email when admin swaps user to a pricier template.
 */
async function sendBalancePaymentEmail({
  to,
  name,
  templateName,
  balanceAmount,
  paymentLink,
  isPlaceholder = false,
}) {
  const placeholderNote = isPlaceholder
    ? `<p style="color:#666;font-size:14px;"><em>This link is a placeholder until live payments are enabled. Your host will send a real payment link when ready.</em></p>`
    : '';
  return sendMail({
    to,
    subject: `Action needed — Pay balance to upgrade your invitation template`,
    html: `
      <p>Hi ${name},</p>
      <p>Your administrator has selected <strong>${templateName}</strong> as your new invitation template.</p>
      <p>A balance of <strong>₹${(balanceAmount / 100).toLocaleString('en-IN')}</strong> is due before the new design goes live on your guest link.</p>
      ${placeholderNote}
      <p><a href="${paymentLink}" style="background:#6e1f2e;color:#fff;padding:12px 24px;border-radius:24px;text-decoration:none;display:inline-block;margin-top:8px;">Pay ₹${(balanceAmount / 100).toLocaleString('en-IN')} →</a></p>
      <p>After we receive payment, your invitation will switch to the new template automatically.</p>
      <p>— Team Aamantran</p>`,
  });
}

/**
 * Send a reply from admin to a support ticket.
 */
async function sendTicketReplyEmail({ to, name, subject, replyBody, ticketUrl }) {
  return sendMail({
    to,
    subject: `Re: ${subject}`,
    html: `
      <p>Hi ${name},</p>
      <p>The Aamantran support team has replied to your ticket: <strong>${subject}</strong></p>
      <blockquote style="border-left:3px solid #6e1f2e;padding-left:16px;color:#555;">
        ${replyBody.replace(/\n/g, '<br/>')}
      </blockquote>
      <p><a href="${ticketUrl}">View your ticket →</a></p>
      <p>— Team Aamantran</p>`,
  });
}

async function sendAccountRecoveryCodeEmail({ to, code }) {
  return sendMail({
    to,
    subject: 'Your Aamantran account recovery code',
    html: `
      <p>Hi,</p>
      <p>Use the code below to recover your Aamantran account:</p>
      <p style="font-size:22px;font-weight:700;letter-spacing:4px;margin:16px 0;">${code}</p>
      <p>This code will expire in 10 minutes.</p>
      <p>If you did not request this, you can safely ignore this email.</p>
      <p>— Team Aamantran</p>`,
  });
}

async function sendTestEmail(to) {
  return sendMail({
    to,
    subject: 'Aamantran SMTP test email',
    html: '<p>SMTP is configured correctly.</p>',
  });
}

async function sendPurchaseConfirmationEmail({ to, templateName, amount, orderId, onboardingUrl }) {
  return sendMail({
    to,
    subject: orderId ? `Order Confirmed — ${orderId}` : 'Your Aamantran purchase confirmation',
    html: purchaseConfirmationHtml({ templateName, amount, orderId, onboardingUrl }),
  });
}

async function sendOnboardingReminderEmail({ to, onboardingUrl }) {
  return sendMail({
    to,
    subject: 'Complete your Aamantran onboarding',
    html: onboardingReminderHtml({ onboardingUrl }),
  });
}

async function sendAbandonedCheckoutEmail({ to, templateName, checkoutUrl, unsubscribeUrl }) {
  return sendMail({
    to,
    subject: 'Your wedding invitation is one step away ✨',
    html: abandonedCheckoutHtml({ templateName, checkoutUrl, unsubscribeUrl }),
  });
}

async function sendGuestDataDeletionWarningEmail({ to, deleteDateStr, exportUrl, dashboardUrl }) {
  return sendMail({
    to,
    subject: 'Action needed: your guest data will be deleted soon',
    html: guestDataDeletionWarningHtml({ deleteDateStr, exportUrl, dashboardUrl }),
  });
}

async function sendDpdpNoticeEmail({ to, privacyUrl, dashboardUrl }) {
  return sendMail({
    to,
    subject: 'Your data & your rights — an update from Aamantran',
    html: dpdpNoticeHtml({ privacyUrl, dashboardUrl }),
  });
}

async function sendAccountDeletedEmail({ to, username }) {
  return sendMail({
    to,
    subject: 'Your Aamantran account has been deleted',
    html: accountDeletedHtml({ username }),
  });
}

async function sendOnboardingCompleteEmail({ to, username, dashboardUrl }) {
  return sendMail({
    to,
    subject: 'Welcome to Aamantran',
    html: onboardingCompleteHtml({ username, dashboardUrl }),
  });
}

async function sendInvitationPublishedEmail({ to, inviteUrl }) {
  return sendMail({
    to,
    subject: 'Your invitation is now live',
    html: invitationPublishedHtml({ inviteUrl }),
  });
}

async function sendRsvpMilestoneEmail({ to, count, dashboardUrl }) {
  return sendMail({
    to,
    subject: `You reached ${count} RSVPs`,
    html: rsvpMilestoneHtml({ count, dashboardUrl }),
  });
}

async function sendEventCountdownEmail({ to, days, dashboardUrl }) {
  return sendMail({
    to,
    subject: `${days} day${days === 1 ? '' : 's'} left for your event`,
    html: eventCountdownHtml({ days, dashboardUrl }),
  });
}

async function sendPostEventThankYouEmail({ to, dashboardUrl }) {
  return sendMail({
    to,
    subject: 'Thank you for celebrating with Aamantran',
    html: postEventThankYouHtml({ dashboardUrl }),
  });
}

/**
 * Sent when admin changes the template on a user's event.
 * Tells them what was kept, what was cleared, and to go republish.
 */
async function sendTemplateChangedEmail({ to, fromTemplateName, toTemplateName, dashboardUrl }) {
  return sendMail({
    to,
    subject: `Your invitation design has been updated — please review and republish`,
    html: templateChangedHtml({ fromTemplateName, toTemplateName, dashboardUrl }),
  });
}

async function sendPasswordChangedEmail({ to, username }) {
  return sendMail({
    to,
    subject: 'Your Aamantran password was changed',
    html: `
      <p>Hi${username ? ` ${username}` : ''},</p>
      <p>The password for your Aamantran account was just changed.</p>
      <p>If this was you, no action is needed. You have been signed out of all devices and can sign in with your new password.</p>
      <p>If you did <strong>not</strong> make this change, please contact us immediately at <a href="mailto:aamantran@plexzuu.com">aamantran@plexzuu.com</a>.</p>
      <p>— Team Aamantran</p>`,
  });
}

/**
 * Where team notifications go. CONTACT_FORM_TO already serves this purpose
 * for the contact form, so it is reused rather than adding a second address
 * to keep in sync; ADMIN_EMAIL is the fallback.
 */
function internalRecipient() {
  return process.env.INTERNAL_NOTIFY_TO
    || process.env.CONTACT_FORM_TO
    || process.env.ADMIN_EMAIL
    || null;
}

/**
 * Send a team notification, or quietly do nothing if no address is set.
 *
 * Never throws: these fire from the middle of a purchase, a ticket or a
 * review, and a mail outage must not fail the operation the customer is
 * actually performing.
 */
async function sendInternalMail({ subject, html }) {
  const to = internalRecipient();
  if (!to) {
    console.warn('[Email] No INTERNAL_NOTIFY_TO/CONTACT_FORM_TO/ADMIN_EMAIL set - skipping:', subject);
    return null;
  }
  try {
    return await sendMail({ to, subject, html });
  } catch (err) {
    console.error('[Email] Internal notification failed:', subject, '-', err.message);
    return null;
  }
}

/** Team alert: a template was purchased. */
async function sendAdminOrderPlacedEmail(data) {
  return sendInternalMail({
    subject: `[Order] ${data.orderId || data.paymentId} - ${data.templateName}`,
    html: adminOrderPlacedHtml(data),
  });
}

/** Team alert: a support ticket was opened. */
async function sendAdminTicketRaisedEmail(data) {
  return sendInternalMail({
    subject: `[Ticket ${data.ticketRef}] ${data.subject}`,
    html: adminTicketRaisedHtml(data),
  });
}

/** Team alert: a review was posted or edited. */
async function sendAdminReviewPostedEmail(data) {
  return sendInternalMail({
    subject: `[Review] ${data.rating}/5 on ${data.templateName}${data.isUpdate ? ' (updated)' : ''}`,
    html: adminReviewPostedHtml(data),
  });
}

/** Customer-facing acknowledgement that their ticket reached us. */
async function sendTicketReceivedEmail({ to, name, ticketRef, subject, message }) {
  return sendMail({
    to,
    subject: `We received your request - ${ticketRef}`,
    html: ticketReceivedHtml({ name, ticketRef, subject, message }),
  });
}

module.exports = {
  sendMail,
  sendInternalMail,
  sendAdminOrderPlacedEmail,
  sendAdminTicketRaisedEmail,
  sendAdminReviewPostedEmail,
  sendTicketReceivedEmail,
  sendBalancePaymentEmail,
  sendTicketReplyEmail,
  sendAccountRecoveryCodeEmail,
  sendPasswordChangedEmail,
  sendTestEmail,
  sendPurchaseConfirmationEmail,
  sendOnboardingReminderEmail,
  sendAbandonedCheckoutEmail,
  sendOnboardingCompleteEmail,
  sendInvitationPublishedEmail,
  sendRsvpMilestoneEmail,
  sendEventCountdownEmail,
  sendPostEventThankYouEmail,
  sendTemplateChangedEmail,
  sendGuestDataDeletionWarningEmail,
  sendAccountDeletedEmail,
  sendDpdpNoticeEmail,
};
