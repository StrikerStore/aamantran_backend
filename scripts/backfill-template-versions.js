/**
 * One-off backfill for template versioning.
 *
 *   node scripts/backfill-template-versions.js            # dry run
 *   node scripts/backfill-template-versions.js --apply    # write changes
 *
 * For every Template that has no currentVersionId:
 *  1. Re-extract the zip stored at templates/{slug}/template.zip into
 *     - templates/{slug}/v1/    (new immutable version)
 *     - templates/{slug}/draft/ (working copy for future edits)
 *     Re-extraction fixes asset-path prefixes so each folder is self-contained.
 *  2. Create a TemplateVersion row (versionNumber=1) and point Template.currentVersionId at it.
 *  3. Backfill every Event with templateId=X and null templateVersionId → v1.id.
 *  4. Delete the old flat template files at templates/{slug}/*.html|css|js|assets|fonts|images|…
 *     (keeps thumbnails/ and the top-level template.zip intact). On R2 the top-level
 *     zip is kept as a historical artefact; feel free to remove manually later.
 *
 * The script is idempotent — re-running only acts on templates that still have no
 * currentVersionId. If a template has no stored template.zip (created before the
 * backend started saving it) it is skipped and reported.
 */

const fs   = require('fs');
const fsp  = require('fs/promises');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

const prisma        = require('../src/utils/prisma');
const storage       = require('../src/config/storage');
const objectStorage = require('../src/services/objectStorage');
const { extractTemplateZip } = require('../src/services/fileManager');

const APPLY = process.argv.includes('--apply');
const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH || './storage');
const TEMPLATES_DIR = path.join(STORAGE_PATH, 'templates');

const KEEP_SUFFIX_AT_ROOT = /^thumbnails\//i; // never delete thumbnails/ during cleanup

function log(...args) { console.log('[backfill]', ...args); }

async function downloadTemplateZip(slug) {
  const tmpDir = path.join(os.tmpdir(), `aamantran-backfill-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpZip = path.join(tmpDir, 'template.zip');

  if (storage.useObjectStorage()) {
    // Legacy layout stored the zip at templates/{slug}/template.zip
    const key = `templates/${slug}/template.zip`;
    try {
      const buf = await objectStorage.getObjectBuffer(key);
      await fsp.writeFile(tmpZip, buf);
    } catch (err) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`R2 zip not found at ${key}: ${err.message}`);
    }
  } else {
    const src = path.join(TEMPLATES_DIR, slug, 'template.zip');
    if (!fs.existsSync(src)) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Local zip not found at ${src}`);
    }
    await fsp.copyFile(src, tmpZip);
  }

  return { tmpZip, tmpDir };
}

/**
 * Clean up the old flat layout after files have been safely re-extracted into
 * v1/ and draft/. Keeps thumbnails/ and the original template.zip.
 */
async function removeLegacyFlatFiles(slug) {
  if (storage.useObjectStorage()) {
    const prefix = `templates/${slug}/`;
    const keys = await objectStorage.listKeys(prefix);
    const toDelete = [];
    for (const k of keys) {
      const rel = k.slice(prefix.length);
      // Keep: thumbnails/**, template.zip, anything already under draft/ or v{n}/
      if (KEEP_SUFFIX_AT_ROOT.test(rel)) continue;
      if (rel === 'template.zip') continue;
      if (/^(draft|v\d+)\//.test(rel)) continue;
      toDelete.push(k);
    }
    if (!toDelete.length) return 0;
    // Delete one at a time via helper for simplicity (small counts expected per template).
    for (const k of toDelete) await objectStorage.deleteObjectKey(k);
    return toDelete.length;
  }

  const dir = path.join(TEMPLATES_DIR, slug);
  if (!fs.existsSync(dir)) return 0;
  const entries = await fsp.readdir(dir);
  let removed = 0;
  for (const entry of entries) {
    if (entry === 'thumbnails') continue;
    if (entry === 'template.zip') continue;
    if (entry === 'draft' || /^v\d+$/.test(entry)) continue;
    await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

async function processTemplate(tpl) {
  log(`→ ${tpl.slug} (id=${tpl.id})`);

  if (tpl.currentVersionId) {
    log('  already has currentVersionId, skipping');
    return { status: 'skipped_has_version' };
  }

  let zipHandle;
  try {
    zipHandle = await downloadTemplateZip(tpl.folderPath);
  } catch (err) {
    log(`  ⚠ cannot backfill: ${err.message}`);
    return { status: 'skipped_no_zip' };
  }

  if (!APPLY) {
    await fsp.rm(zipHandle.tmpDir, { recursive: true, force: true }).catch(() => {});
    log('  [dry-run] would snapshot to v1/ and copy to draft/');
    return { status: 'dry_run' };
  }

  // Re-extract the zip twice — once for v1/, once for draft/ — so each folder has
  // asset paths prefixed with its own key. extractTemplateZip consumes (unlinks)
  // the zip, so duplicate to a second temp file.
  const secondZip = path.join(zipHandle.tmpDir, 'template.2.zip');
  await fsp.copyFile(zipHandle.tmpZip, secondZip);

  const v1Entry    = await extractTemplateZip(zipHandle.tmpZip, `${tpl.folderPath}/v1`);
  const draftEntry = await extractTemplateZip(secondZip,        `${tpl.folderPath}/draft`);
  await fsp.rm(zipHandle.tmpDir, { recursive: true, force: true }).catch(() => {});

  const version = await prisma.templateVersion.create({
    data: {
      templateId:       tpl.id,
      versionNumber:    1,
      folderPath:       `${tpl.folderPath}/v1`,
      desktopEntryFile: v1Entry.desktopEntryFile,
      mobileEntryFile:  v1Entry.mobileEntryFile,
      fieldSchema:      tpl.fieldSchema ?? undefined,
    },
  });

  await prisma.template.update({
    where: { id: tpl.id },
    data: {
      currentVersionId: version.id,
      desktopEntryFile: draftEntry.desktopEntryFile,
      mobileEntryFile:  draftEntry.mobileEntryFile,
    },
  });

  const { count } = await prisma.event.updateMany({
    where: { templateId: tpl.id, templateVersionId: null },
    data:  { templateVersionId: version.id },
  });

  const removed = await removeLegacyFlatFiles(tpl.folderPath);

  log(`  ✓ v1 created (${version.id}), pinned ${count} event(s), removed ${removed} legacy file(s)`);
  return { status: 'done', eventsPinned: count, filesRemoved: removed };
}

async function main() {
  log(APPLY ? 'APPLY mode — writing changes' : 'DRY RUN (pass --apply to commit)');
  log(storage.useObjectStorage() ? 'storage: R2' : `storage: local disk (${STORAGE_PATH})`);

  const templates = await prisma.template.findMany({
    select: { id: true, slug: true, folderPath: true, currentVersionId: true, fieldSchema: true },
    orderBy: { createdAt: 'asc' },
  });
  log(`found ${templates.length} template(s)`);

  const summary = { done: 0, dry_run: 0, skipped_has_version: 0, skipped_no_zip: 0 };
  for (const tpl of templates) {
    try {
      const r = await processTemplate(tpl);
      summary[r.status] = (summary[r.status] || 0) + 1;
    } catch (err) {
      log(`  ✗ ${tpl.slug} failed:`, err);
    }
  }

  log('summary:', summary);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
