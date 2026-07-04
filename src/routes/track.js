const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { parseUserAgent } = require('../utils/uaParser');
const { trackLimiter } = require('../middleware/rateLimits');
const siteUrls = require('../config/siteUrls');

// navigator.sendBeacon sends text/plain to stay a "simple" CORS request —
// accept it here and parse the JSON manually.
router.use(express.text({ type: 'text/plain', limit: '16kb' }));

const EVENT_TYPES = new Set([
  'pageview',
  'view_template',
  'initiate_checkout',
  'purchase',
  'register_complete',
]);
const SESSION_ID_RE = /^[a-zA-Z0-9-]{16,64}$/;

/** Referrer → hostname; own domains count as direct (null). */
function normalizeReferrer(raw) {
  if (!raw) return null;
  let host;
  try {
    host = new URL(String(raw)).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host) return null;
  const ownHosts = [siteUrls.landingUrl(), siteUrls.apiBaseUrl(), siteUrls.coupleDashboardUrl()]
    .map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } })
    .filter(Boolean);
  if (ownHosts.some((own) => host === own || host.endsWith(`.${own}`))) return null;
  return host.slice(0, 255);
}

function cleanStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

router.post('/', trackLimiter, async (req, res) => {
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ ok: false });
  }

  const sessionId = String(payload.sessionId || '');
  const type = String(payload.type || '');
  const path = cleanStr(payload.path, 512);
  if (!SESSION_ID_RE.test(sessionId) || !EVENT_TYPES.has(type) || !path) {
    return res.status(400).json({ ok: false });
  }

  let metadata;
  if (payload.meta && typeof payload.meta === 'object') {
    const json = JSON.stringify(payload.meta);
    if (json.length <= 2000) metadata = payload.meta;
  }

  const { deviceType, browser, os } = parseUserAgent(req.headers['user-agent']);
  // Country always available behind Cloudflare; region/city require the
  // "Add visitor location headers" managed transform (free) in the CF dashboard.
  const country = cleanStr(req.headers['cf-ipcountry'], 64);
  const region = cleanStr(req.headers['cf-region'], 128);
  const city = cleanStr(req.headers['cf-ipcity'], 128);

  const utm = payload.utm && typeof payload.utm === 'object' ? payload.utm : {};
  const isPageview = type === 'pageview';

  try {
    await prisma.websiteSession.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        referrer: normalizeReferrer(payload.referrer),
        utmSource: cleanStr(utm.source, 128),
        utmMedium: cleanStr(utm.medium, 128),
        utmCampaign: cleanStr(utm.campaign, 128),
        deviceType,
        browser,
        os,
        country,
        region,
        city,
        pageViews: isPageview ? 1 : 0,
      },
      // First-touch attribution: referrer/utm/device/geo are never overwritten.
      update: {
        lastSeenAt: new Date(),
        ...(isPageview ? { pageViews: { increment: 1 } } : {}),
      },
    });
    await prisma.websiteEvent.create({
      data: { sessionId, type, path, metadata },
    });
  } catch (err) {
    console.error('[track] failed:', err.message);
    return res.status(500).json({ ok: false });
  }

  res.json({ ok: true });
});

module.exports = router;
