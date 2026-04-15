const cron = require('node-cron');
const prisma = require('../utils/prisma');
const {
  sendOnboardingReminderEmail,
  sendRsvpMilestoneEmail,
  sendEventCountdownEmail,
  sendPostEventThankYouEmail,
} = require('./email.service');
const siteUrls = require('../config/siteUrls');

function toMidnight(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function daysDiff(from, to) {
  return Math.round((toMidnight(to).getTime() - toMidnight(from).getTime()) / (24 * 60 * 60 * 1000));
}

async function runOnboardingReminderJob() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const payments = await prisma.payment.findMany({
    where: {
      status: 'paid',
      isOnboarded: false,
      reminderSentAt: null,
      createdAt: { lte: cutoff },
      customerEmail: { not: '' },
    },
    include: { template: { select: { slug: true, name: true } } },
    take: 200,
  });
  for (const p of payments) {
    const onboardingUrl = `${siteUrls.landingUrl()}/onboarding?paymentId=${encodeURIComponent(p.id)}&slug=${encodeURIComponent(p.template.slug)}&template=${encodeURIComponent(p.template.name)}`;
    await sendOnboardingReminderEmail({ to: p.customerEmail, onboardingUrl }).catch(err => console.error('[Email Error] sendOnboardingReminderEmail:', err.message));
    await prisma.payment.update({ where: { id: p.id }, data: { reminderSentAt: new Date() } });
  }
}

async function runRsvpMilestoneJob() {
  const milestones = [10, 25, 50, 100];
  const events = await prisma.event.findMany({
    where: {
      isPublished: true,
      owner: { email: { not: '' } },
      OR: [{ inviteScope: null }, { inviteScope: 'full' }],
    },
    include: { owner: { select: { email: true } } },
    take: 500,
  });
  for (const ev of events) {
    const count = await prisma.rsvp.count({ where: { eventId: ev.id, attending: true } });
    const reached = milestones.filter((m) => count >= m);
    const last = reached.length ? reached[reached.length - 1] : null;
    if (!last) continue;
    if ((ev.lastMilestoneNotified || 0) >= last) continue;
    const dashboardUrl = `${siteUrls.coupleDashboardUrl()}/dashboard`;
    await sendRsvpMilestoneEmail({ to: ev.owner.email, count: last, dashboardUrl }).catch(() => {});
    await prisma.event.update({ where: { id: ev.id }, data: { lastMilestoneNotified: last } });
  }
}

async function runDateBasedEmailJob() {
  const events = await prisma.event.findMany({
    where: {
      isPublished: true,
      owner: { email: { not: '' } },
      OR: [{ inviteScope: null }, { inviteScope: 'full' }],
    },
    include: {
      owner: { select: { email: true } },
      functions: { select: { date: true } },
    },
    take: 500,
  });
  const now = new Date();
  for (const ev of events) {
    if (!ev.functions.length) continue;
    const dates = ev.functions.map((f) => new Date(f.date)).filter((d) => !Number.isNaN(d.getTime()));
    if (!dates.length) continue;
    const earliest = dates.reduce((a, b) => (a < b ? a : b));
    const latest = dates.reduce((a, b) => (a > b ? a : b));
    const daysToEarliest = daysDiff(now, earliest);
    const daysAfterLatest = -daysDiff(now, latest);
    const dashboardUrl = `${siteUrls.coupleDashboardUrl()}/dashboard`;

    if ((daysToEarliest === 7 || daysToEarliest === 1) && ev.countdownEmailSent !== daysToEarliest) {
      await sendEventCountdownEmail({ to: ev.owner.email, days: daysToEarliest, dashboardUrl }).catch(() => {});
      await prisma.event.update({ where: { id: ev.id }, data: { countdownEmailSent: daysToEarliest } });
    }

    if (daysAfterLatest >= 1 && !ev.postEventEmailSent) {
      await sendPostEventThankYouEmail({ to: ev.owner.email, dashboardUrl }).catch(() => {});
      await prisma.event.update({ where: { id: ev.id }, data: { postEventEmailSent: true } });
    }
  }
}

cron.schedule('0 * * * *', () => { runOnboardingReminderJob().catch(() => {}); });
cron.schedule('*/30 * * * *', () => { runRsvpMilestoneJob().catch(() => {}); });
cron.schedule('0 9 * * *', () => { runDateBasedEmailJob().catch(() => {}); });

module.exports = {
  runOnboardingReminderJob,
  runRsvpMilestoneJob,
  runDateBasedEmailJob,
};
