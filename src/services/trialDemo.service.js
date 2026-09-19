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
 *
 * ANY DESIGN, NOT ONLY WEDDINGS. What the form asks for is worked out from each
 * design's own data (`trialOptionsFor`): the people its schema declares, the
 * events its demo carries, and what to call the date. A birthday design asks for
 * the person whose birthday it is; a housewarming for the family. Nothing here
 * names an occasion, so a design added next month is covered the day it ships.
 * The renderer was already generic — it turns every role into `{{role_name}}`.
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
 * The wedding ceremonies, offered together.
 *
 * A wedding design's demo usually carries only some of them, but a couple
 * trying it may be planning any, so when a design's own events include one of
 * these the whole set is offered — which is what every wedding design offered
 * before this was generalised.
 *
 * This used to be the allowlist of every name a visitor could choose. It no
 * longer needs to be: the choices now come from the design's own demo events
 * and occasions, which an admin wrote and /demo already renders. A visitor still
 * never types an event name — they pick from what the server offered for that
 * design, and the server checks the pick against that same list.
 */
const WEDDING_CEREMONIES = ['Roka', 'Engagement', 'Haldi', 'Mehendi', 'Sangeet', 'Nikah', 'Wedding', 'Reception'];
const WEDDING_SET = new Set(WEDDING_CEREMONIES.map((name) => name.toLowerCase()));

/** Names the form asks for. The principals only, and never more than this. */
const MAX_TRIAL_PEOPLE = 3;
/** Events a design may offer. */
const MAX_OFFERED_CEREMONIES = 10;
const MAX_CEREMONY_NAME = 60;
/** A role key as the builder and the renderer use it: "bride", "birthday_person". */
const ROLE_RE = /^[a-z][a-z0-9_]{0,40}$/;

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

/** "birthday_person" → "Birthday person". */
function humanizeRole(role) {
  const words = String(role || '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** A JSON column that may arrive as a string or already parsed. */
function parseList(value) {
  let out = value;
  if (typeof out === 'string') {
    try { out = JSON.parse(out); } catch { return []; }
  }
  return Array.isArray(out) ? out : [];
}

/** The published schema, else the draft — the same source the product page reads. */
function schemaOf(template) {
  return parseFieldSchema(template.currentVersion
    ? (template.currentVersion.fieldSchema ?? template.fieldSchema)
    : template.fieldSchema);
}

/**
 * The names a demo of this design asks for.
 *
 * The principals only. Roles follow the builder's prefix convention —
 * "bride_father" belongs to "bride" — so a principal is a role no other declared
 * role is a prefix of. A wedding asks for the bride and the groom; a birthday for
 * the person whose birthday it is. Parents and other family keep their sample
 * names, as they always have: a demo is for seeing the design with your own
 * names on it, not for filling in the whole invitation.
 *
 * Read from the schema; failing that, the demo's own people; failing that, the
 * sample couple some old designs carry with no people list at all. Where the
 * schema marks which names are required, that decides; where nothing is marked,
 * every name asked for is needed.
 */
function trialPeopleFor(template) {
  const schema = schemaOf(template);
  const declared = schema && Array.isArray(schema.people) ? schema.people : [];
  const source = declared.length ? declared : parseList(template.demoData?.people);

  const seen = new Set();
  const entries = [];
  for (const person of source) {
    const role = String(person?.role || '').trim().toLowerCase();
    if (!ROLE_RE.test(role) || seen.has(role)) continue;
    seen.add(role);
    entries.push({
      role,
      label: (text(declared.length ? person.label : '') || humanizeRole(role)).slice(0, 60),
      required: declared.length ? Boolean(person.required) : null,
    });
  }
  const roles = entries.map((entry) => entry.role);
  let people = entries
    .filter((entry) => !roles.some((other) => other !== entry.role && entry.role.startsWith(`${other}_`)))
    .slice(0, MAX_TRIAL_PEOPLE);

  if (!people.length && text(template.demoData?.brideName) && text(template.demoData?.groomName)) {
    people = [{ role: 'bride', label: 'Bride', required: true }, { role: 'groom', label: 'Groom', required: true }];
  }
  if (!people.some((person) => person.required === true)) {
    people = people.map((person) => ({ ...person, required: true }));
  }
  return people.map((person) => ({ role: person.role, label: person.label, required: person.required === true }));
}

/**
 * The events a demo of this design offers, in the order to show them.
 *
 * The design's own demo events first — an admin wrote them and /demo already
 * shows them — else its occasions. A wedding design gets the whole wedding set,
 * as before. A design with neither still offers one event, so it can be tried.
 */
function trialCeremoniesFor(template) {
  const names = [];
  const add = (value) => {
    const name = text(value);
    if (!name || name.length > MAX_CEREMONY_NAME) return;
    if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) return;
    names.push(name);
  };
  const functions = Array.isArray(template.demoData?.functions) ? template.demoData.functions : [];
  functions.forEach((fn) => add(fn?.name));
  if (!names.length) String(template.bestFor || '').split(',').forEach(add);

  if (names.some((name) => WEDDING_SET.has(name.toLowerCase()))) {
    const others = names.filter((name) => !WEDDING_SET.has(name.toLowerCase()));
    return [...WEDDING_CEREMONIES, ...others].slice(0, MAX_OFFERED_CEREMONIES);
  }
  if (!names.length) add('Celebration');
  return names.slice(0, MAX_OFFERED_CEREMONIES);
}

/**
 * Everything the form for this design may ask, or null when it cannot be tried.
 *
 * The single source for the form, the validator and the eligibility check, so
 * the three can never disagree about what a design accepts.
 */
function trialOptionsFor(template) {
  if (!template || !template.demoData) return null;
  const people = trialPeopleFor(template);
  if (!people.length) return null;
  const ceremonies = trialCeremoniesFor(template);
  const wedding = ceremonies.some((name) => WEDDING_SET.has(name.toLowerCase()));
  return {
    people,
    ceremonies,
    dateLabel: wedding ? 'Wedding date' : 'Date of the celebration',
  };
}

/**
 * A stored or submitted payload in the current shape.
 *
 * Demos created before this change, and a browser still running the old form
 * during a deploy, send a bride, a groom and a wedding date. Those become two
 * people and an event date, so an old link keeps rendering and an old purchase
 * keeps prefilling for the 24 hours its data lives.
 */
function normalizeTrialPayload(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const listed = Array.isArray(input.people)
    ? input.people
    : [['bride', input.brideName], ['groom', input.groomName]].map(([role, name]) => ({ role, name }));
  return {
    ...input,
    people: listed
      .map((person) => ({ role: String(person?.role || '').trim().toLowerCase(), name: text(person?.name) }))
      .filter((person) => ROLE_RE.test(person.role) && person.name),
    eventDate: text(input.eventDate || input.weddingDate),
  };
}

/**
 * The visitor's details, checked field by field against what this design
 * offered (`trialOptionsFor`).
 *
 * Returns the cleaned payload. Throws TrialDemoError with the field that failed,
 * so the form can point at it rather than saying "invalid". A name field is
 * reported as `people.<role>`.
 */
function validateTrialPayload(input, { now = new Date(), options } = {}) {
  const body = input && typeof input === 'object' ? input : {};

  // Bots fill every field, including the one no human can see.
  if (text(body.website) !== '') throw new TrialDemoError('This request looks automated.', 'website');

  const startedAt = Number(body.startedAt);
  if (Number.isFinite(startedAt) && startedAt > 0) {
    const seconds = (now.getTime() - startedAt) / 1000;
    if (seconds < MIN_FILL_SECONDS) throw new TrialDemoError('That was too quick — please try again.', 'startedAt');
  }

  if (!options || !Array.isArray(options.people) || !options.people.length) {
    throw new TrialDemoError('That design cannot be previewed yet.', 'slug');
  }

  const given = normalizeTrialPayload(body);
  const byRole = new Map(given.people.map((person) => [person.role, person.name]));
  const people = [];
  for (const def of options.people) {
    const field = `people.${def.role}`;
    const value = text(byRole.get(def.role));
    if (!value) {
      if (def.required) throw new TrialDemoError(`Please fill in “${def.label}”.`, field);
      continue;
    }
    if (value.length > MAX_NAME || !NAME_RE.test(value)) {
      throw new TrialDemoError('Please use letters only, up to 60 characters.', field);
    }
    people.push({ role: def.role, name: value });
  }
  if (!people.length) throw new TrialDemoError('Please enter a name.', `people.${options.people[0].role}`);

  const eventDate = parseDateOnly(given.eventDate);
  if (!eventDate) throw new TrialDemoError('Please choose the date.', 'eventDate');
  const today = startOfDay(now);
  const latest = new Date(today);
  latest.setFullYear(latest.getFullYear() + WEDDING_MAX_YEARS_AHEAD);
  if (eventDate < today) throw new TrialDemoError('That date is in the past.', 'eventDate');
  if (eventDate > latest) throw new TrialDemoError('Please choose a date within the next three years.', 'eventDate');

  const venueName = text(body.venueName);
  if (!venueName) throw new TrialDemoError('Please enter the venue.', 'venueName');
  if (venueName.length > MAX_VENUE || !VENUE_RE.test(venueName)) {
    throw new TrialDemoError('Please enter a shorter venue name, without symbols.', 'venueName');
  }

  const city = text(body.city);
  if (city && (city.length > MAX_CITY || !CITY_RE.test(city))) {
    throw new TrialDemoError('Please enter a shorter city name, without symbols.', 'city');
  }

  const offered = new Map(options.ceremonies.map((name) => [name.toLowerCase(), name]));
  const rawCeremonies = Array.isArray(body.ceremonies) ? body.ceremonies : [];
  if (rawCeremonies.length === 0) throw new TrialDemoError('Please choose at least one event.', 'ceremonies');
  if (rawCeremonies.length > MAX_CEREMONIES) {
    throw new TrialDemoError(`Please choose up to ${MAX_CEREMONIES} events.`, 'ceremonies');
  }

  const earliest = new Date(eventDate.getTime() - CEREMONY_DAYS_BEFORE * DAY_MS);
  const last = new Date(eventDate.getTime() + CEREMONY_DAYS_AFTER * DAY_MS);
  const seen = new Set();
  const ceremonies = rawCeremonies.map((entry) => {
    const item = entry && typeof entry === 'object' ? entry : {};
    // The design's own spelling, never the visitor's.
    const name = offered.get(text(item.name).toLowerCase());
    if (!name) throw new TrialDemoError('Please choose events from the list.', 'ceremonies');
    if (seen.has(name)) throw new TrialDemoError('Each event can only be added once.', 'ceremonies');
    seen.add(name);

    const date = parseDateOnly(text(item.date));
    if (!date) throw new TrialDemoError(`Please choose a date for the ${name}.`, 'ceremonies');
    if (date < earliest || date > last) {
      throw new TrialDemoError(`The ${name} date is too far from the main date.`, 'ceremonies');
    }

    // Optional, and free text is not allowed: a time is hh:mm or nothing.
    const time = text(item.time);
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new TrialDemoError(`Please enter the ${name} time as hh:mm.`, 'ceremonies');
    }
    return { name, date: text(item.date), ...(time ? { time } : {}) };
  });

  return {
    people,
    eventDate: given.eventDate,
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

/**
 * The Prisma select `trialOptionsFor` needs. Internal fields: callers must load
 * it separately from anything they spread into a response.
 */
const TRY_ELIGIBILITY_SELECT = {
  bestFor: true,
  fieldSchema: true,
  currentVersion: { select: { fieldSchema: true } },
  demoData: {
    select: {
      id: true,
      brideName: true,
      groomName: true,
      people: true,
      functions: { select: { name: true }, orderBy: { sortOrder: 'asc' } },
    },
  },
};

/**
 * Whether a design can be tried with a visitor's own names: it has demo data to
 * render into, and at least one person to put a name on. Every current design
 * qualifies, whatever the occasion, and so will the next one.
 */
function canTryTemplate(template) {
  return trialOptionsFor(template) !== null;
}

/**
 * Creates the demo row and returns the link to open it.
 *
 * Throws TrialDemoError when the template cannot be demoed or a cap is reached;
 * the route turns that into a 400 or 429 with the message.
 */
async function createTrialDemo({ slug, body, ip, storefront, now = new Date() }) {
  const template = await prisma.template.findFirst({
    where: { slug: String(slug || ''), isActive: true, ...EXCLUDE_SANDBOX_TEMPLATE },
    select: { id: true, slug: true, ...TRY_ELIGIBILITY_SELECT },
  });
  if (!template) throw new TrialDemoError('That design is not available.', 'slug');
  // A template with no demo data has nothing to render the visitor's names into.
  if (!template.demoData) throw new TrialDemoError('That design cannot be previewed yet.', 'slug');
  // Enforced here too, not only by hiding the button: the API is public.
  const options = trialOptionsFor(template);
  if (!options) throw new TrialDemoError('That design cannot be previewed yet.', 'slug');
  const payload = validateTrialPayload(body, { now, options });

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
 * sample name left in either would silently replace the visitor's.
 *
 * Works on any role: whatever the visitor named becomes that person in
 * `people[]` and `{{role_name}}` in the custom fields. `bride` and `groom` also
 * fill the top-level couple fields older wedding templates read.
 *
 * Kept from the sample: photos, music, parents and other family, links, the
 * hashtag's shape, and each event's dress code (and its time, when the visitor
 * gave none). Replaced: the people named, the date, the venue, and the events.
 */
function overlayTrialOnDemoData(demoData, rawPayload) {
  const sample = demoData || {};
  const payload = normalizeTrialPayload(rawPayload);
  const named = payload.people.map((person) => ({ role: person.role, name: inertText(person.name) })).filter((p) => p.name);
  const nameFor = (role) => named.find((person) => person.role === role)?.name || '';
  const venue = inertText(payload.venueName);
  const city = inertText(payload.city);
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(payload.eventDate) ? payload.eventDate : '';

  const people = Array.isArray(sample.people) ? sample.people : parseList(sample.people);
  const sampleNameFor = (role) => {
    const found = people.find((person) => String(person?.role || '').trim().toLowerCase() === role)?.name;
    if (found) return found;
    if (role === 'bride') return sample.brideName || '';
    if (role === 'groom') return sample.groomName || '';
    return '';
  };
  // A sample name inside other sample text ("Priya & Arjun's big day") is
  // swapped for the visitor's. Longest first, so "Priya" cannot eat into
  // "Priyanka" when both are sample names.
  const swaps = named
    .map((person) => [sampleNameFor(person.role), person.name])
    .filter(([from]) => from && from.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  const swapNames = (value) => swaps.reduce((out, [from, to]) => replaceAll(out, from, to), value);

  let customFields = sample.customFields;
  if (typeof customFields === 'string') {
    try { customFields = JSON.parse(customFields); } catch { customFields = []; }
  }
  const OVERRIDES = {
    wedding_date: eventDate,
    wedding_date_raw: eventDate,
    event_date: eventDate,
    event_date_raw: eventDate,
    venue_name: venue,
    venue_address: city,
    city,
  };
  for (const person of named) OVERRIDES[`${person.role}_name`] = person.name;
  customFields = (Array.isArray(customFields) ? customFields : []).map((row) => {
    const key = row?.key ?? row?.fieldKey;
    const valueKey = row && 'fieldValue' in row && !('value' in row) ? 'fieldValue' : 'value';
    const current = row?.[valueKey];
    const next = Object.prototype.hasOwnProperty.call(OVERRIDES, key) ? OVERRIDES[key] : swapNames(current);
    return { ...row, [valueKey]: next };
  });

  const hashtagNames = (value) => swaps.reduce((out, [from, to]) => replaceAll(out, from.replace(/\s+/g, ''), to.replace(/\s+/g, '')), value);

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
        // A sample address or map pin would put the visitor's event in
        // someone else's city.
        venueAddress: city,
        venueMapUrl,
        dressCode: match?.dressCode || '',
        sortOrder,
      };
    });

  // Named people take their role's place; a role the sample never had is added.
  const present = new Set(people.map((person) => String(person?.role || '').trim().toLowerCase()));
  const nextPeople = people
    .map((person) => {
      const name = nameFor(String(person?.role || '').trim().toLowerCase());
      return name ? { ...person, name } : person;
    })
    .concat(named.filter((person) => !present.has(person.role)).map((person) => ({ role: person.role, name: person.name })));

  return {
    ...sample,
    brideName: nameFor('bride') || sample.brideName,
    groomName: nameFor('groom') || sample.groomName,
    weddingDate: eventDate,
    venueName: venue,
    venueAddress: city,
    people: nextPeople,
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

      const payload = normalizeTrialPayload(trial.payload);
      const named = payload.people
        .map((person) => ({ role: person.role, name: inertText(person.name) }))
        .filter((person) => person.name && person.name.length <= MAX_NAME);
      const venueName = inertText(payload.venueName);
      const city = inertText(payload.city);
      // Names were checked against the design's own list when the demo was made;
      // here they only have to be plausible, and inert.
      const ceremonies = sortCeremonies(payload.ceremonies)
        .filter((c) => parseDateOnly(c.date) && inertText(c.name) && inertText(c.name).length <= MAX_CEREMONY_NAME);
      if (!named.length || !venueName || ceremonies.length === 0) return false;

      // The same roles the design declares, so the builder shows them in the
      // right fields — unconfirmed, for the couple to check at step 1.
      await tx.eventPerson.createMany({
        data: named.map((person, sortOrder) => ({ eventId, role: person.role, name: person.name, sortOrder })),
      });
      const mapUrl = mapSearchUrl(venueName, city) || null;
      const venue = await tx.venue.create({
        data: { eventId, name: venueName, address: city || null, city: city || null, mapUrl },
        select: { id: true },
      });
      await tx.function.createMany({
        data: ceremonies.map((c, sortOrder) => ({
          eventId,
          name: inertText(c.name),
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
  WEDDING_CEREMONIES,
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
  canTryTemplate,
  trialOptionsFor,
  normalizeTrialPayload,
  TRY_ELIGIBILITY_SELECT,
  trialIdForOrder,
  applyTrialPrefill,
  inertText,
  toDisplayTime,
};
