const LOGO_URL = 'https://www.aamantran.online/logo.png';
const BRAND   = '#6e1f2e';
const GOLD    = '#c9944a';
const SUPPORT = 'aamantran@plexzuu.com';

function wrapInLayout(bodyHtml, { accentEmoji = '💌', heroTitle = '', heroSubtitle = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5ede6;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:620px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(110,31,46,0.10);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#6e1f2e 0%,#9b3a4e 60%,#c9944a 100%);padding:36px 32px 28px;text-align:center;">
      <img src="${LOGO_URL}" alt="Aamantran" height="52" style="display:block;margin:0 auto 16px;filter:brightness(0) invert(1);opacity:0.95;" onerror="this.style.display='none'">
      <div style="font-size:13px;letter-spacing:4px;color:rgba(255,255,255,0.75);text-transform:uppercase;margin-bottom:10px;">Aamantran</div>
      ${heroTitle ? `<div style="font-size:26px;font-weight:700;color:#fff;margin-bottom:6px;">${accentEmoji} ${heroTitle}</div>` : ''}
      ${heroSubtitle ? `<div style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.5;">${heroSubtitle}</div>` : ''}
      <!-- Decorative divider -->
      <div style="margin-top:20px;opacity:0.5;font-size:18px;letter-spacing:8px;color:#f0d5a0;">✦ ✦ ✦</div>
    </div>

    <!-- Body -->
    <div style="padding:36px 36px 28px;color:#2d1b1b;line-height:1.7;font-size:15px;">
      ${bodyHtml}
    </div>

    <!-- Footer -->
    <div style="background:#fdf6ef;border-top:1px solid #f0e0cc;padding:20px 32px;text-align:center;">
      <div style="font-size:13px;color:#9a7a6a;margin-bottom:4px;">Need help? We're here for you.</div>
      <a href="mailto:${SUPPORT}" style="color:${BRAND};font-size:13px;font-weight:600;text-decoration:none;">${SUPPORT}</a>
      <div style="margin-top:14px;font-size:11px;color:#c5aa97;letter-spacing:2px;">— WITH LOVE, TEAM AAMANTRAN —</div>
    </div>

  </div>
</body>
</html>`;
}

/* ── Shared styles ─────────────────────────────────────── */

function btn(text, url) {
  return `<a href="${url}" style="display:inline-block;margin-top:20px;padding:14px 32px;background:linear-gradient(135deg,${BRAND},#9b3a4e);color:#fff;font-size:15px;font-weight:600;border-radius:30px;text-decoration:none;letter-spacing:0.5px;box-shadow:0 4px 14px rgba(110,31,46,0.3);">${text} →</a>`;
}

function infoRow(label, value) {
  return `<tr>
    <td style="padding:8px 12px;font-size:13px;color:#9a7a6a;white-space:nowrap;vertical-align:top;">${label}</td>
    <td style="padding:8px 12px;font-size:14px;color:#2d1b1b;font-weight:600;">${value}</td>
  </tr>`;
}

function infoCard(rows) {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;background:#fdf6ef;border:1px solid #f0e0cc;border-radius:10px;margin:20px 0;overflow:hidden;">
    ${rows}
  </table>`;
}

function divider() {
  return `<div style="text-align:center;margin:24px 0;color:#e0c8b0;font-size:16px;letter-spacing:6px;">❧ ✦ ❧</div>`;
}

/* ── Templates ─────────────────────────────────────────── */

function purchaseConfirmationHtml({ templateName, amount, orderId, onboardingUrl }) {
  const amountStr = `₹${(Number(amount || 0) / 100).toLocaleString('en-IN')}`;
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">Your celebration journey begins! 🎊</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">Thank you for choosing Aamantran to craft your beautiful invitation. Your payment has been received and we're ready to make your day unforgettable.</p>
    ${infoCard(`
      ${orderId ? infoRow('Order ID', `<span style="font-family:monospace;letter-spacing:1px;font-weight:700;color:${BRAND};">${orderId}</span>`) : ''}
      ${infoRow('Template', templateName)}
      ${infoRow('Amount Paid', amountStr)}
      ${infoRow('Status', '<span style="color:#2e7d4f;background:#e6f4ea;padding:2px 10px;border-radius:12px;font-size:12px;">✓ Confirmed</span>')}
    `)}
    ${divider()}
    <p style="margin:0;color:#5a3a3a;font-size:14px;">One last step — complete your onboarding to set up your account and start personalizing your invitation with your names, photos, and ceremony details.</p>
    <div style="text-align:center;">
      ${btn('Complete Onboarding', onboardingUrl)}
    </div>
    <p style="margin:24px 0 0;font-size:13px;color:#b09080;text-align:center;">The link above will take you to your personalized setup.</p>
  `, {
    accentEmoji: '🎉',
    heroTitle: 'Payment Confirmed',
    heroSubtitle: 'Your invitation experience is ready to begin',
  });
}

function onboardingReminderHtml({ onboardingUrl }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">Your invitation is waiting for you ✨</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">We noticed you haven't completed your onboarding yet. Your beautiful invitation template is reserved and ready — it just needs your personal touch to come alive.</p>
    ${divider()}
    <p style="margin:0 0 6px;font-size:14px;color:#5a3a3a;"><strong>Here's what you'll do in onboarding:</strong></p>
    <ul style="margin:10px 0 20px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:2;">
      <li>Set up your account username &amp; password</li>
      <li>Enter your couple names &amp; event details</li>
      <li>Go live and share with your guests</li>
    </ul>
    <div style="text-align:center;">
      ${btn('Continue My Onboarding', onboardingUrl)}
    </div>
  `, {
    accentEmoji: '💍',
    heroTitle: 'Your Invitation Awaits',
    heroSubtitle: 'A few quick steps and your invitation will be live',
  });
}

function onboardingCompleteHtml({ username, dashboardUrl }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">You're all set — let the celebrations begin! 🥂</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">Welcome to Aamantran! Your account is active and your invitation is ready to be personalized and shared with your loved ones.</p>
    ${infoCard(`
      ${infoRow('Username', `@${username}`)}
      ${infoRow('Dashboard', '<span style="color:#6e1f2e;">app.aamantran.online</span>')}
    `)}
    ${divider()}
    <p style="margin:0 0 8px;font-size:14px;color:#5a3a3a;"><strong>What you can do next:</strong></p>
    <ul style="margin:0 0 20px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:2;">
      <li>Customize your invitation with photos &amp; details</li>
      <li>Publish and share your unique invite link</li>
      <li>Track RSVPs in real-time from your dashboard</li>
    </ul>
    <div style="text-align:center;">
      ${btn('Open My Dashboard', dashboardUrl)}
    </div>
  `, {
    accentEmoji: '🎊',
    heroTitle: 'Welcome to Aamantran',
    heroSubtitle: 'Your account is ready — let\'s make your celebration magical',
  });
}

function invitationPublishedHtml({ inviteUrl }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">Your invitation is now live in the world! 🌟</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">Congratulations! Your beautiful digital invitation has been published. Share the link below with your family and friends and let the RSVPs roll in.</p>
    <div style="background:linear-gradient(135deg,#fdf0e8,#fdebd0);border:1px solid #f0d5a8;border-radius:10px;padding:18px 20px;margin:20px 0;text-align:center;">
      <div style="font-size:11px;letter-spacing:3px;color:#9a7a6a;margin-bottom:8px;text-transform:uppercase;">Your Invite Link</div>
      <a href="${inviteUrl}" style="color:${BRAND};font-size:14px;font-weight:600;word-break:break-all;text-decoration:none;">${inviteUrl}</a>
    </div>
    ${divider()}
    <p style="margin:0 0 8px;font-size:14px;color:#5a3a3a;"><strong>Share it everywhere:</strong></p>
    <ul style="margin:0 0 20px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:2;">
      <li>WhatsApp it to family &amp; friends</li>
      <li>Post it on Instagram &amp; Facebook</li>
      <li>Send it in group chats</li>
    </ul>
    <div style="text-align:center;">
      <a href="${inviteUrl}" style="display:inline-block;margin-top:4px;padding:14px 32px;background:linear-gradient(135deg,${GOLD},#e0aa5e);color:#fff;font-size:15px;font-weight:600;border-radius:30px;text-decoration:none;letter-spacing:0.5px;box-shadow:0 4px 14px rgba(201,148,74,0.4);">View Your Invitation ✨</a>
    </div>
  `, {
    accentEmoji: '🎉',
    heroTitle: 'Invitation Published!',
    heroSubtitle: 'Share it and let the celebrations begin',
  });
}

function rsvpMilestoneHtml({ count, dashboardUrl }) {
  const milestone = count >= 100 ? '🏆' : count >= 50 ? '🌟' : count >= 25 ? '🎯' : '🎊';
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">Your guest list is growing! ${milestone}</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">Wonderful news — <strong>${count} guests</strong> have responded to your invitation. Your celebration is truly coming together!</p>
    <div style="text-align:center;margin:28px 0;">
      <div style="display:inline-block;background:linear-gradient(135deg,${BRAND},#9b3a4e);border-radius:50%;width:100px;height:100px;line-height:100px;text-align:center;">
        <span style="font-size:32px;font-weight:800;color:#fff;">${count}</span>
      </div>
      <div style="margin-top:10px;font-size:14px;color:#9a7a6a;letter-spacing:2px;text-transform:uppercase;">RSVPs Received</div>
    </div>
    ${divider()}
    <p style="margin:0 0 20px;color:#5a3a3a;font-size:14px;">Head to your dashboard to see who's attending, manage your guest list, and track responses in real time.</p>
    <div style="text-align:center;">
      ${btn('View Guest List', dashboardUrl)}
    </div>
  `, {
    accentEmoji: milestone,
    heroTitle: `${count} RSVPs and Counting!`,
    heroSubtitle: 'Your guests are excited to celebrate with you',
  });
}

function eventCountdownHtml({ days, dashboardUrl }) {
  const urgency = days === 1 ? 'Tomorrow is the big day!' : `Only ${days} days to go!`;
  const emoji   = days === 1 ? '🥁' : '⏳';
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">${urgency} ${emoji}</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">The wait is almost over! Your celebration is just around the corner. Make sure everything is in order for your special day.</p>
    <div style="text-align:center;margin:28px 0;">
      <div style="display:inline-block;background:linear-gradient(135deg,${GOLD},#e0aa5e);border-radius:16px;padding:18px 40px;">
        <div style="font-size:56px;font-weight:800;color:#fff;line-height:1;">${days}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.9);letter-spacing:3px;text-transform:uppercase;margin-top:4px;">Day${days === 1 ? '' : 's'} Left</div>
      </div>
    </div>
    ${divider()}
    <p style="margin:0 0 8px;font-size:14px;color:#5a3a3a;"><strong>Quick checklist:</strong></p>
    <ul style="margin:0 0 20px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:2;">
      <li>Check your final RSVP count</li>
      <li>Confirm venue and catering numbers</li>
      <li>Share any last-minute updates with guests</li>
    </ul>
    <div style="text-align:center;">
      ${btn('Review Event Details', dashboardUrl)}
    </div>
  `, {
    accentEmoji: emoji,
    heroTitle: `${days} Day${days === 1 ? '' : 's'} to Your Celebration`,
    heroSubtitle: 'The countdown has begun — everything is almost ready',
  });
}

/**
 * Email sent when admin changes an event's template.
 * - fromTemplateName: old template name
 * - toTemplateName:   new template name
 * - dashboardUrl:     direct link to user's dashboard
 * - keptItems:        array of strings — what was preserved
 * - clearedItems:     array of strings — what was cleared
 */
function templateChangedHtml({ fromTemplateName, toTemplateName, dashboardUrl }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">Your invitation design has been updated! 🎨</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">Our team has switched your invitation to a beautiful new design. Your existing details have been carried over wherever possible — a few fields may need your attention before you go live again.</p>

    ${infoCard(`
      ${infoRow('Previous Design', fromTemplateName)}
      ${infoRow('New Design', `<span style="color:#2e7d4f;font-weight:700;">${toTemplateName}</span>`)}
      ${infoRow('Status', '<span style="color:#b45309;background:#fef3c7;padding:2px 10px;border-radius:12px;font-size:12px;">⏸ Unpublished</span>')}
    `)}

    ${divider()}

    <p style="margin:0 0 8px;font-size:14px;color:#5a3a3a;"><strong>✅ What we kept for you:</strong></p>
    <ul style="margin:0 0 20px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:2;">
      <li>Names (Bride, Groom &amp; family members)</li>
      <li>Event functions &amp; ceremony details</li>
      <li>Venues &amp; map links</li>
      <li>Language preference</li>
      <li>Social links, RSVP &amp; Guest wishes settings</li>
    </ul>

    <p style="margin:0 0 8px;font-size:14px;color:#5a3a3a;"><strong>🗑️ What was cleared (new theme needs fresh content):</strong></p>
    <ul style="margin:0 0 20px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:2;">
      <li>Custom text fields (love story, hashtag, special notes, etc.)</li>
      <li>Photos &amp; couple images</li>
      <li>Background music</li>
    </ul>

    ${divider()}

    <p style="margin:0 0 6px;font-size:14px;color:#5a3a3a;"><strong>Next steps to go live again:</strong></p>
    <ol style="margin:0 0 24px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:2;">
      <li>Open your dashboard and review the new theme's fields</li>
      <li>Upload photos &amp; music that match the new design</li>
      <li>Fill in any custom details the new theme requires</li>
      <li>Hit <strong>Publish</strong> when you're happy!</li>
    </ol>

    <div style="text-align:center;">
      ${btn('Go to My Dashboard', dashboardUrl)}
    </div>

    <p style="margin:24px 0 0;font-size:13px;color:#b09080;text-align:center;">Need help? Reach out to us and we'll guide you through the new design.</p>
  `, {
    accentEmoji: '🎨',
    heroTitle: 'New Design, Fresh Start!',
    heroSubtitle: 'Your invitation has a stunning new look — let\'s fill it in',
  });
}

function postEventThankYouHtml({ dashboardUrl }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">What a beautiful day it must have been! 🌸</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">Your celebration has come and gone, and we hope every moment was filled with joy, love, and laughter. Thank you for letting Aamantran be a part of your special journey.</p>
    ${divider()}
    <div style="background:linear-gradient(135deg,#fdf0e8,#fdebd0);border-radius:10px;padding:20px 24px;margin:0 0 20px;text-align:center;">
      <div style="font-size:28px;margin-bottom:10px;">🙏</div>
      <p style="margin:0;font-size:15px;color:#5a3a3a;font-style:italic;line-height:1.7;">"May your new journey together be filled with happiness, love, and endless beautiful memories."</p>
      <div style="margin-top:10px;font-size:13px;color:#9a7a6a;">— Team Aamantran</div>
    </div>
    <p style="margin:0 0 20px;color:#5a3a3a;font-size:14px;">Your dashboard and invitation will remain accessible. Feel free to share your memories or revisit the beautiful invitation you created.</p>
    <div style="text-align:center;">
      ${btn('Visit Dashboard', dashboardUrl)}
    </div>
  `, {
    accentEmoji: '🌸',
    heroTitle: 'Congratulations!',
    heroSubtitle: 'Thank you for celebrating with Aamantran',
  });
}

function abandonedCheckoutHtml({ templateName, checkoutUrl, unsubscribeUrl }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">Your invitation is still waiting 💌</p>
    <p style="margin:0 0 20px;color:#5a3a3a;">You were just one step away from getting <strong>${templateName}</strong> — your payment didn't go through, but nothing is lost. Pick up right where you left off.</p>
    ${divider()}
    <p style="margin:0 0 6px;font-size:14px;color:#5a3a3a;"><strong>Why couples choose Aamantran:</strong></p>
    <ul style="margin:10px 0 20px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:2;">
      <li>Live within 30 minutes — share on WhatsApp tonight</li>
      <li>RSVP tracking for every function, one elegant link</li>
      <li>One-time payment, edit anytime, no hidden fees</li>
    </ul>
    <div style="text-align:center;">
      ${btn('Complete My Purchase', checkoutUrl)}
    </div>
    <p style="margin:20px 0 0;font-size:12px;color:#8a7a6f;text-align:center;">Questions? Just reply to this email or WhatsApp us at +91 91747 73644.</p>
    ${unsubscribeUrl ? `<p style="margin:12px 0 0;font-size:11px;color:#b0a094;text-align:center;">Don't want these reminders? <a href="${unsubscribeUrl}" style="color:#b0a094;text-decoration:underline;">Unsubscribe</a></p>` : ''}
  `, {
    accentEmoji: '✨',
    heroTitle: 'Finish Your Invitation',
    heroSubtitle: 'Your chosen template is reserved and ready',
  });
}

function guestDataDeletionWarningHtml({ deleteDateStr, exportUrl, dashboardUrl }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">Your guest data is scheduled for deletion 🗓️</p>
    <p style="margin:0 0 16px;color:#5a3a3a;">As promised in our Privacy Policy, guest information is automatically deleted <strong>90 days after your invitation expires</strong>. Your event's guest data will be permanently deleted on or after:</p>
    ${infoCard(`
      ${infoRow('Deletion date', `<span style="color:${BRAND};font-weight:700;">${deleteDateStr}</span>`)}
      ${infoRow('What gets deleted', 'Guest list, RSVP responses, guest wishes, per-guest activity')}
      ${infoRow('What stays', 'Your account, invitation design, photos and payment history')}
    `)}
    <p style="margin:0 0 6px;color:#5a3a3a;font-size:14px;">Want to keep a copy? Download your guest list and RSVP report from your dashboard before the deletion date.</p>
    <div style="text-align:center;">
      ${btn('Download Guest Data', exportUrl || dashboardUrl)}
    </div>
    ${divider()}
    <p style="margin:0;font-size:12px;color:#8a7a6f;text-align:center;">This is a one-time privacy notice required under India's Digital Personal Data Protection rules. Questions? Just reply to this email.</p>
  `, {
    accentEmoji: '🔐',
    heroTitle: 'Guest Data Deletion Notice',
    heroSubtitle: 'Export your guest list before it is erased',
  });
}

/**
 * One-time DPDP notice to existing customers (Act s.5(2)): describes the
 * personal data we hold and why, their rights, and the upcoming guest-data
 * retention sweep. Sent via scripts/send-dpdp-notice.js.
 */
function dpdpNoticeHtml({ privacyUrl, dashboardUrl }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">An important update about your data 🛡️</p>
    <p style="margin:0 0 16px;color:#5a3a3a;">India's <strong>Digital Personal Data Protection Act (DPDP)</strong> gives you new rights over your personal data, and asks companies like us to clearly tell you what we hold and why. Here it is, in plain language.</p>

    <p style="margin:0 0 6px;font-size:14px;color:#5a3a3a;"><strong>What we hold about you:</strong></p>
    <ul style="margin:6px 0 16px;padding-left:20px;color:#5a3a3a;font-size:14px;line-height:1.9;">
      <li><strong>Account details</strong> — username, email, phone number (to run your account)</li>
      <li><strong>Invitation content</strong> — names, photos, event and venue details (to build and host your invitation)</li>
      <li><strong>Guest data</strong> — guest lists, RSVPs and wishes you collected (shown only to you)</li>
      <li><strong>Order records</strong> — what you purchased and when (required by tax law; we never store card or UPI details)</li>
    </ul>
    <p style="margin:0 0 16px;color:#5a3a3a;font-size:14px;">We never sell your data, and we don't send marketing emails without your consent.</p>

    ${divider()}

    <p style="margin:0 0 6px;font-size:14px;color:#5a3a3a;"><strong>Your rights:</strong> you can access, correct or delete your data, withdraw consent, nominate someone to act for you, or raise a grievance — just email <a href="mailto:${SUPPORT}" style="color:${BRAND};">${SUPPORT}</a> from your registered email. Most details can also be edited directly in your dashboard, which now includes a self-serve <strong>Delete Account</strong> option under Settings.</p>

    <p style="margin:16px 0 6px;font-size:14px;color:#5a3a3a;"><strong>One change to note:</strong> as promised in our Privacy Policy, guest data (guest lists, RSVPs, wishes) is automatically deleted <strong>90 days after your invitation expires</strong>. If your event has already passed, you'll receive a separate email at least 48 hours before any deletion, with a link to download your guest list first.</p>

    <div style="text-align:center;">
      ${btn('Read the Updated Privacy Policy', privacyUrl)}
    </div>
    <p style="margin:20px 0 0;font-size:12px;color:#8a7a6f;text-align:center;">No action is needed — your account and invitations are unaffected. You can export your guest data anytime from <a href="${dashboardUrl}" style="color:#8a7a6f;">your dashboard</a>.</p>
  `, {
    accentEmoji: '🛡️',
    heroTitle: 'Your Data, Your Rights',
    heroSubtitle: 'What we hold, why we hold it, and how you stay in control',
  });
}

function accountDeletedHtml({ username }) {
  return wrapInLayout(`
    <p style="margin:0 0 6px;font-size:17px;font-weight:600;color:${BRAND};">Your account has been deleted</p>
    <p style="margin:0 0 16px;color:#5a3a3a;">Hi${username ? ` ${username}` : ''}, as requested, your Aamantran account and the personal data associated with it — your events, guest lists, RSVPs, photos and profile — have been permanently deleted.</p>
    <p style="margin:0 0 16px;color:#5a3a3a;font-size:14px;">Payment records are retained in de-identified form only where Indian tax law requires it. If you did <strong>not</strong> request this deletion, contact us immediately by replying to this email.</p>
    <p style="margin:0;color:#5a3a3a;font-size:14px;">Thank you for celebrating with us. You are always welcome back. 🌸</p>
  `, {
    accentEmoji: '👋',
    heroTitle: 'Account Deleted',
    heroSubtitle: 'Your personal data has been erased',
  });
}

module.exports = {
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
};
