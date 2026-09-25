const express    = require('express');
const prisma     = require('../utils/prisma');
const siteUrls   = require('../config/siteUrls');
const { verifyInvitePreviewToken } = require('../services/previewToken');
const { renderTemplate, buildInvitationData, buildDemoData, pickShareImage, injectSocialMeta } = require('../services/templateRenderer');
const { getAamantranSdkScript } = require('../services/aamantranSdk');
const { storefrontFromRequest, landingUrlFor, normalizeStorefront } = require('../utils/storefront');
const { LINK_MINUTES, findTrialForRender, overlayTrialOnDemoData } = require('../services/trialDemo.service');
const { legacySlotMapFor } = require('../utils/personSlots');

const router = express.Router();

/**
 * Prevent every layer (browser, CDN, reverse proxy) from caching invite
 * and demo pages.  Applied to HTML responses and to /r2-proxy/* assets.
 *
 * Cache-Control: no-store  — do NOT store the response at all
 * Pragma: no-cache          — HTTP/1.0 compat
 * Expires: 0                — mark as already expired (belt-and-suspenders)
 */
function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store'); // Cloudflare / Fastly CDNs
}

router.get('/sdk/aamantran-sdk.js', (_req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.send(getAamantranSdkScript());
});

/**
 * Append a fixed floating "Buy now" button to demo HTML (links to landing checkout).
 *
 * Demos are served from the API domain, so this page has no idea which
 * storefront the visitor came from unless the link says so. Both websites append
 * `?storefront=`, and the button sends them back to that site's checkout --
 * otherwise someone browsing aamantranglobal.com taps Buy now and lands on the
 * India site's rupee checkout, which is the whole funnel lost.
 */
function injectDemoBuyBar(html, templateSlug, storefront, options = {}) {
  const landing = landingUrlFor(storefront);
  const checkoutUrl = options.checkoutUrl || `${landing}/checkout/${encodeURIComponent(templateSlug)}`;
  // A personal demo is usually framed by the website, so Buy must leave the
  // frame. With no options this function's output is unchanged for /demo.
  const buyTarget = options.trial ? ' target="_top"' : '';
  // On a personal demo the button explains itself: the watermark is the reason
  // to buy, and the details typed into the demo carry into the purchase
  // (applyTrialPrefill), so both halves of the sentence are true.
  const buyLabel = options.trial ? 'Buy this design' : 'Buy now';
  const buyNote = options.trial
    ? `<style id="aamantran-demo-buy-note">
  .aamantran-demo-buy-wrap{flex-direction:column;gap:8px}
  .aamantran-demo-buy-note{
    pointer-events:auto;margin:0;max-width:min(92vw,420px);padding:8px 14px;border-radius:12px;
    background:rgba(41,35,31,0.86);color:#fff;font-size:13px;font-weight:500;line-height:1.4;text-align:center;
    box-shadow:0 4px 14px rgba(0,0,0,0.12);
  }
</style><p class="aamantran-demo-buy-note">Buy to keep the details you entered and remove the watermark.</p>`
    : '';
  const trialExtras = options.trial ? trialDemoExtras({ ...options.trial, checkoutUrl }) : '';
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
    color:rgba(0,0,0,0.18);
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
  var W=window.innerWidth;var H=window.innerHeight;
  var cols=Math.ceil(W/280)+6;
  var rows=Math.ceil((H+W*0.7)/180)+4;
  for(var r=0;r<rows;r++){
    for(var c=0;c<cols;c++){
      var s=document.createElement('span');
      s.textContent='Aamantran';
      s.style.left=(c*280-120)+'px';
      s.style.top=(r*180-120)+'px';
      w.appendChild(s);
    }
  }
})();
</script>
<div class="aamantran-demo-buy-wrap" role="navigation" aria-label="Purchase">
  ${buyNote}<a class="aamantran-btn-buy" href="${checkoutUrl}"${buyTarget}>${buyLabel}</a>
</div>${trialExtras}`;

  const lower = html.toLowerCase();
  const closeBody = lower.lastIndexOf('</body>');
  if (closeBody !== -1) {
    return html.slice(0, closeBody) + bar + html.slice(closeBody);
  }
  return html + bar;
}

/**
 * Let the Template Lab embed an invite in its device-preview iframe.
 *
 * helmet runs with `useDefaults`, which emits `frame-ancestors 'self'` — that
 * blocks the Lab's preview panel. Widened for test events ONLY: a real couple's
 * invitation keeps 'self' so it can never be framed by another origin. The rest
 * of helmet's policy is preserved by rewriting just this one directive.
 */
function allowLabFraming(res) {
  setFrameAncestors(res, [siteUrls.labUrl()]);
}

/** Rewrites only helmet's frame-ancestors directive, keeping the rest of the policy. */
function setFrameAncestors(res, origins) {
  const existing = res.getHeader('Content-Security-Policy');
  if (!existing) return;

  const replacement = ['frame-ancestors', "'self'", ...origins].join(' ');
  const directives = String(existing)
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);

  const idx = directives.findIndex((d) => d.toLowerCase().startsWith('frame-ancestors'));
  if (idx === -1) directives.push(replacement);
  else directives[idx] = replacement;

  res.setHeader('Content-Security-Policy', directives.join('; '));
}

/** Origins of both storefront websites, which embed personal demos. */
function landingOrigins() {
  const origins = [siteUrls.landingUrl(), siteUrls.landingUrlIntl()]
    .map((url) => { try { return new URL(url).origin; } catch { return null; } })
    .filter(Boolean);
  return [...new Set(origins)];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Removes share-card and description tags a template declares.
 *
 * Templates commonly fill og:title with {{person1_name}} & {{person2_name}}. For a
 * personal demo that would hand the visitor's names to WhatsApp's (or anyone's)
 * link-preview scraper, which keeps its own copy long after our 24 hours are up.
 * Generic tags are injected in their place.
 */
function stripShareMeta(html) {
  return String(html).replace(
    /<meta\b[^>]*\b(?:property|name)\s*=\s*["']?(?:og:[^"'\s>]*|twitter:[^"'\s>]*|description)(?=["'\s/>])[^>]*>/gi,
    '',
  );
}

/** The countdown, the ended overlay, and the RSVP/wish blocker for /try pages. */
function trialDemoExtras({ remainingMs, createAgainUrl, checkoutUrl }) {
  const remaining = Math.max(0, Math.floor(Number(remainingMs) || 0));
  const seconds = Math.ceil(remaining / 1000);
  const initial = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const font = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  return `
<style id="aamantran-trial-demo">
  .aamantran-trial-pill{
    position:fixed;top:max(10px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);
    z-index:2147483646;display:inline-flex;align-items:center;gap:6px;
    padding:7px 14px;border-radius:999px;background:rgba(41,35,31,0.84);color:#fff;
    font:600 13px/1.2 ${font};white-space:nowrap;pointer-events:none;
    box-shadow:0 4px 14px rgba(0,0,0,0.15);
  }
  .aamantran-trial-pill time{font-variant-numeric:tabular-nums}
  .aamantran-trial-toast{
    position:fixed;left:50%;bottom:calc(132px + env(safe-area-inset-bottom));transform:translateX(-50%);
    z-index:2147483647;width:max-content;max-width:min(92vw,420px);padding:12px 16px;border-radius:12px;
    background:#29231F;color:#fff;font:500 14px/1.4 ${font};text-align:center;
    box-shadow:0 8px 24px rgba(0,0,0,0.2);opacity:0;transition:opacity .2s;pointer-events:none;
  }
  .aamantran-trial-toast[data-show]{opacity:1}
  .aamantran-trial-ended{
    position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;
    padding:24px;background:rgba(251,247,240,0.96);font-family:${font};color:#29231F;
  }
  html.aamantran-trial-over .aamantran-trial-ended{display:flex}
  .aamantran-trial-ended div{max-width:380px;text-align:center}
  .aamantran-trial-ended h2{margin:0 0 8px;font-size:22px;font-weight:600}
  .aamantran-trial-ended p{margin:0 0 20px;font-size:15px;line-height:1.5;color:#6B625B}
  .aamantran-trial-ended a{
    display:flex;align-items:center;justify-content:center;min-height:44px;margin-top:10px;
    border-radius:999px;font-weight:600;font-size:15px;text-decoration:none;
  }
  .aamantran-trial-ended a.primary{background:#712F41;color:#fff}
  .aamantran-trial-ended a.secondary{border:1px solid #712F41;color:#712F41}
  @media (prefers-reduced-motion: reduce){.aamantran-trial-toast{transition:none}}
</style>
<div class="aamantran-trial-pill" aria-hidden="true">Your demo · expires in <time id="aamantran-trial-time">${initial}</time></div>
<div class="aamantran-trial-toast" id="aamantran-trial-toast" role="status" aria-live="polite"></div>
<div class="aamantran-trial-ended" role="dialog" aria-modal="true" aria-labelledby="aamantran-trial-ended-title">
  <div>
    <h2 id="aamantran-trial-ended-title">This demo has ended</h2>
    <p>Demo links work for ${LINK_MINUTES} minutes, so the names you typed don’t stay on a page anyone can open.</p>
    <a class="primary" href="${escapeHtml(createAgainUrl)}" target="_top">Create a new demo</a>
    <a class="secondary" href="${escapeHtml(checkoutUrl)}" target="_top">Buy this invitation</a>
  </div>
</div>
<script>
(function(){
  var end=Date.now()+${remaining};
  var out=document.getElementById('aamantran-trial-time');
  var timer;
  function tick(){
    var left=Math.max(0,end-Date.now());
    var s=Math.ceil(left/1000);
    if(out)out.textContent=Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);
    if(left<=0){document.documentElement.classList.add('aamantran-trial-over');clearInterval(timer);}
  }
  tick();timer=setInterval(tick,1000);
  // No SDK is injected, so a template's RSVP or wish form would otherwise fall
  // back to a native submit. Capture phase: runs before any handler on the form.
  var toast=document.getElementById('aamantran-trial-toast');var hide;
  document.addEventListener('submit',function(e){
    e.preventDefault();e.stopImmediatePropagation();
    if(!toast)return;
    toast.textContent='RSVPs and wishes work on your real invitation. Nothing was sent.';
    toast.setAttribute('data-show','');
    clearTimeout(hide);hide=setTimeout(function(){toast.removeAttribute('data-show');},4000);
  },true);
})();
</script>`;
}

/** The page for a demo that has ended, never existed, or could not be shown. */
function renderTrialEndedPage({ title, message, createAgainUrl, checkoutUrl }) {
  const buy = checkoutUrl
    ? `<a class="secondary" href="${escapeHtml(checkoutUrl)}" target="_top">Buy this invitation</a>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${escapeHtml(title)} — Aamantran</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
    background:#FBF7F0;color:#29231F;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{width:100%;max-width:420px;text-align:center}
  .brand{margin:0 0 28px;font-size:14px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#712F41}
  h1{margin:0 0 10px;font-size:26px;font-weight:600;line-height:1.25}
  p{margin:0 0 24px;font-size:16px;line-height:1.55;color:#6B625B}
  a{display:flex;align-items:center;justify-content:center;min-height:48px;margin-top:10px;border-radius:999px;
    font-weight:600;font-size:16px;text-decoration:none}
  a:focus-visible{outline:3px solid #B08D57;outline-offset:3px}
  .primary{background:#712F41;color:#fff}
  .primary:hover{background:#572333}
  .secondary{border:1px solid #712F41;color:#712F41;background:#fff}
</style>
</head>
<body>
<main>
  <p class="brand">Aamantran</p>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <a class="primary" href="${escapeHtml(createAgainUrl)}" target="_top">Create a new demo</a>
  ${buy}
</main>
</body>
</html>`;
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

/**
 * A partial invite shows the main invite's people and photos.
 *
 * The partial ("subset") invite is the same celebration with fewer functions.
 * Its own people and media rows are a copy taken when the pair was created, and
 * the couple only ever edits the main invite — so that copy goes stale, and even
 * points at files the main invite deletes when a photo is replaced. Rendering
 * from the main invite's rows keeps both links on one set of photos. Functions
 * stay the partial's own. Falls back to the partial's rows if the main is gone.
 */
async function withPairPhotos(event, db = prisma) {
  if (event?.inviteScope !== 'subset' || !event.invitePairId) return event;
  const main = await db.event.findFirst({
    where: { invitePairId: event.invitePairId, inviteScope: 'full', id: { not: event.id } },
    select: {
      people: { orderBy: { sortOrder: 'asc' } },
      media:  { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!main) return event;
  return { ...event, people: main.people, media: main.media };
}

// GET /demo/:slug — serve template with demo data (public)
router.get('/demo/:slug', async (req, res) => {
  const template = await prisma.template.findUnique({
    where:   { slug: req.params.slug },
    include: { demoData: { include: { functions: { orderBy: { sortOrder: 'asc' } } } } },
  });

  if (!template) return res.status(404).send('<h1>Template not found</h1>');
  // Template Lab uploads are private to their developer and have no store
  // listing — /demo would wrap them in a "Buy now" bar for something nobody
  // can buy. Developers preview through /i/lab-<handle> instead.
  if (template.sandboxOwnerId) return res.status(404).send('<h1>Template not found</h1>');
  if (!template.demoData) return res.status(404).send('<h1>No demo data configured for this template</h1>');

  // The draft is rendered, so the draft's schema holds its slot map.
  const data = buildDemoData(template.demoData, { fieldSchema: template.fieldSchema });
  const variant = detectVariant(req);
  // Demo always renders the latest draft so admins see their in-progress edits
  // immediately. Published versions are only used by live invites.
  const html = await renderTemplate(`${template.folderPath}/draft`, data, {
    variant,
    preferredFile: variant === 'mobile' ? template.mobileEntryFile : template.desktopEntryFile,
    desktopEntryFile: template.desktopEntryFile,
    mobileEntryFile: template.mobileEntryFile,
  });

  setNoCacheHeaders(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injectDemoBuyBar(html, template.slug, storefrontFromRequest(req)));
});

// GET /try/:token — a visitor's personal demo ("try it with your names")
//
// The design's demo data with the visitor's names, date, venue and ceremonies
// laid over it, watermarked, for LINK_MINUTES. Deliberately separate from
// /i/:slug: nothing here reads or writes an event, and no SDK is injected, so an
// RSVP or wish typed into a demo goes nowhere.
router.get('/try/:token', async (req, res) => {
  const token = String(req.params.token || '');
  // Every response, including the ended page, is personal or was: never cached,
  // never indexed, and the token never leaks onward in a Referer header. Both
  // storefronts may frame it; nobody else may.
  setNoCacheHeaders(res);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  setFrameAncestors(res, landingOrigins());
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  let createAgainUrl = `${landingUrlFor(storefrontFromRequest(req))}/templates`;
  try {
    const now = new Date();
    const { status, trial } = await findTrialForRender(token, now);

    // The storefront the demo was created on wins over the query string: the
    // link is forwarded, and the person it reaches must see the same currency.
    const storefront = trial?.payload?.storefront
      ? normalizeStorefront(trial.payload.storefront)
      : storefrontFromRequest(req);
    const landing = landingUrlFor(storefront);
    const template = trial?.template;
    const buyable = Boolean(template && template.isActive && !template.sandboxOwnerId);
    const slugPath = buyable ? encodeURIComponent(template.slug) : '';
    // The link lasts minutes, the details a day: Buy keeps carrying the token
    // for as long as the details exist to prefill the builder with.
    const detailsKept = Boolean(trial) && new Date(trial.dataExpiresAt) > now;
    const checkoutUrl = buyable
      ? `${landing}/checkout/${slugPath}${detailsKept ? `?trial=${token}` : ''}`
      : '';
    createAgainUrl = buyable ? `${landing}/templates/${slugPath}?try=1` : `${landing}/templates`;

    if (status !== 'live') {
      return res.status(status === 'expired' ? 410 : 404).send(renderTrialEndedPage({
        title: 'This demo has ended',
        message: `Demo links work for ${LINK_MINUTES} minutes, so the names you typed don’t stay on a page anyone can open. It only takes a minute to make another.`,
        createAgainUrl,
        checkoutUrl,
      }));
    }

    const renderedSchema = template.currentVersion?.fieldSchema ?? template.fieldSchema;
    const demo = overlayTrialOnDemoData(template.demoData, trial.payload, legacySlotMapFor(renderedSchema));
    const data = buildDemoData(demo, { fieldSchema: renderedSchema });
    const variant = detectVariant(req);
    // Render what a buyer would get — the published version — rather than the
    // draft /demo shows admins. Draft only for a design published before
    // versioning, the same fallback live invitations use.
    const source = template.currentVersion
      ? {
          folderPath:       template.currentVersion.folderPath,
          desktopEntryFile: template.currentVersion.desktopEntryFile,
          mobileEntryFile:  template.currentVersion.mobileEntryFile,
        }
      : {
          folderPath:       `${template.folderPath}/draft`,
          desktopEntryFile: template.desktopEntryFile,
          mobileEntryFile:  template.mobileEntryFile,
        };
    let html = await renderTemplate(source.folderPath, data, {
      variant,
      preferredFile: variant === 'mobile' ? source.mobileEntryFile : source.desktopEntryFile,
      desktopEntryFile: source.desktopEntryFile,
      mobileEntryFile:  source.mobileEntryFile,
    });
    html = injectSocialMeta(stripShareMeta(html), {
      title: 'An invitation preview',
      description: `Made with Aamantran. Preview links expire after ${LINK_MINUTES} minutes.`,
    });

    prisma.trialDemo.update({ where: { id: trial.id }, data: { viewCount: { increment: 1 } } }).catch(() => {});

    const remainingMs = new Date(trial.linkExpiresAt).getTime() - now.getTime();
    return res.send(injectDemoBuyBar(html, template.slug, storefront, {
      checkoutUrl,
      trial: { remainingMs, createAgainUrl },
    }));
  } catch (error) {
    // Express 4 does not catch a rejected handler; answer rather than hang.
    console.error('[trial-demo] render failed:', error.message);
    return res.status(500).send(renderTrialEndedPage({
      title: 'We couldn’t load this demo',
      message: 'Something went wrong on our side. Please try making the demo again.',
      createAgainUrl,
      checkoutUrl: '',
    }));
  }
});

// GET /i/:slug — serve couple's live invitation (public)
router.get('/i/:slug', async (req, res) => {
  const row = await prisma.event.findUnique({
    where:   { slug: req.params.slug },
    include: {
      template:        true,
      templateVersion: true,
      functions:    { orderBy: { sortOrder: 'asc' }, include: { venue: true } },
      people:       { orderBy: { sortOrder: 'asc' } },
      venues:       true,
      customFields: true,
      media:        { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!row) return res.status(404).send('<h1>Invitation not found</h1>');
  if (!row.isPublished) return res.status(403).send('<h1>This invitation is not published yet</h1>');
  const event = await withPairPhotos(row);
  const expiryDate = event.expiresAt ? new Date(event.expiresAt) : computeExpiryFromFunctions(event.functions);
  if (expiryDate && expiryDate.getTime() < Date.now()) {
    return res.status(410).send('<h1>This invitation has expired. Please contact the host.</h1>');
  }

  // Log the open event (non-blocking). Skipped for the testing account so
  // recording takes and QA refreshes don't inflate invitation analytics.
  if (!event.isTestEvent) {
    prisma.invitationEvent.create({
      data: { eventId: event.id, type: 'opened', metadata: { ua: req.headers['user-agent'] } },
    }).catch(() => {});
  }

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
  // Each invitation renders against its pinned TemplateVersion; admin publish-changes
  // repoints all events on that template to the new snapshot. Draft fallback is for
  // legacy events whose backfill did not run.
  const renderSource = event.templateVersion
    ? {
        folderPath:       event.templateVersion.folderPath,
        desktopEntryFile: event.templateVersion.desktopEntryFile,
        mobileEntryFile:  event.templateVersion.mobileEntryFile,
      }
    : {
        folderPath:       `${event.template.folderPath}/draft`,
        desktopEntryFile: event.template.desktopEntryFile,
        mobileEntryFile:  event.template.mobileEntryFile,
      };
  // Link-preview card for WhatsApp and friends. Person 1 first, and the first
  // ceremony's date in IST — the same order and date as the dashboard's share
  // caption, so the card and the message under it agree. No venue: the caption
  // drops it whenever ceremonies span venues. The image prefers the couple's
  // uploaded WhatsApp share photo.
  const shareNames =
    [data.person1_name, data.person2_name].filter(Boolean).join(' & ')
    || (event.people || []).slice(0, 2).map((p) => p.name).filter(Boolean).join(' & ');
  const firstFnDate = event.functions?.[0]?.date;
  const shareDetails = firstFnDate
    ? new Date(firstFnDate).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
      })
    : '';

  const html = await renderTemplate(renderSource.folderPath, data, {
    variant,
    preferredFile: variant === 'mobile' ? renderSource.mobileEntryFile : renderSource.desktopEntryFile,
    desktopEntryFile: renderSource.desktopEntryFile,
    mobileEntryFile:  renderSource.mobileEntryFile,
    socialMeta: {
      title: shareNames ? `${shareNames} — Wedding Invitation` : 'You are invited!',
      description: shareDetails || 'Tap to view our invitation.',
      url: `${apiBase}/i/${event.slug}`,
      image: pickShareImage(event),
    },
    aamantranContext: {
      eventSlug: event.slug,
      apiBase,
      functions: sdkFunctions,
      photos: sdkPhotos,
      rsvpEnabled: event.rsvpEnabled !== false,
      guestNotesEnabled: event.guestNotesEnabled !== false,
    },
  });

  setNoCacheHeaders(res);
  // The testing invite sits on a stable, guessable slug and may be rendering an
  // unreleased template — keep it out of search results.
  if (event.isTestEvent) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    allowLabFraming(res);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// GET /i/:slug/preview — draft preview requires ?pt= signed JWT (admin or couple dashboard)
router.get('/i/:slug/preview', async (req, res) => {
  const row = await prisma.event.findUnique({
    where:   { slug: req.params.slug },
    include: {
      template:        true,
      templateVersion: true,
      functions:    { orderBy: { sortOrder: 'asc' }, include: { venue: true } },
      people:       { orderBy: { sortOrder: 'asc' } },
      venues:       true,
      customFields: true,
      media:        { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!row) return res.status(404).send('<h1>Invitation not found</h1>');

  if (!row.isPublished) {
    const pt = req.query.pt;
    if (!verifyInvitePreviewToken(pt, row.slug)) {
      return res
        .status(403)
        .send('<h1>Preview not available</h1><p>Use “Open preview” from the admin user page or couple dashboard to get a valid link.</p>');
    }
  }

  const event = await withPairPhotos(row);
  const data = buildInvitationData(event);
  const variant = detectVariant(req);
  const renderSource = event.templateVersion
    ? {
        folderPath:       event.templateVersion.folderPath,
        desktopEntryFile: event.templateVersion.desktopEntryFile,
        mobileEntryFile:  event.templateVersion.mobileEntryFile,
      }
    : {
        folderPath:       `${event.template.folderPath}/draft`,
        desktopEntryFile: event.template.desktopEntryFile,
        mobileEntryFile:  event.template.mobileEntryFile,
      };
  const html = await renderTemplate(renderSource.folderPath, data, {
    variant,
    preferredFile: variant === 'mobile' ? renderSource.mobileEntryFile : renderSource.desktopEntryFile,
    desktopEntryFile: renderSource.desktopEntryFile,
    mobileEntryFile:  renderSource.mobileEntryFile,
  });

  setNoCacheHeaders(res);
  // The Lab previews unpublished sandbox invites through this route.
  if (event.isTestEvent) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    allowLabFraming(res);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
