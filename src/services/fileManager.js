const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const unzipper = require('unzipper');
const storage = require('../config/storage');
const objectStorage = require('./objectStorage');

// ── R2 URL rewriter ───────────────────────────────────────────────────────────

/**
 * Cache-bust version appended to r2-proxy asset URLs.
 * Bump this when stale/corrupted assets are cached on the CDN with immutable headers.
 */
const R2_PROXY_CACHE_VERSION = 3;

/**
 * Replace direct R2 public CDN URLs in template HTML with same-origin
 * API-side proxy paths.  This is necessary because:
 *  1. CSS `<link crossorigin>` tags need CORS headers that R2's Cloudflare
 *     CDN does not reliably return.
 *  2. Root-relative image paths in the JS bundle (e.g. `/images/foo.jpg`)
 *     must resolve against the proxy origin so `/r2-proxy/` middleware can
 *     intercept them.
 *
 * Appends ?v=N to JS/CSS URLs to force browser cache invalidation after
 * a corrupted-asset fix.
 */
function rewriteR2AssetsToProxy(html) {
  if (!storage.useObjectStorage()) return html;
  const r2Base   = storage.objectStoragePublicBase(); // e.g. https://media.aamantran.online
  const siteUrls = require('../config/siteUrls');
  const apiBase  = siteUrls.apiBaseUrl();             // e.g. https://api.aamantran.online
  const proxyBase = `${apiBase}/r2-proxy`;

  // 1. Replace all CDN base URLs with proxy base URLs
  let result = html.split(r2Base).join(proxyBase);

  // 2. Append cache-bust version to JS/CSS asset URLs in src/href attributes
  result = result.replace(
    /((?:src|href)\s*=\s*["'])([^"']*\/r2-proxy\/[^"']+\.(js|css|woff2?|ttf))(["'])/gi,
    (_m, pre, url, _ext, post) => `${pre}${url}?v=${R2_PROXY_CACHE_VERSION}${post}`
  );
  return result;
}

const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH || './storage');
const TEMPLATES_DIR = path.join(STORAGE_PATH, 'templates');

if (!storage.useObjectStorage()) {
  if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

async function uploadDirectoryToR2(localDir, keyPrefix) {
  const prefix = keyPrefix.replace(/\/$/, '');
  async function walk(rel = '') {
    const abs = path.join(localDir, rel);
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const ent of entries) {
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      const nextAbs = path.join(localDir, nextRel);
      if (ent.isDirectory()) {
        // Never upload a thumbnails/ folder from a ZIP — thumbnails are managed separately
        if (ent.name === 'thumbnails' && !rel) continue;
        await walk(nextRel);
        continue;
      }
      const posixRel = nextRel.split(path.sep).join('/');
      const key = `${prefix}/${posixRel}`;
      const buf = await fsp.readFile(nextAbs);
      const ct = storage.contentTypeForPath(nextAbs);
      await objectStorage.putObject(key, buf, ct);
    }
  }
  await walk('');
}

/**
 * Save a thumbnail into template storage.
 * Returns path `/s/...` (local) or full https URL (R2).
 */
async function saveThumbnail(filePath, folderName, originalName, variant = 'desktop') {
  const { v4: uuidv4 } = require('uuid');
  const ext = path.extname(originalName).toLowerCase() || '.jpg';
  const safeVariant = variant === 'mobile' ? 'mobile' : 'desktop';
  const uniqueId = uuidv4().replace(/-/g, '').slice(0, 10);
  const fileName = `${safeVariant}-thumbnail-${uniqueId}${ext}`;
  const relKey = `templates/${folderName}/thumbnails/${fileName}`;

  if (storage.useObjectStorage()) {
    const buf = await fsp.readFile(filePath);
    const ct = storage.contentTypeForPath(fileName);
    await objectStorage.putObject(relKey, buf, ct);
    await fsp.unlink(filePath).catch(() => {});
    return `${storage.objectStoragePublicBase()}/${relKey}`;
  }

  const dest = path.join(TEMPLATES_DIR, folderName, 'thumbnails');
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const thumbPath = path.join(dest, fileName);
  await fsp.copyFile(filePath, thumbPath);
  await fsp.unlink(filePath).catch(() => {});

  return `/s/${folderName}/thumbnails/${fileName}`;
}

/**
 * Extract ZIP: local → storage/templates/{folder}; R2 → temp dir → upload all + template.zip.
 */
async function extractTemplateZip(zipFilePath, folderName) {
  if (storage.useObjectStorage()) {
    // Delete all objects in this template's folder EXCEPT thumbnails/
    await objectStorage.deleteByPrefixExcluding(
      `templates/${folderName}/`,
      [`templates/${folderName}/thumbnails/`]
    );

    const tmpRoot = path.join(os.tmpdir(), `aamantran-tpl-${crypto.randomUUID()}`);
    const dest = path.join(tmpRoot, 'extracted');
    fs.mkdirSync(dest, { recursive: true });

    await fs.createReadStream(zipFilePath).pipe(unzipper.Extract({ path: dest })).promise();
    await flattenIfNeeded(dest);

    const assetPrefix = storage.templateAssetPrefix(folderName);
    await rewriteAssetPaths(dest, assetPrefix);

    const entryFiles = await detectTemplateEntryFiles(dest);

    await uploadDirectoryToR2(dest, `templates/${folderName}`);

    const zipBuf = await fsp.readFile(zipFilePath);
    await objectStorage.putObject(
      `templates/${folderName}/template.zip`,
      zipBuf,
      'application/zip'
    );

    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.unlink(zipFilePath).catch(() => {});

    return entryFiles;
  }

  const dest = path.join(TEMPLATES_DIR, folderName);
  if (fs.existsSync(dest)) {
    // Delete everything except the thumbnails subfolder
    const entries = await fsp.readdir(dest);
    for (const entry of entries) {
      if (entry === 'thumbnails') continue;
      await fsp.rm(path.join(dest, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dest, { recursive: true });

  await fs.createReadStream(zipFilePath).pipe(unzipper.Extract({ path: dest })).promise();
  await flattenIfNeeded(dest);
  await rewriteAssetPaths(dest, storage.templateAssetPrefix(folderName));

  const zipDest = path.join(dest, 'template.zip');
  await fsp.copyFile(zipFilePath, zipDest).catch(() => {});

  const entryFiles = await detectTemplateEntryFiles(dest);
  await fsp.unlink(zipFilePath).catch(() => {});

  return entryFiles;
}

async function flattenIfNeeded(dir) {
  const entries = await fsp.readdir(dir);
  if (entries.length !== 1) return;

  const single = path.join(dir, entries[0]);
  const stat = await fsp.stat(single);
  if (!stat.isDirectory()) return;

  const subEntries = await fsp.readdir(single);
  for (const entry of subEntries) {
    const from = path.join(single, entry);
    const to = path.join(dir, entry);
    await moveWithWindowsSafeFallback(from, to);
  }
  await fsp.rm(single, { recursive: true, force: true });
}

async function moveWithWindowsSafeFallback(from, to) {
  try {
    await fsp.rename(from, to);
    return;
  } catch (err) {
    if (!['EPERM', 'EEXIST', 'ENOTEMPTY', 'EXDEV'].includes(err?.code)) {
      throw err;
    }
  }

  const srcStat = await fsp.stat(from);
  if (srcStat.isDirectory()) {
    await fsp.mkdir(to, { recursive: true });
    const nested = await fsp.readdir(from);
    for (const name of nested) {
      await moveWithWindowsSafeFallback(path.join(from, name), path.join(to, name));
    }
    await fsp.rm(from, { recursive: true, force: true });
    return;
  }

  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  await fsp.rm(from, { force: true });
}

/**
 * Rewrite relative asset refs in HTML/CSS/JS to use assetPrefix (e.g. /s/slug/ or https://.../templates/slug/).
 */
async function rewriteAssetPaths(dir, assetPrefix) {
  const prefix = String(assetPrefix).replace(/\/?$/, '/');
  await walkAndRewrite(dir, dir, prefix);
}

async function walkAndRewrite(baseDir, currentDir, prefix) {
  const entries = await fsp.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await walkAndRewrite(baseDir, fullPath, prefix);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!['.html', '.css', '.js'].includes(ext)) continue;

    let content = await fsp.readFile(fullPath, 'utf8');

    if (ext === '.js') {
      // ── JS: rewrite ES module import/export paths ──
      // Anchors on the `from` keyword or `import(` syntax so it can never
      // match arbitrary minified code like getElementById("root") or e.jsx().
      content = content.replace(
        /(from\s*["'])(\.\.\/|\.\/)([^"'\s]+)(["'])/gi,
        (_m, pre, _rel, rest, post) => `${pre}${prefix}${rest}${post}`
      );
      content = content.replace(
        /(import\s*\(\s*["'])(\.\.\/|\.\/)([^"'\s]+)(["']\s*\))/gi,
        (_m, pre, _rel, rest, post) => `${pre}${prefix}${rest}${post}`
      );

      // ── JS: rewrite root-relative asset paths (/images/foo.jpg, etc.) ──
      // Vite compiles hardcoded image imports as root-relative strings.
      // When the page is served from api.aamantran.online, these resolve to
      // the wrong origin. Rewrite to absolute CDN URLs.
      // prefix is e.g. "https://media.aamantran.online/templates/slug/"
      // so "/images/foo.jpg" becomes "https://media.aamantran.online/templates/slug/images/foo.jpg"
      content = content.replace(
        /(["'])\/(images|fonts|assets)\//g,
        (_m, quote, dir) => `${quote}${prefix}${dir}/`
      );
    } else {
      // ── HTML / CSS: rewrite asset references starting with ./ or ../ ──
      content = content.replace(
        /(['"`])(\.\.\/|\.\/)([^'"`\s>]+\.(jpg|jpeg|png|gif|avif|webp|svg|mp4|webm|mp3|ogg|css|js|woff2?|ttf))/gi,
        (_m, quote, _rel, rest) => `${quote}${prefix}${rest}`
      );
      // CSS url() with unquoted paths: url(../images/foo.jpg)
      if (ext === '.css') {
        content = content.replace(
          /url\((\.\.\/|\.\/)([^)]+\.(jpg|jpeg|png|gif|avif|webp|svg|woff2?|ttf))\)/gi,
          (_m, _rel, rest) => `url(${prefix}${rest})`
        );
      }
    }

    await fsp.writeFile(fullPath, content, 'utf8');
  }
}

function buildEntryCandidates(options = {}) {
  const { preferredFile, variant, desktopEntryFile, mobileEntryFile } = options;
  const ordered = [];
  if (preferredFile) ordered.push(preferredFile);
  if (variant === 'mobile') {
    if (mobileEntryFile) ordered.push(mobileEntryFile);
    if (desktopEntryFile) ordered.push(desktopEntryFile);
  } else {
    if (desktopEntryFile) ordered.push(desktopEntryFile);
    if (mobileEntryFile) ordered.push(mobileEntryFile);
  }
  ordered.push('index.html');
  return [...new Set(ordered.filter(Boolean))];
}

async function readTemplateHtml(folderName, options = {}) {
  const uniqueCandidates = buildEntryCandidates({
    preferredFile: options.preferredFile,
    variant: options.variant,
    desktopEntryFile: options.desktopEntryFile,
    mobileEntryFile: options.mobileEntryFile,
  });

  if (storage.useObjectStorage()) {
    for (const fileName of uniqueCandidates) {
      const key = `templates/${folderName}/${fileName}`;
      try {
        const buf = await objectStorage.getObjectBuffer(key);
        // Rewrite direct R2 URLs → /r2-proxy/* so assets load same-origin
        return rewriteR2AssetsToProxy(buf.toString('utf8'));
      } catch (err) {
        const code = err?.name || err?.Code || err?.code;
        const status = err?.$metadata?.httpStatusCode;
        if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) continue;
        throw err;
      }
    }
    throw Object.assign(
      new Error(`Template entry file not found for ${folderName} (tried: ${uniqueCandidates.join(', ')})`),
      { status: 404 }
    );
  }

  const dir = path.join(TEMPLATES_DIR, folderName);
  const { desktopEntryFile, mobileEntryFile } = await detectTemplateEntryFiles(dir);
  const withDiskHints = buildEntryCandidates({
    preferredFile: options.preferredFile,
    variant: options.variant,
    desktopEntryFile: options.desktopEntryFile || desktopEntryFile,
    mobileEntryFile: options.mobileEntryFile || mobileEntryFile,
  });

  for (const fileName of withDiskHints) {
    const filePath = path.join(dir, fileName);
    if (fs.existsSync(filePath)) {
      return fsp.readFile(filePath, 'utf8');
    }
  }

  throw Object.assign(
    new Error(`Template entry file not found for ${folderName} (tried: ${withDiskHints.join(', ')})`),
    { status: 404 }
  );
}

async function deleteTemplateFolder(folderName) {
  if (storage.useObjectStorage()) {
    await objectStorage.deleteByPrefix(`templates/${folderName}/`);
    return;
  }
  const dest = path.join(TEMPLATES_DIR, folderName);
  if (fs.existsSync(dest)) {
    await fsp.rm(dest, { recursive: true, force: true });
  }
}

async function detectTemplateEntryFiles(templateDir) {
  const candidates = await fsp.readdir(templateDir).catch(() => []);
  const lowerMap = new Map(candidates.map((name) => [name.toLowerCase(), name]));

  const desktopCandidateNames = [
    'index_desktop.html',
    'index_desktop.htm',
    'index_desktop',
    'desktop.html',
    'desktop.htm',
  ];
  const mobileCandidateNames = [
    'index_mobile.html',
    'index_mobile.htm',
    'index_mobile',
    'mobile.html',
    'mobile.htm',
  ];

  const desktopEntryFile =
    desktopCandidateNames.map((n) => lowerMap.get(n)).find(Boolean) || lowerMap.get('index.html') || null;

  const mobileEntryFile = mobileCandidateNames.map((n) => lowerMap.get(n)).find(Boolean) || null;

  return { desktopEntryFile, mobileEntryFile };
}

module.exports = {
  extractTemplateZip,
  deleteTemplateFolder,
  readTemplateHtml,
  saveThumbnail,
  detectTemplateEntryFiles,
};
