/**
 * /r2-proxy/* — Transparent R2 asset proxy.
 *
 * Template HTML (served from api.aamantran.online) references JS/CSS that
 * lives in the R2 bucket.  Loading those resources cross-origin triggers
 * CORS errors because R2 does not echo back Access-Control-Allow-Origin.
 *
 * This proxy re-serves R2 objects from the API origin so the browser never
 * makes a cross-origin request for template assets.
 *
 * URL shape:  GET /r2-proxy/templates/<folder>/assets/<file>
 * R2 object key: templates/<folder>/assets/<file>
 */

const express       = require('express');
const storage       = require('../config/storage');
const objectStorage = require('../services/objectStorage');
const siteUrls      = require('../config/siteUrls');

const router = express.Router();

// Content-types whose body contains asset URLs we must rewrite so nested
// resources (fonts loaded from CSS url(), images loaded from JS bundles)
// stay same-origin and don't trip CSP font-src / connect-src directives.
const REWRITABLE_CT = /^text\/css|^application\/javascript/i;

function rewriteAssetOriginsInBody(buf, ct) {
  if (!REWRITABLE_CT.test(ct)) return buf;
  const r2Base = storage.objectStoragePublicBase();
  if (!r2Base) return buf;
  const proxyBase = `${siteUrls.apiBaseUrl()}/r2-proxy`;
  const text = buf.toString('utf8').split(r2Base).join(proxyBase);
  return Buffer.from(text, 'utf8');
}

// Handle OPTIONS preflight explicitly (belt-and-suspenders)
router.options('/*', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.sendStatus(204);
});

router.get('/*', async (req, res) => {
  if (!storage.useObjectStorage()) {
    return res.status(404).send('Not found');
  }

  // Decode and strip any leading slash so it becomes a bare R2 key
  const key = decodeURIComponent(req.params[0] || '').replace(/^\/+/, '');
  if (!key) return res.status(400).send('Bad request');

  try {
    const buf = await objectStorage.getObjectBuffer(key);
    const ct  = storage.contentTypeForPath(key);
    const body = rewriteAssetOriginsInBody(buf, ct);

    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Immutable cache — hashed filenames, safe to cache forever in the browser
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(body);
  } catch (err) {
    const code   = err?.name || err?.Code || err?.code;
    const status = err?.$metadata?.httpStatusCode;
    if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) {
      return res.status(404).send('Not found');
    }
    throw err;
  }
});

module.exports = router;
