/**
 * One-off backfill for paired invites whose Links & Guests settings drifted.
 *
 *   node scripts/backfill-invite-pair-settings.js            # dry run (default)
 *   node scripts/backfill-invite-pair-settings.js --apply    # write changes
 *
 * Background
 * ----------
 * A partial ("subset") invite is created as a copy of the full invite at publish
 * time. Until this was fixed, the copy happened exactly once: later edits made
 * through PUT /api/user/events/:id landed on the full invite only, and republishing
 * synced just isPublished/expiresAt. So any Links & Guests setting changed after
 * the pair was created was silently missing from the partial invite — most visibly
 * `rsvpEnabled`, which made the RSVP section disappear from the partial invite and
 * made POST /api/public/rsvp answer 403.
 *
 * userDashboard.controller.js now keeps pairs in sync on both update and publish.
 * This script repairs pairs that already drifted.
 *
 * What it does
 * ------------
 * For every invitePairId, the row with inviteScope='full' is the source of truth;
 * its PAIR_SHARED_FIELDS are copied onto the other invites in that pair. Per-invite
 * fields (slug, subdomain, expiresAt, functions) are never touched.
 *
 * Idempotent: only pairs that actually differ are written.
 */

const prisma = require('../src/utils/prisma');
const {
  PAIR_SHARED_FIELDS,
  readPairSharedFields,
} = require('../src/controllers/userDashboard.controller');

const APPLY = process.argv.includes('--apply');

function log(...args) { console.log('[pair-settings]', ...args); }

function diffShared(source, target) {
  const desired = readPairSharedFields(source);
  const changes = {};
  for (const key of PAIR_SHARED_FIELDS) {
    const want = desired[key];
    const have = key === 'rsvpEnabled' || key === 'guestNotesEnabled'
      ? target[key] !== false
      : (target[key] ?? null);
    const normalizedWant = key === 'language' ? (want || 'en') : want;
    const normalizedHave = key === 'language' ? (target.language || 'en') : have;
    if (normalizedWant !== normalizedHave) changes[key] = want;
  }
  return changes;
}

async function main() {
  log(APPLY ? 'APPLY mode — changes will be written' : 'DRY RUN — pass --apply to write');

  const paired = await prisma.event.findMany({
    where: { invitePairId: { not: null } },
    select: {
      id: true, slug: true, inviteScope: true, invitePairId: true,
      language: true, instagramUrl: true, instagramHashtag: true,
      socialYoutubeUrl: true, websiteUrl: true,
      rsvpEnabled: true, guestNotesEnabled: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const pairs = new Map();
  for (const ev of paired) {
    if (!pairs.has(ev.invitePairId)) pairs.set(ev.invitePairId, []);
    pairs.get(ev.invitePairId).push(ev);
  }
  log(`found ${paired.length} paired invites across ${pairs.size} pairs`);

  let repaired = 0, skipped = 0, orphaned = 0;

  for (const [pairId, members] of pairs) {
    const source = members.find((m) => m.inviteScope === 'full');
    if (!source) {
      orphaned++;
      log(`  SKIP pair ${pairId} — no inviteScope='full' member (${members.map(m => m.slug).join(', ')})`);
      continue;
    }

    for (const target of members) {
      if (target.id === source.id) continue;
      const changes = diffShared(source, target);
      if (!Object.keys(changes).length) { skipped++; continue; }

      const summary = Object.entries(changes)
        .map(([k, v]) => `${k}: ${JSON.stringify(target[k])} -> ${JSON.stringify(v)}`)
        .join(', ');
      log(`  ${APPLY ? 'FIX ' : 'WOULD FIX'} ${target.slug} (from ${source.slug}) — ${summary}`);

      if (APPLY) {
        await prisma.event.update({ where: { id: target.id }, data: changes });
      }
      repaired++;
    }
  }

  log(`done — ${repaired} invite(s) ${APPLY ? 'repaired' : 'need repair'}, ${skipped} already in sync, ${orphaned} pair(s) skipped`);
  if (!APPLY && repaired > 0) log('re-run with --apply to write these changes');
}

main()
  .catch((err) => { console.error('[pair-settings] failed:', err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
