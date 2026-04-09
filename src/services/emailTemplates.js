function wrapInLayout(bodyHtml) {
  return `
    <div style="font-family:Arial,sans-serif;background:#f8f5f2;padding:20px;">
      <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #eadfce;border-radius:12px;overflow:hidden;">
        <div style="background:#6e1f2e;color:#fff;padding:16px 20px;font-size:20px;font-weight:700;">Aamantran</div>
        <div style="padding:20px;color:#2e2e2e;line-height:1.6;">${bodyHtml}</div>
        <div style="background:#faf7f3;padding:12px 20px;color:#7a7a7a;font-size:12px;">
          Need help? support@aamantran.co
        </div>
      </div>
    </div>
  `;
}

function purchaseConfirmationHtml({ templateName, amount, onboardingUrl }) {
  return wrapInLayout(`
    <h2 style="margin:0 0 8px;">Payment received</h2>
    <p>Thank you for purchasing <strong>${templateName}</strong>.</p>
    <p>Amount paid: <strong>₹${(Number(amount || 0) / 100).toLocaleString('en-IN')}</strong></p>
    <p><a href="${onboardingUrl}" style="background:#6e1f2e;color:#fff;padding:10px 16px;border-radius:20px;text-decoration:none;">Complete onboarding</a></p>
  `);
}

function onboardingReminderHtml({ onboardingUrl }) {
  return wrapInLayout(`
    <h2 style="margin:0 0 8px;">Your invitation is waiting</h2>
    <p>Complete onboarding to start customizing and publishing your invitation.</p>
    <p><a href="${onboardingUrl}" style="background:#6e1f2e;color:#fff;padding:10px 16px;border-radius:20px;text-decoration:none;">Continue onboarding</a></p>
  `);
}

function onboardingCompleteHtml({ username, dashboardUrl }) {
  return wrapInLayout(`
    <h2 style="margin:0 0 8px;">Welcome to Aamantran</h2>
    <p>Your account is ready. Username: <strong>${username}</strong></p>
    <p><a href="${dashboardUrl}" style="background:#6e1f2e;color:#fff;padding:10px 16px;border-radius:20px;text-decoration:none;">Open dashboard</a></p>
  `);
}

function invitationPublishedHtml({ inviteUrl }) {
  return wrapInLayout(`
    <h2 style="margin:0 0 8px;">Your invitation is live</h2>
    <p>Share your invitation with guests:</p>
    <p><a href="${inviteUrl}">${inviteUrl}</a></p>
  `);
}

function rsvpMilestoneHtml({ count, dashboardUrl }) {
  return wrapInLayout(`
    <h2 style="margin:0 0 8px;">RSVP milestone reached</h2>
    <p>You have reached <strong>${count}</strong> RSVP responses.</p>
    <p><a href="${dashboardUrl}">View dashboard</a></p>
  `);
}

function eventCountdownHtml({ days, dashboardUrl }) {
  return wrapInLayout(`
    <h2 style="margin:0 0 8px;">${days} day${days === 1 ? '' : 's'} to go</h2>
    <p>Your event is coming up soon.</p>
    <p><a href="${dashboardUrl}">Review event details</a></p>
  `);
}

function postEventThankYouHtml({ dashboardUrl }) {
  return wrapInLayout(`
    <h2 style="margin:0 0 8px;">Congratulations</h2>
    <p>Hope your celebration was wonderful. Thank you for choosing Aamantran.</p>
    <p><a href="${dashboardUrl}">Visit dashboard</a></p>
  `);
}

module.exports = {
  purchaseConfirmationHtml,
  onboardingReminderHtml,
  onboardingCompleteHtml,
  invitationPublishedHtml,
  rsvpMilestoneHtml,
  eventCountdownHtml,
  postEventThankYouHtml,
};
