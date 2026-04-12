const express    = require('express');
const prisma     = require('../utils/prisma');
const siteUrls   = require('../config/siteUrls');
const { verifyInvitePreviewToken } = require('../services/previewToken');
const { renderTemplate, buildInvitationData, buildDemoData } = require('../services/templateRenderer');
const { getAamantranSdkScript } = require('../services/aamantranSdk');

const router = express.Router();

router.get('/sdk/aamantran-sdk.js', (_req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.send(getAamantranSdkScript());
});

/**
 * Append a fixed floating "Buy now" button to demo HTML (links to landing checkout).
 */
function injectDemoBuyBar(html, templateSlug) {
  const landing = siteUrls.landingUrl();
  const checkoutUrl = `${landing}/checkout/${encodeURIComponent(templateSlug)}`;
  const bar = `
<style id="aamantran-demo-buy-bar">
  .aamantran-demo-buy-wrap{
    position:fixed;left:0;right:0;bottom:0;z-index:2147483646;
    display:flex;align-items:center;justify-content:center;
    padding:10px 14px;padding-bottom:max(10px,env(safe-area-inset-bottom));
    background:transparent;
    pointer-events:none;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  }
  .aamantran-demo-buy-wrap .aamantran-btn-buy{
    pointer-events:auto;
    display:inline-flex;align-items:center;justify-content:center;
    min-width:200px;padding:12px 28px;border-radius:999px;
    background:rgba(110,31,46,0.8);color:#fff !important;text-decoration:none;
    font-weight:600;font-size:0.95rem;letter-spacing:0.02em;
    border:1px solid rgba(255,255,255,0.22);
    box-shadow:0 4px 18px rgba(0,0,0,0.12);
  }
  .aamantran-demo-buy-wrap .aamantran-btn-buy:hover{
    background:rgba(110,31,46,0.88);filter:brightness(1.03);
  }
  .aamantran-demo-watermark{
    position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483645;
    pointer-events:none;overflow:hidden;
  }
  .aamantran-demo-watermark span{
    position:absolute;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    font-size:18px;font-weight:700;letter-spacing:3px;
    color:rgba(0,0,0,0.06);
    white-space:nowrap;
    transform:rotate(-30deg);
    user-select:none;
    -webkit-user-select:none;
  }
</style>
<div class="aamantran-demo-watermark" aria-hidden="true"></div>
<script>
(function(){
  var w=document.querySelector('.aamantran-demo-watermark');
  if(!w)return;
  var cols=Math.ceil(window.innerWidth/280);
  var rows=Math.ceil(window.innerHeight/180);
  for(var r=0;r<rows+2;r++){
    for(var c=0;c<cols+2;c++){
      var s=document.createElement('span');
      s.textContent='Aamantran';
      s.style.left=(c*280-60)+'px';
      s.style.top=(r*180-40)+'px';
      w.appendChild(s);
    }
  }
})();
</script>
<div class="aamantran-demo-buy-wrap" role="navigation" aria-label="Purchase">
  <a class="aamantran-btn-buy" href="${checkoutUrl}">Buy now</a>
</div>`;

  const lower = html.toLowerCase();
  const closeBody = lower.lastIndexOf('</body>');
  if (closeBody !== -1) {
    return html.slice(0, closeBody) + bar + html.slice(closeBody);
  }
  return html + bar;
}

function detectVariant(req) {
  const forced = String(req.query.view || '').toLowerCase();
  if (forced === 'mobile' || forced === 'desktop') return forced;
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return /android|iphone|ipad|ipod|mobile|windows phone/.test(ua) ? 'mobile' : 'desktop';
}

function addMonths(date, months) {
  const d = new Date(date);
  const dayOfMonth = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < dayOfMonth) d.setDate(0);
  return d;
}

function computeExpiryFromFunctions(functions = []) {
  if (!Array.isArray(functions) || functions.length === 0) return null;
  const maxDate = functions.reduce((latest, fn) => {
    if (!fn?.date) return latest;
    const dt = new Date(fn.date);
    if (Number.isNaN(dt.getTime())) return latest;
    return !latest || dt > latest ? dt : latest;
  }, null);
  return maxDate ? addMonths(maxDate, 6) : null;
}

// GET /demo/:slug — serve template with demo data (public)
router.get('/demo/:slug', async (req, res) => {
  const template = await prisma.template.findUnique({
    where:   { slug: req.params.slug },
    include: { demoData: { include: { functions: { orderBy: { sortOrder: 'asc' } } } } },
  });

  if (!template) return res.status(404).send('<h1>Template not found</h1>');
  if (!template.demoData) return res.status(404).send('<h1>No demo data configured for this template</h1>');

  const data = buildDemoData(template.demoData);
  const variant = detectVariant(req);
  const html = await renderTemplate(template.folderPath, data, {
    variant,
    preferredFile: variant === 'mobile' ? template.mobileEntryFile : template.desktopEntryFile,
    desktopEntryFile: template.desktopEntryFile,
    mobileEntryFile: template.mobileEntryFile,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injectDemoBuyBar(html, template.slug));
});

// GET /i/:slug — serve couple's live invitation (public)
router.get('/i/:slug', async (req, res) => {
  const event = await prisma.event.findUnique({
    where:   { slug: req.params.slug },
    include: {
      template:     true,
      functions:    { orderBy: { sortOrder: 'asc' }, include: { venue: true } },
      people:       { orderBy: { sortOrder: 'asc' } },
      venues:       true,
      customFields: true,
      media:        { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!event) return res.status(404).send('<h1>Invitation not found</h1>');
  if (!event.isPublished) return res.status(403).send('<h1>This invitation is not published yet</h1>');
  const expiryDate = event.expiresAt ? new Date(event.expiresAt) : computeExpiryFromFunctions(event.functions);
  if (expiryDate && expiryDate.getTime() < Date.now()) {
    return res.status(410).send('<h1>This invitation has expired. Please contact the host.</h1>');
  }

  // Log the open event (non-blocking)
  prisma.invitationEvent.create({
    data: { eventId: event.id, type: 'opened', metadata: { ua: req.headers['user-agent'] } },
  }).catch(() => {});

  const data = buildInvitationData(event);
  const variant = detectVariant(req);
  const apiBase = siteUrls.apiBaseUrl();
  const sdkFunctions = (event.functions || []).map((fn) => ({
    id: fn.id,
    name: fn.name,
    date: fn.date,
  }));
  // Build photos list for window.__AAMANTRAN__.photos from all photo-type media
  const sdkPhotos = (data.photos || []);
  const html = await renderTemplate(event.template.folderPath, data, {
    variant,
    preferredFile: variant === 'mobile' ? event.template.mobileEntryFile : event.template.desktopEntryFile,
    desktopEntryFile: event.template.desktopEntryFile,
    mobileEntryFile: event.template.mobileEntryFile,
    aamantranContext: {
      eventSlug: event.slug,
      apiBase,
      functions: sdkFunctions,
      photos: sdkPhotos,
      rsvpEnabled: event.rsvpEnabled !== false,
      guestNotesEnabled: event.guestNotesEnabled !== false,
    },
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// GET /i/:slug/preview — draft preview requires ?pt= signed JWT (admin or couple dashboard)
router.get('/i/:slug/preview', async (req, res) => {
  const event = await prisma.event.findUnique({
    where:   { slug: req.params.slug },
    include: {
      template:     true,
      functions:    { orderBy: { sortOrder: 'asc' }, include: { venue: true } },
      people:       { orderBy: { sortOrder: 'asc' } },
      venues:       true,
      customFields: true,
      media:        { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!event) return res.status(404).send('<h1>Invitation not found</h1>');

  if (!event.isPublished) {
    const pt = req.query.pt;
    if (!verifyInvitePreviewToken(pt, event.slug)) {
      return res
        .status(403)
        .send('<h1>Preview not available</h1><p>Use “Open preview” from the admin user page or couple dashboard to get a valid link.</p>');
    }
  }

  const data = buildInvitationData(event);
  const variant = detectVariant(req);
  const html = await renderTemplate(event.template.folderPath, data, {
    variant,
    preferredFile: variant === 'mobile' ? event.template.mobileEntryFile : event.template.desktopEntryFile,
    desktopEntryFile: event.template.desktopEntryFile,
    mobileEntryFile: event.template.mobileEntryFile,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
