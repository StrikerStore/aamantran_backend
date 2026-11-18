/**
 * Test-invitation data from a JSON file: the admin Testing page's
 * "Download JSON template" and "Upload JSON" buttons.
 *
 * The file uses the template's demo-data shape (people, functions, custom
 * fields, media, links). `buildSampleData` writes a template's own demo data
 * out in that shape, with every role, key and slot its schema declares, so the
 * admin edits values instead of guessing keys. `parseEventData` checks a file
 * without touching the database, and `applyEventData` writes it.
 *
 * Each section present in the file replaces that part of the invitation, and a
 * section left out is kept. Blank names, values and links are skipped, so an
 * unedited template file only fills what the demo data had.
 *
 * Only the test account's event is written; the controller resolves it.
 */
const prisma = require('../utils/prisma');
const objectStorage = require('./objectStorage');
const { isTestEventUpload } = require('./testAccount.service');
const { getMediaSlots, findSlot, mediaTypeForSlot, inferTypeFromFilename } = require('./mediaSlotUtils');
const {
  parseSchema, legacySlotMapFor, toPersonKey, parseRoleOptions, matchRoleOption,
} = require('../utils/personSlots');
const { parseFlexibleDateInputToYyyyMmDd, getDateCustomFieldKeysFromSchema } = require('../utils/dateNormalize');
const { normalizeOptionalHttpUrl, normalizeOptionalHashtag } = require('../utils/urlNormalize');
const { parseGoogleMapsLocation } = require('../utils/mapsParse');

/** Prisma's default String column on MySQL: VARCHAR(191). */
const VARCHAR = 191;
/** A TEXT column holds 65,535 bytes. */
const TEXT_BYTES = 65535;
const KEY_RE = /^[A-Za-z0-9_]+$/;
const MAX_PEOPLE = 50;
const MAX_FUNCTIONS = 30;
const MAX_CUSTOM_FIELDS = 200;

const LINK_KEYS = ['instagramUrl', 'socialYoutubeUrl', 'websiteUrl'];
const TOGGLE_KEYS = ['rsvpEnabled', 'guestNotesEnabled'];
const SECTION_KEYS = [
  'language', 'people', 'functions', 'customFields', 'media',
  ...LINK_KEYS, 'instagramHashtag', ...TOGGLE_KEYS,
];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function asList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/* ── Download: the template's demo data as a file ─────────────────────────── */

/**
 * @param {object} template  Template row with `demoData` (and its `functions`) included.
 * @param {unknown} [fieldSchema]  The schema the invite renders with; defaults to the template's.
 * @returns {object} The JSON template, ready to stringify.
 */
function buildSampleData(template, fieldSchema = template.fieldSchema) {
  const schema = parseSchema(fieldSchema) || {};
  const legacyMap = legacySlotMapFor(fieldSchema);
  const demo = template.demoData || {};

  // ── People: every declared role, with the demo name where there is one ──
  const demoPeople = asList(demo.people).filter(isPlainObject);
  const demoByRole = new Map(demoPeople.map((p) => [toPersonKey(String(p.role || ''), legacyMap), p]));
  const people = [];
  const placed = new Set();
  const pushPerson = (role, def) => {
    if (!role || placed.has(role)) return;
    placed.add(role);
    const d = demoByRole.get(role) || {};
    const row = { role, name: String(d.name || ''), photo_url: String(d.photo_url || d.photoUrl || '') };
    if (parseRoleOptions(def?.roleOptions).length) row.role_choice = String(d.role_choice || '');
    people.push(row);
  };
  const declaredPeople = asList(schema.people).filter((p) => p && p.role);
  for (const def of declaredPeople) pushPerson(toPersonKey(String(def.role).trim().toLowerCase(), legacyMap), def);
  for (const [role] of demoByRole) pushPerson(role, null);
  if (!people.length) {
    // A template with no people schema: the two names its demo data carries.
    people.push({ role: 'person1', name: String(demo.person1Name || ''), photo_url: '' });
    people.push({ role: 'person2', name: String(demo.person2Name || ''), photo_url: '' });
  }

  // ── Functions: the demo's, in order; one placeholder when it has none ──
  const demoFunctions = asList(demo.functions)
    .filter(isPlainObject)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const functions = demoFunctions.map((fn) => ({
    name:         String(fn.name || ''),
    date:         parseFlexibleDateInputToYyyyMmDd(fn.date) || String(fn.date || ''),
    time:         String(fn.time || ''),
    venueName:    String(fn.venueName || ''),
    venueAddress: String(fn.venueAddress || ''),
    venueMapUrl:  String(fn.venueMapUrl || ''),
    dressCode:    String(fn.dressCode || ''),
    notes:        String(fn.notes || ''),
  }));
  if (!functions.length) {
    functions.push({
      name: 'Wedding',
      date: parseFlexibleDateInputToYyyyMmDd(addDays(new Date(), 60)),
      time: '7:00 PM',
      venueName: '', venueAddress: '', venueMapUrl: '', dressCode: '', notes: '',
    });
  }

  // ── Custom fields: every declared key, then any extra demo keys ──
  let demoCf = demo.customFields;
  if (typeof demoCf === 'string') {
    try { demoCf = JSON.parse(demoCf); } catch { demoCf = []; }
  }
  const demoCfMap = new Map(
    asList(demoCf).filter(isPlainObject)
      .map((cf) => [String(cf.key ?? cf.fieldKey ?? ''), cf.value ?? cf.fieldValue ?? ''])
      .filter(([k]) => k),
  );
  const customFields = {};
  for (const def of asList(schema.customFields)) {
    const key = String(def?.key || '').trim();
    if (key && !(key in customFields)) customFields[key] = demoCfMap.has(key) ? demoCfMap.get(key) : '';
  }
  for (const [key, value] of demoCfMap) if (!(key in customFields)) customFields[key] = value;

  // ── Media: every declared slot, with the demo files ──
  const demoMedia = isPlainObject(demo.mediaSlotDemoUrls) ? demo.mediaSlotDemoUrls : {};
  const media = {};
  for (const slot of getMediaSlots(fieldSchema) || []) {
    media[slot.key] = asList(demoMedia[slot.key]).map(String).filter(Boolean);
  }
  for (const [key, urls] of Object.entries(demoMedia)) {
    if (!(key in media)) media[key] = asList(urls).map(String).filter(Boolean);
  }

  const languages = String(template.languages || 'en').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    _about: `Test data for "${template.name}". Edit the values, then upload this file on the admin `
      + 'Testing page. Each section in the file replaces that part of the test invitation; delete a '
      + 'section to leave it as it is. Blank names, values and links are skipped.',
    language:          demo.language || languages[0] || 'en',
    people,
    functions,
    customFields,
    media,
    instagramUrl:      demo.instagramUrl || '',
    instagramHashtag:  demo.instagramHashtag || '',
    socialYoutubeUrl:  demo.socialYoutubeUrl || '',
    websiteUrl:        demo.websiteUrl || '',
    rsvpEnabled:       demo.rsvpEnabled !== false,
    guestNotesEnabled: demo.guestNotesEnabled !== false,
  };
}

/* ── Upload: check a file ─────────────────────────────────────────────────── */

/**
 * @param {unknown} input  The parsed JSON file.
 * @param {{ fieldSchema?: unknown, languages?: string }} template
 * @returns {{ errors: string[], warnings: string[], plan: object }}
 *   `plan` holds only the sections the file sets; nothing is written when
 *   `errors` is non-empty.
 */
function parseEventData(input, { fieldSchema, languages } = {}) {
  const errors = [];
  const warnings = [];
  const plan = { event: {} };

  if (!isPlainObject(input)) {
    return { errors: ['The file must be a JSON object, like the downloaded JSON template'], warnings, plan };
  }

  const schema = parseSchema(fieldSchema) || {};
  const legacyMap = legacySlotMapFor(fieldSchema);

  /** Text for a column: trimmed, '' when absent, an error when too long or not text. */
  const text = (value, at, { max = VARCHAR, bytes = false } = {}) => {
    if (value == null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    if (typeof value !== 'string') {
      errors.push(`${at} must be text`);
      return '';
    }
    const s = value.trim();
    if (bytes ? Buffer.byteLength(s, 'utf8') > max : s.length > max) {
      errors.push(`${at} is too long (max ${bytes ? `${Math.floor(max / 1024)} KB` : `${max} characters`})`);
      return '';
    }
    return s;
  };

  /** A file link the invite can load: http(s), or a path on this site. */
  const fileUrl = (value, at) => {
    const s = text(value, at);
    if (!s) return '';
    if (/^\/(?!\/)/.test(s)) return s;
    if (/^https?:\/\//i.test(s)) {
      try {
        new URL(s); // eslint-disable-line no-new
        return s;
      } catch { /* falls through to the error */ }
    }
    errors.push(`${at} must be an https:// link or a /path on this site`);
    return '';
  };

  const unknown = Object.keys(input).filter((k) => !k.startsWith('_') && !SECTION_KEYS.includes(k));
  if (unknown.length) {
    warnings.push(`Ignored ${unknown.map((k) => `"${k}"`).join(', ')}: not something this file can set`);
  }
  if (!SECTION_KEYS.some((k) => k in input)) {
    errors.push('The file has none of the sections this page can fill. Download the JSON template to see the format.');
    return { errors, warnings, plan };
  }

  // ── Language ──
  if ('language' in input) {
    const lang = text(input.language, 'language', { max: 16 }).toLowerCase();
    if (lang) {
      plan.event.language = lang;
      const offered = String(languages || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (offered.length && !offered.includes(lang)) {
        warnings.push(`language "${lang}" is not one this template offers (${offered.join(', ')}); saved anyway`);
      }
    }
  }

  // ── People ──
  if ('people' in input) {
    const rows = input.people;
    if (!Array.isArray(rows)) {
      errors.push('people must be a list');
    } else if (rows.length > MAX_PEOPLE) {
      errors.push(`people has ${rows.length} entries; the limit is ${MAX_PEOPLE}`);
    } else {
      const declared = new Map(
        asList(schema.people).filter((p) => p && p.role)
          .map((p) => [toPersonKey(String(p.role).trim().toLowerCase(), legacyMap), p]),
      );
      const out = [];
      const seen = new Set();
      const undeclared = [];
      rows.forEach((row, i) => {
        const at = `people #${i + 1}`;
        if (!isPlainObject(row)) { errors.push(`${at} must be an object`); return; }
        const role = toPersonKey(text(row.role, `${at} role`).toLowerCase(), legacyMap);
        const name = text(row.name, `${at} name`);
        if (!name) return; // a blank name means no such person, as in the wizard
        if (!role) { errors.push(`${at}: role is required`); return; }
        if (!KEY_RE.test(role)) { errors.push(`${at}: role "${role}" may only use letters, numbers and _`); return; }

        const extraData = {};
        if (row.extra !== undefined) {
          if (!isPlainObject(row.extra)) {
            errors.push(`${at} (${role}): extra must be an object, like {"bio": "..."}`);
          } else {
            for (const [k, v] of Object.entries(row.extra)) {
              if (k === 'role_choice') continue; // set below, checked against the template
              if (!KEY_RE.test(k)) { errors.push(`${at} (${role}): extra key "${k}" may only use letters, numbers and _`); continue; }
              const value = text(v, `${at} (${role}) extra.${k}`, { max: 2000 });
              if (value) extraData[k] = value;
            }
          }
        }
        const choice = text(row.role_choice ?? row.roleChoice, `${at} (${role}) role_choice`, { max: 40 });
        if (choice) {
          const options = parseRoleOptions(declared.get(role)?.roleOptions);
          const match = matchRoleOption(options, choice);
          if (match) extraData.role_choice = match;
          else if (options.length) errors.push(`${at} (${role}): role_choice "${choice}" must be one of ${options.join(', ')}`);
          else errors.push(`${at} (${role}): this template has no role choices for ${role}, so leave role_choice empty`);
        }

        if (seen.has(role)) warnings.push(`people: ${role} is listed more than once; the invite shows the last one`);
        seen.add(role);
        if (declared.size && !declared.has(role)) undeclared.push(role);

        out.push({
          role,
          name,
          photoUrl:  fileUrl(row.photo_url ?? row.photoUrl, `${at} (${role}) photo_url`) || null,
          extraData: Object.keys(extraData).length ? extraData : null,
          sortOrder: out.length,
        });
      });
      if (undeclared.length) {
        warnings.push(`people: ${[...new Set(undeclared)].join(', ')} ${undeclared.length === 1 ? 'is not a role' : 'are not roles'} this template declares (typo?); saved anyway`);
      }
      const missing = [...declared].filter(([role, p]) => p.required && !seen.has(role)).map(([role]) => role);
      if (missing.length) warnings.push(`people: no name for ${missing.join(', ')}, which this template requires`);
      plan.people = out;

      // The Event's own name columns feed emails and admin lists.
      plan.event.person1Name = out.find((p) => p.role === 'person1')?.name || null;
      plan.event.person2Name = out.find((p) => p.role === 'person2')?.name || null;
    }
  }

  // ── Functions ──
  if ('functions' in input) {
    const rows = input.functions;
    if (!Array.isArray(rows)) {
      errors.push('functions must be a list');
    } else if (rows.length > MAX_FUNCTIONS) {
      errors.push(`functions has ${rows.length} entries; the limit is ${MAX_FUNCTIONS}`);
    } else {
      const out = [];
      rows.forEach((row, i) => {
        const at = `functions #${i + 1}`;
        if (!isPlainObject(row)) { errors.push(`${at} must be an object`); return; }
        const name = text(row.name, `${at} name`);
        const dateIn = row.date == null ? '' : row.date;
        if (!name && dateIn === '') return; // a blank row
        const label = name ? `${at} (${name})` : at;
        if (!name) errors.push(`${at}: name is required`);

        let date = null;
        if (typeof dateIn !== 'string' || !dateIn.trim()) {
          errors.push(`${label}: date is required, like "2026-12-04"`);
        } else {
          const iso = parseFlexibleDateInputToYyyyMmDd(dateIn);
          const [y, m, d] = iso.split('-').map(Number);
          const candidate = iso ? new Date(Date.UTC(y, m - 1, d)) : null;
          if (!candidate || candidate.getUTCMonth() !== m - 1 || candidate.getUTCDate() !== d) {
            errors.push(`${label}: "${dateIn}" is not a date; use YYYY-MM-DD`);
          } else {
            date = candidate;
          }
        }

        const mapUrl = text(row.venueMapUrl, `${label} venueMapUrl`, { max: 2048 });
        let venueMapUrl = null;
        let venueLat = null;
        let venueLng = null;
        if (mapUrl) {
          if (!/^https?:\/\//i.test(mapUrl)) {
            errors.push(`${label}: venueMapUrl must be an https:// link`);
          } else {
            venueMapUrl = mapUrl;
            const coords = parseGoogleMapsLocation(mapUrl);
            if (coords) { venueLat = coords.lat; venueLng = coords.lng; }
          }
        }

        out.push({
          name,
          date,
          startTime:    text(row.time ?? row.startTime, `${label} time`) || null,
          venueName:    text(row.venueName, `${label} venueName`) || null,
          venueAddress: text(row.venueAddress, `${label} venueAddress`) || null,
          venueMapUrl,
          venueLat,
          venueLng,
          dressCode:    text(row.dressCode, `${label} dressCode`) || null,
          notes:        text(row.notes, `${label} notes`, { max: TEXT_BYTES, bytes: true }) || null,
          sortOrder:    out.length,
        });
      });
      if (!out.length) warnings.push('functions: the file has none, so the invite will show no events');
      plan.functions = out;
    }
  }

  // ── Custom fields ──
  if ('customFields' in input) {
    const cf = input.customFields;
    let entries = null;
    if (Array.isArray(cf)) {
      entries = cf.map((row, i) => (isPlainObject(row)
        ? [row.key ?? row.fieldKey, row.value ?? row.fieldValue, `customFields #${i + 1}`]
        : [undefined, undefined, `customFields #${i + 1}`]));
    } else if (isPlainObject(cf)) {
      entries = Object.entries(cf).map(([k, v]) => [k, v, `customFields.${k}`]);
    } else {
      errors.push('customFields must be an object, like {"love_story": "..."}');
    }

    if (entries && entries.length > MAX_CUSTOM_FIELDS) {
      errors.push(`customFields has ${entries.length} entries; the limit is ${MAX_CUSTOM_FIELDS}`);
    } else if (entries) {
      const declared = new Map(
        asList(schema.customFields).filter((f) => f && f.key)
          .map((f) => [String(f.key).trim(), String(f.type || 'text').toLowerCase().slice(0, 32)]),
      );
      const dateKeys = getDateCustomFieldKeysFromSchema(fieldSchema);
      // The renderer reads wedding_date as a date ({{wedding_date_iso}}) even
      // when the schema doesn't declare it.
      if (!declared.has('wedding_date')) dateKeys.add('wedding_date');

      const out = new Map();
      const undeclared = [];
      for (const [rawKey, value, at] of entries) {
        const key = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (!key) { errors.push(`${at}: key is required`); continue; }
        if (!KEY_RE.test(key) || key.length > VARCHAR) {
          errors.push(`${at}: key "${key}" may only use letters, numbers and _`);
          continue;
        }
        if (value == null || value === '') continue;

        let fieldValue;
        let fieldType = declared.get(key) || 'text';
        if (typeof value === 'object') {
          fieldValue = JSON.stringify(value);
          fieldType = 'json';
        } else {
          fieldValue = String(value).trim();
        }
        if (Buffer.byteLength(fieldValue, 'utf8') > TEXT_BYTES) {
          errors.push(`${at} is too long (max 64 KB)`);
          continue;
        }
        if (dateKeys.has(key) && fieldType !== 'json') {
          const iso = parseFlexibleDateInputToYyyyMmDd(fieldValue);
          if (!iso) { errors.push(`${at}: "${fieldValue}" is not a date; use YYYY-MM-DD`); continue; }
          fieldValue = iso;
          fieldType = 'date';
        }
        if (!fieldValue) continue;
        if (declared.size && !declared.has(key) && !declared.has(toPersonKey(key, legacyMap))) undeclared.push(key);
        if (out.has(key)) warnings.push(`customFields: ${key} is listed more than once; the last value is used`);
        out.set(key, { fieldKey: key, fieldValue, fieldType });
      }
      if (undeclared.length) {
        warnings.push(`customFields: ${undeclared.join(', ')} ${undeclared.length === 1 ? 'is not a key' : 'are not keys'} this template declares (typo?); saved anyway`);
      }
      plan.customFields = [...out.values()];
    }
  }

  // ── Media ──
  if ('media' in input) {
    const media = input.media;
    if (!isPlainObject(media)) {
      errors.push('media must be an object, like {"couple_carousel": ["https://..."]}');
    } else {
      const slots = getMediaSlots(fieldSchema);
      const out = [];
      const undeclared = [];
      for (const [slotKey, value] of Object.entries(media)) {
        const at = `media.${slotKey}`;
        if (!KEY_RE.test(slotKey) || slotKey.length > VARCHAR) {
          errors.push(`${at}: slot key may only use letters, numbers and _`);
          continue;
        }
        const list = asList(value);
        const items = list.map((item, i) => {
          const itemAt = list.length > 1 ? `${at} #${i + 1}` : at;
          if (isPlainObject(item)) {
            return {
              url:     fileUrl(item.url, itemAt),
              caption: text(item.caption, `${itemAt} caption`) || null,
            };
          }
          return { url: fileUrl(item, itemAt), caption: null };
        }).filter((m) => m.url);
        if (!items.length) continue;

        const slot = findSlot(slots, slotKey);
        if (slots && !slot) undeclared.push(slotKey);
        if (slot && items.length > slot.max) {
          errors.push(`${at}: this slot takes at most ${slot.max} file${slot.max === 1 ? '' : 's'}; the file has ${items.length}`);
          continue;
        }
        items.forEach((m, i) => {
          out.push({
            slotKey,
            url:       m.url,
            caption:   m.caption,
            type:      slot ? mediaTypeForSlot(slot.type) : inferTypeFromFilename(m.url.split(/[?#]/)[0]),
            sortOrder: i,
          });
        });
      }
      if (undeclared.length) {
        warnings.push(`media: ${undeclared.join(', ')} ${undeclared.length === 1 ? 'is not a slot' : 'are not slots'} this template declares (typo?); saved anyway`);
      }
      plan.media = out;
    }
  }

  // ── Links and guest features ──
  for (const key of LINK_KEYS) {
    if (!(key in input)) continue;
    const raw = text(input[key], key, { max: 2048 });
    const url = raw ? normalizeOptionalHttpUrl(raw) : null;
    if (raw && !url) errors.push(`${key}: "${raw}" is not a valid link`);
    else plan.event[key] = url;
  }
  if ('instagramHashtag' in input) {
    plan.event.instagramHashtag = normalizeOptionalHashtag(text(input.instagramHashtag, 'instagramHashtag', { max: 200 }));
  }
  for (const key of TOGGLE_KEYS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') errors.push(`${key} must be true or false`);
    else plan.event[key] = input[key];
  }

  return { errors, warnings, plan };
}

/* ── Upload: write it ─────────────────────────────────────────────────────── */

/**
 * Write a checked plan into one event, all or nothing.
 *
 * Files the event uploaded itself (through the wizard) that the new data no
 * longer uses are deleted afterwards, the same rule purgeTestEvents follows;
 * links to anything else, like a template's demo images, are left alone.
 *
 * @param {{ eventId: string, ownerId: string, plan: object }} args
 * @returns {Promise<{ people?: number, functions?: number, customFields?: number, media?: number }>}
 *   A count for each section the plan replaced.
 */
async function applyEventData({ eventId, ownerId, plan }) {
  const applied = {};
  const outgoing = [];

  await prisma.$transaction(async (tx) => {
    if (plan.people) {
      const old = await tx.eventPerson.findMany({ where: { eventId }, select: { photoUrl: true } });
      outgoing.push(...old.map((p) => p.photoUrl));
      await tx.eventPerson.deleteMany({ where: { eventId } });
      if (plan.people.length) {
        await tx.eventPerson.createMany({
          data: plan.people.map((p) => ({ ...p, eventId, extraData: p.extraData ?? undefined })),
        });
      }
      applied.people = plan.people.length;
    }

    if (plan.functions) {
      // Each function carries its own venue fields, so the event's separate
      // Venue rows (only the wizard makes them) would be left describing
      // functions that are gone.
      await tx.function.deleteMany({ where: { eventId } });
      await tx.venue.deleteMany({ where: { eventId } });
      if (plan.functions.length) {
        await tx.function.createMany({ data: plan.functions.map((f) => ({ ...f, eventId })) });
      }
      applied.functions = plan.functions.length;
    }

    if (plan.customFields) {
      await tx.eventCustomField.deleteMany({ where: { eventId } });
      if (plan.customFields.length) {
        await tx.eventCustomField.createMany({ data: plan.customFields.map((c) => ({ ...c, eventId })) });
      }
      applied.customFields = plan.customFields.length;
    }

    if (plan.media) {
      const old = await tx.media.findMany({ where: { eventId }, select: { url: true } });
      outgoing.push(...old.map((m) => m.url));
      await tx.media.deleteMany({ where: { eventId } });
      if (plan.media.length) {
        await tx.media.createMany({ data: plan.media.map((m) => ({ ...m, eventId })) });
      }
      applied.media = plan.media.length;
    }

    if (Object.keys(plan.event).length) {
      await tx.event.update({ where: { id: eventId }, data: plan.event });
    }
    await tx.eventRenderCache.deleteMany({ where: { eventId } });
  });

  // After the commit, so a storage failure can't undo the write.
  if (outgoing.length) {
    const [media, people] = await Promise.all([
      prisma.media.findMany({ where: { eventId }, select: { url: true } }),
      prisma.eventPerson.findMany({ where: { eventId }, select: { photoUrl: true } }),
    ]);
    const kept = new Set([...media.map((m) => m.url), ...people.map((p) => p.photoUrl)]);
    for (const url of new Set(outgoing)) {
      if (url && !kept.has(url) && isTestEventUpload(url, { eventIds: [eventId], ownerId })) {
        objectStorage.tryDeletePublicUrl(url).catch(() => {});
      }
    }
  }

  return applied;
}

module.exports = { buildSampleData, parseEventData, applyEventData };
