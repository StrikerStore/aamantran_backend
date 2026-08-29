/**
 * Find template folders in storage that no Template row points at, and
 * optionally delete them.
 *
 *   npm run storage:orphans                          # dry run — lists what would go
 *   npm run storage:orphans -- --apply --confirm=<bucket>
 *   npm run storage:orphans -- --lab-only
 *
 * DANGER — read before using --apply. "Orphaned" means "no row in the database
 * this process is connected to". If DATABASE_URL and the storage bucket belong
 * to different environments (a local .env pointing at the production bucket is
 * the easy mistake), every live template looks orphaned and --apply deletes
 * customer files. Hence --confirm=<bucket>: you have to read the bucket name
 * off the banner and type it back.
 *
 * Orphans accumulate whenever rows are removed without their files: a cascade
 * delete (removing a Template Lab developer takes their templates with it), a
 * row deleted straight in the database, or a storage failure part-way through
 * a delete. Nothing else sweeps them up.
 *
 * Dry run is the default on purpose — this deletes bytes that cannot be
 * recovered, so seeing the list first is worth the extra command.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const prisma = require('../src/utils/prisma');
const storage = require('../src/config/storage');
const objectStorage = require('../src/services/objectStorage');
const { deleteTemplateFolder } = require('../src/services/fileManager');

const APPLY    = process.argv.includes('--apply');
const LAB_ONLY = process.argv.includes('--lab-only');
const FORCE    = process.argv.includes('--force');
const CONFIRM  = (process.argv.find((a) => a.startsWith('--confirm=')) || '').split('=')[1] || '';

/** Anything above this share of folders being orphaned means the DB is wrong, not the bucket. */
const SANITY_RATIO = 0.5;

/** Host only — never print credentials. */
function databaseHost() {
  try {
    return new URL(process.env.DATABASE_URL).host;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

// Mirrors services/fileManager.js — same env var, same default.
const TEMPLATES_DIR = path.join(path.resolve(process.env.STORAGE_PATH || './storage'), 'templates');

/**
 * Top-level folder names under templates/ in whichever backend is configured.
 *
 * A template owns `templates/<slug>/draft/` and `templates/<slug>/v<n>/`, so
 * the unit of ownership is the first path segment — never the nested ones.
 */
async function listStorageFolders() {
  if (storage.useObjectStorage()) {
    const keys = await objectStorage.listKeys('templates/');
    const folders = new Set();
    for (const key of keys) {
      const rest = key.slice('templates/'.length);
      const first = rest.split('/')[0];
      if (first) folders.add(first);
    }
    return [...folders];
  }

  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  const entries = await fsp.readdir(TEMPLATES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

(async () => {
  const bucket  = storage.useObjectStorage() ? storage.r2BucketName() : TEMPLATES_DIR;
  const backend = storage.useObjectStorage() ? `R2 (${bucket})` : `disk (${bucket})`;

  console.log('-'.repeat(64));
  console.log(`[orphans] database: ${databaseHost()}`);
  console.log(`[orphans] storage:  ${backend}`);
  console.log('[orphans] These MUST be the same environment. If they are not,');
  console.log('[orphans] every live template will look orphaned.');
  console.log('-'.repeat(64));

  const templates = await prisma.template.findMany({
    select: { slug: true, folderPath: true, sandboxOwnerId: true },
  });

  // Both are referenced in the codebase and are usually equal, but a template
  // whose folderPath drifted from its slug must keep BOTH folders.
  const claimed = new Set();
  for (const t of templates) {
    if (t.slug) claimed.add(t.slug);
    if (t.folderPath) claimed.add(t.folderPath);
  }

  const folders = await listStorageFolders();
  let orphans = folders.filter((f) => !claimed.has(f));
  if (LAB_ONLY) orphans = orphans.filter((f) => f.startsWith('lab-'));

  console.log(`[orphans] template rows: ${templates.length} (${templates.filter(t => t.sandboxOwnerId).length} sandbox)`);
  console.log(`[orphans] folders in storage: ${folders.length}`);
  console.log(`[orphans] orphaned: ${orphans.length}${LAB_ONLY ? ' (lab- only)' : ''}`);

  if (!orphans.length) {
    console.log('[orphans] nothing to clean up.');
    process.exit(0);
  }

  for (const f of orphans) console.log(`  - ${f}`);

  if (!APPLY) {
    console.log('\n[orphans] DRY RUN — nothing deleted.');
    console.log(`[orphans] To delete: --apply --confirm=${bucket}`);
    process.exit(0);
  }

  if (CONFIRM !== bucket) {
    console.error(`\n[orphans] REFUSING: --apply needs --confirm=${bucket}`);
    console.error('[orphans] Check the banner above and confirm the database and bucket match.');
    process.exit(1);
  }

  const ratio = folders.length ? orphans.length / folders.length : 0;
  if (ratio > SANITY_RATIO && !FORCE) {
    console.error(`\n[orphans] REFUSING: ${orphans.length} of ${folders.length} folders look orphaned (${Math.round(ratio * 100)}%).`);
    console.error('[orphans] That usually means this database does not match this bucket,');
    console.error('[orphans] not that the bucket is full of junk. Verify the banner above.');
    console.error('[orphans] Pass --force only if you are certain the list is correct.');
    process.exit(1);
  }

  let removed = 0;
  for (const folder of orphans) {
    try {
      await deleteTemplateFolder(folder);
      removed += 1;
      console.log(`  deleted ${folder}`);
    } catch (err) {
      console.error(`  FAILED ${folder}: ${err.message}`);
    }
  }
  console.log(`\n[orphans] removed ${removed}/${orphans.length} folders.`);
  process.exit(0);
})().catch((err) => {
  console.error('[orphans] failed:', err.message);
  process.exit(1);
});
