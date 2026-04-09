/**
 * Object storage (Cloudflare R2 via S3 API) vs local disk.
 * R2 is enabled when all required env vars are set.
 */

function trim(v) {
  return v != null ? String(v).trim() : '';
}

function useObjectStorage() {
  return Boolean(
    trim(process.env.R2_ACCOUNT_ID) &&
      trim(process.env.R2_ACCESS_KEY_ID) &&
      trim(process.env.R2_SECRET_ACCESS_KEY) &&
      trim(process.env.R2_BUCKET_NAME) &&
      trim(process.env.R2_PUBLIC_BASE_URL)
  );
}

function r2AccountId() {
  return trim(process.env.R2_ACCOUNT_ID);
}

function r2BucketName() {
  return trim(process.env.R2_BUCKET_NAME);
}

function r2AccessKeyId() {
  return trim(process.env.R2_ACCESS_KEY_ID);
}

function r2SecretAccessKey() {
  return trim(process.env.R2_SECRET_ACCESS_KEY);
}

/** Public origin for browser-facing URLs (e.g. https://media.aamantran.online) */
function objectStoragePublicBase() {
  const u = trim(process.env.R2_PUBLIC_BASE_URL);
  return u.replace(/\/$/, '');
}

/**
 * Prefix for template HTML/CSS asset references.
 * Local: /s/{folder}/  — served by Express static.
 * R2:    https://media.../templates/{folder}/
 */
function templateAssetPrefix(folderName) {
  const safe = String(folderName || '').replace(/^\/+|\/+$/g, '');
  if (useObjectStorage()) {
    return `${objectStoragePublicBase()}/templates/${safe}/`;
  }
  return `/s/${safe}/`;
}

const EXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.zip': 'application/zip',
};

function contentTypeForPath(filePath) {
  const path = require('path');
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

/**
 * If url is under our public R2 base, return object key; else null.
 */
function publicUrlToObjectKey(url) {
  if (!url || !useObjectStorage()) return null;
  const base = objectStoragePublicBase();
  const s = String(url).trim();
  if (!s.startsWith(`${base}/`)) return null;
  return s.slice(base.length + 1);
}

module.exports = {
  useObjectStorage,
  r2AccountId,
  r2BucketName,
  r2AccessKeyId,
  r2SecretAccessKey,
  objectStoragePublicBase,
  templateAssetPrefix,
  contentTypeForPath,
  publicUrlToObjectKey,
};
