/**
 * "Try it with your names" — a personal, watermarked demo of a real template,
 * created without an account, a payment, or a contact detail.
 *
 * What a visitor types here is the only personal data involved, so it is kept
 * deliberately small and short-lived: the link dies in 15 minutes, the payload
 * is erased within 24 hours, and the IP is never stored — only a salted hash of
 * it, used to rate-limit and then discarded with the row.
 *
 * Everything below validates rather than sanitises: a payload that is not
 * exactly what we expect is refused with a reason, not quietly cleaned up and
 * stored.
 */
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const siteUrls = require('../config/siteUrls');
const { EXCLUDE_SANDBOX_TEMPLATE } = require('../utils/testFilters');
const { normalizeStorefront } = require('../utils/storefront');
const { parseFieldSchema } = require('./mediaSlotUtils');

/** How long the shareable link works. */
const LINK_MINUTES = Number(process.env.TRIAL_DEMO_LINK_MINUTES || 15);
/** How long the typed details are kept, so a purchase can be prefilled from them. */
const DATA_HOURS = Number(process.env.TRIAL_DEMO_DATA_HOURS || 24);
/** Ceiling across all visitors, so a script cannot run up storage or render cost. */
const DAILY_CAP = Number(process.env.TRIAL_DEMO_DAILY_CAP || 2000);
/** Demos one IP may create per hour, on top of the request rate limit. */
const PER_IP_HOURLY_CAP = Number(process.env.TRIAL_DEMO_PER_IP_CAP || 5);
/** A form filled faster than this was filled by a script, not a person. */
const MIN_FILL_SECONDS = 3;

const MAX_NAME = 60;
const MAX_VENUE = 80;
const MAX_CITY = 60;
const MAX_CEREMONIES = 6;
const WEDDING_MAX_YEARS_AHEAD = 3;
/** A ceremony belongs to the same celebration: a month before, a week after. */
const CEREMONY_DAYS_BEFORE = 30;
const CEREMONY_DAYS_AFTER = 7;

/**
 * Ceremonies a visitor may choose. A fixed list, because each one is rendered
 * into a real template: free text here would put arbitrary strings on a page we
 * serve.
 */
const TRIAL_CEREMONIES = ['Roka', 'Engagement', 'Haldi', 'Mehendi', 'Sangeet', 'Nikah', 'Wedding', 'Reception'];

/**
 * Letters from any script, marks (needed for Devanagari and friends), spaces and
 * the punctuation names actually contain. Digits and URL characters are absent
 * on purpose: this is the one field that reaches a rendered page, and "Priya
 * http://…" must not be a valid name.
 */
const NAME_RE = /^[\p{L}\p{M} .'’-]{1,60}$/u;
const VENUE_RE = /^[\p{L}\p{M}\p{N} ,.'’\-/&()]{1,80}$/u;
const CITY_RE = /^[\p{L}\p{M} .'’-]{1,60}$/u;

class TrialDemoError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'TrialDemoError';
    this.field = field || null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** A date-only string (YYYY-MM-DD) as a local midnight Date, or null. */
function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  // Rejects 2026-02-31 and friends, which Date would roll forward.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The visitor's details, checked field by field.
 *
 * Returns the cleaned payload. Throws TrialDemoError with the field that failed,
 * so the form can point at it rather than saying "invalid".
 */
function validateTrialPayload(input, { now = new Date() } = {}) {
  const body = input && typeof input === 'object' ? input : {};

  // Bots fill every field, including the one no human can see.
  if (text(body.website) !== '') throw new TrialDemoError('This request looks automated.', 'website');

  const startedAt = Number(body.startedAt);
  if (Number.isFinite(startedAt) && startedAt > 0) {
    const seconds = (now.getTime() - startedAt) / 1000;
    if (seconds < MIN_FILL_SECONDS) throw new TrialDemoError('That was too quick — please try again.', 'startedAt');
  }

  const brideName = text(body.brideName);
  const groomName = text(body.groomName);
  for (const [field, value] of [['brideName', brideName], ['groomName', groomName]]) {
    if (!value) throw new TrialDemoError('Please enter both names.', field);
    if (value.length > MAX_NAME || !NAME_RE.test(value)) {
      throw new TrialDemoError('Please use letters only, up to 60 characters.', field);
    }
  }

  const weddingDate = parseDateOnly(text(body.weddingDate));
  if (!weddingDate) throw new TrialDemoError('Please choose the wedding date.', 'weddingDate');
  const today = startOfDay(now);
  const latest = new Date(today);
  latest.setFullYear(latest.getFullYear() + WEDDING_MAX_YEARS_AHEAD);
  if (weddingDate < today) throw new TrialDemoError('The wedding date is in the past.', 'weddingDate');
  if (weddingDate > latest) throw new TrialDemoError('Please choose a date within the next three years.', 'weddingDate');

  const venueName = text(body.venueName);
  if (!venueName) throw new TrialDemoError('Please enter the venue.', 'venueName');
  if (venueName.length > MAX_VENUE || !VENUE_RE.test(venueName)) {
    throw new TrialDemoError('Please enter a shorter venue name, without symbols.', 'venueName');
  }

  const city = text(body.city);
  if (city && (city.length > MAX_CITY || !CITY_RE.test(city))) {
    throw new TrialDemoError('Please enter a shorter city name, without symbols.', 'city');
  }

  const rawCeremonies = Array.isArray(body.ceremonies) ? body.ceremonies : [];
  if (rawCeremonies.length === 0) throw new TrialDemoError('Please choose at least one ceremony.', 'ceremonies');
  if (rawCeremonies.length > MAX_CEREMONIES) {
    throw new TrialDemoError(`Please choose up to ${MAX_CEREMONIES} ceremonies.`, 'ceremonies');
  }

  const earliest = new Date(weddingDate.getTime() - CEREMONY_DAYS_BEFORE * DAY_MS);
  const last = new Date(weddingDate.getTime() + CEREMONY_DAYS_AFTER * DAY_MS);
  const seen = new Set();
  const ceremonies = rawCeremonies.map((entry) => {
    const item = entry && typeof entry === 'object' ? entry : {};
    const name = text(item.name);
    if (!TRIAL_CEREMONIES.includes(name)) throw new TrialDemoError('Please choose ceremonies from the list.', 'ceremonies');
    if (seen.has(name)) throw new TrialDemoError('Each ceremony can only be added once.', 'ceremonies');
    seen.add(name);

    const date = parseDateOnly(text(item.date));
    if (!date) throw new TrialDemoError(`Please choose a date for the ${name}.`, 'ceremonies');
    if (date < earliest || date > last) {
      throw new TrialDemoError(`The ${name} date is too far from the wedding date.`, 'ceremonies');
    }

    // Optional, and free text is not allowed: a time is hh:mm or nothing.
    const time = text(item.time);
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new TrialDemoError(`Please enter the ${name} time as hh:mm.`, 'ceremonies');
    }
    return { name, date: text(item.date), ...(time ? { time } : {}) };
  });

  return {
    brideName,
    groomName,
    weddingDate: text(body.weddingDate),
    venueName,
    ...(city ? { city } : {}),
    ceremonies,
  };
}

/**
 * A salted hash of the caller's IP.
 *
 * The raw address is never stored. Without a salt the hash of an IPv4 address is
 * trivially reversible by brute force, so a missing TRIAL_IP_SALT is treated as
 * "cannot identify the caller" rather than silently hashing with nothing.
 */
function hashIp(ip) {
  const salt = process.env.TRIAL_IP_SALT;
  if (!salt || !ip) return null;
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function newToken() {
  return crypto.randomBytes(16).toString('hex'); // 32 characters, URL-safe
}

/** Occasions whose invitation is about a couple, for templates that declare no people. */
const COUPLE_OCCASIONS = new Set(['wedding', 'engagement', 'reception', 'sangeet', 'haldi', 'mehendi', 'mehndi', 'roka', 'nikah']);

/**
 * The Prisma select `canTryWithNames` needs. Internal fields: callers must load
 * it separately from anything they spread into a response.
 */
const TRY_ELIGIBILITY_SELECT = {
  bestFor: true,
  fieldSchema: true,
  currentVersion: { select: { fieldSchema: true } },
  demoData: { select: { id: true, brideName: true, groomName: true, people: true } },
};

function rolesOf(list) {
  let value = list;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return Array.isArray(value)
    ? value.map((p) => String(p?.role || '').trim().toLowerCase()).filter(Boolean)
    : null;
}

/**
 * Whether a design can honestly be shown with a visitor's two names.
 *
 * The form asks for a bride, a groom, a wedding date and wedding ceremonies, so
 * a birthday or housewarming design would come back with names in the wrong
 * places. The published schema decides when it declares people; older designs
 * fall back to their demo people, then to their occasions.
 */
function canTryWithNames(template) {
  if (!template || !template.demoData) return false;
  const hasCouple = (roles) => roles.includes('bride') && roles.includes('groom');

  // The same source the product page's capabilities use: published, else draft.
  const schema = parseFieldSchema(template.currentVersion
    ? (template.currentVersion.fieldSchema ?? template.fieldSchema)
    : template.fieldSchema);
  const schemaRoles = schema && Array.isArray(schema.people) ? rolesOf(schema.people) : null;
  if (schemaRoles && schemaRoles.length) return hasCouple(schemaRoles);

  const demoRoles = rolesOf(template.demoData.people);
  if (demoRoles && demoRoles.length) return hasCouple(demoRoles);

  const occasions = String(template.bestFor || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (occasions.length && !occasions.some((o) => COUPLE_OCCASIONS.has(o))) return false;
  return Boolean(String(template.demoData.brideName || '').trim() && String(template.demoData.groomName || '').trim());
}

/**
 * Creates the demo row and returns the link to open it.
 *
 * Throws TrialDemoError when the template cannot be demoed or a cap is reached;
 * the route turns that into a 400 or 429 with the message.
 */
async function createTrialDemo({ slug, payload, ip, storefront, now = new Date() }) {
  const template = await prisma.template.findFirst({
    where: { slug: String(slug || ''), isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
    select: { id: true, slug: true, ...TRY_ELIGIBILITY_SELECT },
  });
  if (!template) throw new TrialDemoError('That design is not available.', 'slug');
  // A template with no demo data has nothing to render the visitor's names into.
  if (!template.demoData) throw new TrialDemoError('That design cannot be previewed yet.', 'slug');
  // Enforced here too, not only by hiding the button: the API is public.
  if (!canTryWithNames(template)) {
    throw new TrialDemoError('That design cannot be previewed with a couple’s names.', 'slug');
  }

  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const ipHash = hashIp(ip);
  const [todayCount, ipCount] = await Promise.all([
    prisma.trialDemo.count({ where: { createdAt: { gte: startOfDay(now) } } }),
    ipHash ? prisma.trialDemo.count({ where: { ipHash, createdAt: { gte: since } } }) : Promise.resolve(0),
  ]);
  if (todayCount >= DAILY_CAP) throw new TrialDemoError('Demos are busy right now. Please try again later.', 'cap');
  if (ipCount >= PER_IP_HOURLY_CAP) throw new TrialDemoError('You have created a few demos already. Please try again later.', 'cap');

  const trial = await prisma.trialDemo.create({
    data: {
      token: newToken(),
      templateId: template.id,
      // The storefront travels with the demo: the link gets forwarded on
      // WhatsApp, and whoever opens it must reach the checkout in the currency
      // the demo was created in, not the India site by default.
      payload: { ...payload, storefront: normalizeStorefront(storefront) },
      ipHash,
      linkExpiresAt: new Date(now.getTime() + LINK_MINUTES * 60 * 1000),
      dataExpiresAt: new Date(now.getTime() + DATA_HOURS * 60 * 60 * 1000),
    },
    select: { token: true, linkExpiresAt: true, dataExpiresAt: true },
  });

  return {
    token: trial.token,
    url: `${siteUrls.apiBaseUrl()}/try/${trial.token}`,
    linkExpiresAt: trial.linkExpiresAt,
    expiresInMinutes: LINK_MINUTES,
  };
}

/**
 * Erases demos whose data has expired.
 *
 * The link dies after 15 minutes but the row lives for 24 hours, so a visitor
 * who buys can have their details carried into the builder. After that the
 * personal data goes, whether or not anyone bought anything.
 */
async function purgeExpiredTrialDemos(now = new Date()) {
  const { count } = await prisma.trialDemo.deleteMany({ where: { dataExpiresAt: { lte: now } } });
  if (count) console.log(`[trial-demo] erased ${count} expired demo${count === 1 ? '' : 's'}`);
  return count;
}

const TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * Looks up a demo for rendering.
 *
 * `live` renders. `expired` means the row still exists but the link has run out
 * (or the design has since been withdrawn), so the page can still offer to
 * create a new demo of that design. `unknown` covers a mistyped token and a row
 * the purge has already erased — both look identical from outside, on purpose.
 */
async function findTrialForRender(token, now = new Date()) {
  if (!TOKEN_RE.test(String(token || ''))) return { status: 'unknown', trial: null };
  const trial = await prisma.trialDemo.findUnique({
    where: { token },
    include: {
      template: {
        include: {
          currentVersion: true,
          demoData: { include: { functions: { orderBy: { sortOrder: 'asc' } } } },
        },
      },
    },
  });
  if (!trial) return { status: 'unknown', trial: null };

  const template = trial.template;
  const withdrawn = !template || !template.isActive || template.sandboxOwnerId || !template.demoData;
  if (withdrawn || new Date(trial.linkExpiresAt) <= now) return { status: 'expired', trial };
  return { status: 'live', trial };
}

/**
 * A visitor-typed value made inert for any position in a template.
 *
 * Templates are compiled with Handlebars `noEscape`, so a value lands in the
 * page exactly as given — inside HTML text, an attribute, or a quoted string in
 * an inline <script>, and the CSP allows inline scripts. The validator already
 * refuses < > " and backticks; the one delimiter it must allow is the apostrophe
 * (O'Brien, D'Souza), which is enough to close a single-quoted JS string. The
 * typographic apostrophe reads the same in a name and delimits nothing.
 * The strip is a second line of defence, not the first.
 */
function inertText(value) {
  return String(value ?? '')
    .replace(/'/g, '’')
    .replace(/[<>"`\\{}]/g, '')
    .trim();
}

/** "19:30" → "7:30 PM", the style admins type into demo data. */
function toDisplayTime(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return '';
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return `${hours % 12 || 12}:${match[2]} ${suffix}`;
}

/** A map search for the venue, so a pin never points at someone else's venue. */
function mapSearchUrl(venue, city) {
  const query = [venue, city].filter(Boolean).join(', ');
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query).replace(/'/g, '%27')}`
    : '';
}

/** Ceremonies by date, then time, then the order the visitor chose them in. */
function sortCeremonies(ceremonies) {
  return (Array.isArray(ceremonies) ? ceremonies : [])
    .map((ceremony, index) => ({ ceremony, index }))
    .filter(({ ceremony }) => ceremony && typeof ceremony.date === 'string' && typeof ceremony.name === 'string')
    .sort((a, b) => a.ceremony.date.localeCompare(b.ceremony.date)
      || String(a.ceremony.time || '').localeCompare(String(b.ceremony.time || ''))
      || a.index - b.index)
    .map(({ ceremony }) => ceremony);
}

function replaceAll(text, from, to) {
  return from && typeof text === 'string' ? text.split(from).join(to) : text;
}

/**
 * The template's sample demo data with the visitor's details laid over it.
 *
 * Returns a new object in the stored TemplateDemoData shape, so it goes through
 * the same `buildDemoData` as /demo. Every place a name, date or venue can reach
 * the page is overwritten — not only the top-level fields, because
 * `buildDemoData` spreads `people[]` and custom fields *after* them, and a
 * sample bride left in either would silently replace the visitor's.
 *
 * Kept from the sample: photos, music, parents and other family, links, the
 * hashtag's shape, and each ceremony's dress code (and its time, when the
 * visitor gave none). Replaced: the couple, the wedding date, the venue, and
 * the list of ceremonies.
 */
function overlayTrialOnDemoData(demoData, payload) {
  const sample = demoData || {};
  const bride = inertText(payload.brideName);
  const groom = inertText(payload.groomName);
  const venue = inertText(payload.venueName);
  const city = inertText(payload.city);
  const weddingDate = /^\d{4}-\d{2}-\d{2}$/.test(payload.weddingDate) ? payload.weddingDate : '';

  const people = Array.isArray(sample.people) ? sample.people : [];
  const sampleBride = sample.brideName || people.find((p) => /^bride$/i.test(p?.role || ''))?.name || '';
  const sampleGroom = sample.groomName || people.find((p) => /^groom$/i.test(p?.role || ''))?.name || '';
  // A sample name inside other sample text ("Priya & Arjun's big day") is
  // swapped for the visitor's. Longest first, so "Priya" cannot eat into
  // "Priyanka" when both are sample names.
  const swaps = [[sampleBride, bride], [sampleGroom, groom]]
    .filter(([from]) => from && from.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  const swapNames = (text) => swaps.reduce((out, [from, to]) => replaceAll(out, from, to), text);

  let customFields = sample.customFields;
  if (typeof customFields === 'string') {
    try { customFields = JSON.parse(customFields); } catch { customFields = []; }
  }
  const OVERRIDES = {
    bride_name: bride,
    groom_name: groom,
    wedding_date: weddingDate,
    wedding_date_raw: weddingDate,
    venue_name: venue,
    venue_address: city,
    city,
  };
  customFields = (Array.isArray(customFields) ? customFields : []).map((row) => {
    const key = row?.key ?? row?.fieldKey;
    const valueKey = row && 'fieldValue' in row && !('value' in row) ? 'fieldValue' : 'value';
    const current = row?.[valueKey];
    const next = Object.prototype.hasOwnProperty.call(OVERRIDES, key) ? OVERRIDES[key] : swapNames(current);
    return { ...row, [valueKey]: next };
  });

  const hashtagNames = (text) => swaps.reduce((out, [from, to]) => replaceAll(out, from.replace(/\s+/g, ''), to.replace(/\s+/g, '')), text);

  const venueMapUrl = mapSearchUrl(venue, city);
  const samplesByName = new Map((sample.functions || []).map((fn) => [String(fn?.name || '').trim().toLowerCase(), fn]));
  const functions = sortCeremonies(payload.ceremonies)
    .map((ceremony, sortOrder) => {
      const match = samplesByName.get(ceremony.name.toLowerCase());
      return {
        name: inertText(ceremony.name),
        date: ceremony.date,
        time: ceremony.time ? toDisplayTime(ceremony.time) : (match?.time || ''),
        venueName: venue,
        // A sample address or map pin would put the visitor's wedding in
        // someone else's city.
        venueAddress: city,
        venueMapUrl,
        dressCode: match?.dressCode || '',
        sortOrder,
      };
    });

  return {
    ...sample,
    brideName: bride,
    groomName: groom,
    weddingDate,
    venueName: venue,
    venueAddress: city,
    people: people.map((person) => {
      if (/^bride$/i.test(person?.role || '')) return { ...person, name: bride };
      if (/^groom$/i.test(person?.role || '')) return { ...person, name: groom };
      return person;
    }),
    customFields,
    instagramHashtag: hashtagNames(sample.instagramHashtag),
    functions,
  };
}

/**
 * The demo behind a checkout, if it may prefill this purchase.
 *
 * Only a demo of the same design whose details still exist: a token for
 * another design, or one past its data expiry, is ignored rather than refused —
 * checkout must never fail because of a demo.
 */
async function trialIdForOrder(token, templateId, now = new Date()) {
  if (!TOKEN_RE.test(String(token || '')) || !templateId) return null;
  const trial = await prisma.trialDemo.findUnique({
    where: { token },
    select: { id: true, templateId: true, dataExpiresAt: true },
  });
  if (!trial || trial.templateId !== templateId || new Date(trial.dataExpiresAt) <= now) return null;
  return trial.id;
}

/**
 * Fills a newly registered event with the couple, venue and ceremonies from the
 * demo that led to the purchase, then erases the demo.
 *
 * Writes what the dashboard itself writes (EventPerson, Venue, Function with a
 * builder-style start time) and leaves the names unconfirmed, so the couple
 * checks them in step 1 like anything else they typed. It only ever fills an
 * event that is completely empty, for the same design.
 *
 * Values go in made inert, as on /try: a demo token can be put into someone
 * else's checkout link, and this text ends up on that person's live invitation,
 * which renders unescaped.
 *
 * One transaction, and never throws: returns false and the registration goes
 * ahead with an empty event, exactly as before this existed.
 */
async function applyTrialPrefill(eventId, trialDemoId, now = new Date()) {
  if (!eventId || !trialDemoId) return false;
  try {
    // Lazy: the dashboard controller is only needed on this path.
    const { syncEventExpiry } = require('../controllers/userDashboard.controller');
    return await prisma.$transaction(async (tx) => {
      const trial = await tx.trialDemo.findUnique({ where: { id: trialDemoId } });
      if (!trial || new Date(trial.dataExpiresAt) <= now) return false;

      const event = await tx.event.findUnique({
        where: { id: eventId },
        select: {
          templateId: true,
          namesAreFrozen: true,
          _count: { select: { people: true, functions: true, venues: true } },
        },
      });
      const empty = Boolean(event) && !event.namesAreFrozen
        && event._count.people === 0 && event._count.functions === 0 && event._count.venues === 0;
      if (!empty || event.templateId !== trial.templateId) return false;

      const payload = trial.payload && typeof trial.payload === 'object' ? trial.payload : {};
      const bride = inertText(payload.brideName);
      const groom = inertText(payload.groomName);
      const venueName = inertText(payload.venueName);
      const city = inertText(payload.city);
      const ceremonies = sortCeremonies(payload.ceremonies)
        .filter((c) => parseDateOnly(c.date) && TRIAL_CEREMONIES.includes(c.name));
      if (!bride || !groom || !venueName || ceremonies.length === 0) return false;

      await tx.eventPerson.createMany({
        data: [
          { eventId, role: 'bride', name: bride, sortOrder: 0 },
          { eventId, role: 'groom', name: groom, sortOrder: 1 },
        ],
      });
      const mapUrl = mapSearchUrl(venueName, city) || null;
      const venue = await tx.venue.create({
        data: { eventId, name: venueName, address: city || null, city: city || null, mapUrl },
        select: { id: true },
      });
      await tx.function.createMany({
        data: ceremonies.map((c, sortOrder) => ({
          eventId,
          name: c.name,
          // As addFunction stores a date-input value: midnight UTC of that day.
          date: new Date(c.date),
          startTime: c.time ? toDisplayTime(c.time) || null : null,
          venueId: venue.id,
          venueName,
          venueAddress: city || null,
          venueMapUrl: mapUrl,
          sortOrder,
        })),
      });
      await syncEventExpiry(eventId, tx);
      // The details now live in the couple's own event; the demo copy goes.
      await tx.trialDemo.delete({ where: { id: trial.id } });
      return true;
    });
  } catch (error) {
    console.error('[trial-demo] prefill failed:', error.message);
    return false;
  }
}

module.exports = {
  TrialDemoError,
  TRIAL_CEREMONIES,
  LINK_MINUTES,
  DATA_HOURS,
  DAILY_CAP,
  PER_IP_HOURLY_CAP,
  MIN_FILL_SECONDS,
  validateTrialPayload,
  createTrialDemo,
  purgeExpiredTrialDemos,
  hashIp,
  findTrialForRender,
  overlayTrialOnDemoData,
  canTryWithNames,
  TRY_ELIGIBILITY_SELECT,
  trialIdForOrder,
  applyTrialPrefill,
  inertText,
  toDisplayTime,
};
