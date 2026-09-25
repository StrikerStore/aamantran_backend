/**
 * What a template supports, in buyer-facing terms, for the product page.
 *
 * The storefront must describe the design a buyer actually receives, so this
 * reads the *published* version (its own fieldSchema snapshot and folder) and
 * only falls back to the draft for templates that were never versioned.
 *
 * Output is a whitelist: labels and booleans only. It never exposes
 * fieldSchema itself, schema keys, demo values or storage paths.
 *
 * rsvp/wishes come from scanning the template HTML, which lives in R2 — a
 * network read. Results are therefore cached per template version, reads are
 * de-duplicated while in flight, and a slow or failed read degrades to `null`
 * ("unknown") rather than delaying or failing the request. The storefront
 * omits any claim it gets back as null.
 */
const { getMediaSlots, parseFieldSchema } = require('./mediaSlotUtils');
const { analyseHtml } = require('./templateIntrospect.service');
const { readTemplateHtml } = require('./fileManager');

const HTML_READ_TIMEOUT_MS = 2500;
const CACHE_TTL_MS         = 10 * 60 * 1000;
// A failed HTML read is retried sooner, so a transient R2 error doesn't pin
// rsvp/wishes to "unknown" for the full TTL.
const FAILED_READ_TTL_MS   = 60 * 1000;
const CACHE_MAX_ENTRIES    = 200;

/** key -> { expiresAt, promise } */
const cache = new Map();

/**
 * Readable fallback for a schema row with no label: "person1_father" and
 * "dressCode" both become sentence case. Keys are internal identifiers, so a
 * raw key must never reach a buyer.
 */
function humanize(key) {
  const s = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** The published snapshot when there is one, otherwise the draft. */
function resolveSource(template) {
  const v = template.currentVersion;
  if (v && v.folderPath) {
    return {
      versionKey:       `v:${v.id}`,
      folder:           v.folderPath,
      fieldSchema:      v.fieldSchema ?? template.fieldSchema,
      desktopEntryFile: v.desktopEntryFile || template.desktopEntryFile,
      mobileEntryFile:  v.mobileEntryFile  || template.mobileEntryFile,
    };
  }
  return {
    versionKey:       'draft',
    folder:           `${template.folderPath}/draft`,
    fieldSchema:      template.fieldSchema,
    desktopEntryFile: template.desktopEntryFile,
    mobileEntryFile:  template.mobileEntryFile,
  };
}

/**
 * The schema-derived part. Pure and synchronous, so it is testable without
 * storage. `null` means "not declared" and tells the UI to omit the section.
 */
function buildSchemaCapabilities(fieldSchemaInput, languagesCsv) {
  const fs = parseFieldSchema(fieldSchemaInput) || {};

  const people = Array.isArray(fs.people)
    ? fs.people
        .filter((p) => p && typeof p === 'object' && p.role)
        .map((p) => ({ label: String(p.label || humanize(p.role)), photo: Boolean(p.photo) }))
    : null;

  const ceremonyFields = fs.functionFields && typeof fs.functionFields === 'object'
    ? Object.entries(fs.functionFields)
        .filter(([, cfg]) => cfg && typeof cfg === 'object' && cfg.enabled)
        .map(([key, cfg]) => String(cfg.label || humanize(key)))
    : null;

  const slots = getMediaSlots(fs);
  const mediaSlots = slots
    ? slots.map((s) => ({
        // getMediaSlots falls back to the raw key when no label is set, which
        // would publish an identifier like "background_music"; humanize instead.
        label:    s.label && s.label !== s.key ? String(s.label) : humanize(s.key),
        type:     s.type,
        multiple: s.multiple,
        ...(s.multiple && { max: s.max }),
      }))
    : null;

  const customFieldLabels = Array.isArray(fs.customFields)
    ? fs.customFields
        .filter((cf) => cf && typeof cf === 'object' && cf.key)
        .map((cf) => String(cf.label || humanize(cf.key)))
    : null;

  const languages = String(languagesCsv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { people, ceremonyFields, mediaSlots, customFieldLabels, languages };
}

/** Resolve after `ms` with `fallback`, so a slow read can't hold the request. */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Whether the template markup contains the RSVP form and wish wall.
 * This is what the design *supports*; each couple can still switch either off.
 */
async function detectGuestFeatures(source) {
  try {
    const html = await withTimeout(
      readTemplateHtml(source.folder, {
        preferredFile:    source.desktopEntryFile,
        desktopEntryFile: source.desktopEntryFile,
        mobileEntryFile:  source.mobileEntryFile,
      }),
      HTML_READ_TIMEOUT_MS,
      null,
    );
    if (html == null) return { rsvp: null, wishes: null, readOk: false };
    const { usesRsvp, usesWishes } = analyseHtml(html);
    return { rsvp: usesRsvp, wishes: usesWishes, readOk: true };
  } catch {
    return { rsvp: null, wishes: null, readOk: false };
  }
}

/**
 * Capabilities for one template. Never throws.
 *
 * `template` must include: slug, folderPath, fieldSchema, languages,
 * desktopEntryFile, mobileEntryFile, updatedAt, and
 * currentVersion { id, folderPath, fieldSchema, desktopEntryFile, mobileEntryFile }.
 */
function getTemplateCapabilities(template) {
  const source = resolveSource(template);
  const stamp  = template.updatedAt ? new Date(template.updatedAt).getTime() : 0;
  const key    = `${template.slug}:${source.versionKey}:${stamp}`;
  const now    = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;

  const entry = { expiresAt: now + CACHE_TTL_MS, promise: null };
  entry.promise = (async () => {
    const schemaPart = buildSchemaCapabilities(source.fieldSchema, template.languages);
    const { rsvp, wishes, readOk } = await detectGuestFeatures(source);
    if (!readOk) entry.expiresAt = Date.now() + FAILED_READ_TTL_MS;
    return { ...schemaPart, rsvp, wishes };
  })();

  cache.set(key, entry);
  // Bounded: drop the oldest insertion once over the cap.
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);

  return entry.promise;
}

/** Test hook. */
function clearCapabilitiesCache() {
  cache.clear();
}

module.exports = {
  getTemplateCapabilities,
  buildSchemaCapabilities,
  clearCapabilitiesCache,
};
