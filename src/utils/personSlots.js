/**
 * The couple's two name slots are `person1` and `person2`.
 *
 * They used to be called `groom` and `bride`, but couples only ever saw them as
 * "Person 1" / "Person 2" — which one held the bride was never known. Every
 * role, variable and custom-field key built on a slot follows its prefix:
 * `person1_father`, `{{person2_mother_name}}`, `person1_family_line`.
 *
 * `legacySlotMap` records which old slot each one was, per template — for most
 * designs `{ person1: 'groom', person2: 'bride' }`, but a design that listed the
 * bride first has it the other way round. The renderer uses it to keep template
 * HTML that still says {{groom_name}} working until each design is re-uploaded.
 */

const SLOTS = ['person1', 'person2'];
const LEGACY_SLOTS = ['groom', 'bride'];
const DEFAULT_LEGACY_SLOT_MAP = Object.freeze({ person1: 'groom', person2: 'bride' });

function parseSchema(fieldSchema) {
  if (fieldSchema == null) return null;
  if (typeof fieldSchema === 'string') {
    try { return JSON.parse(fieldSchema); } catch { return null; }
  }
  return typeof fieldSchema === 'object' ? fieldSchema : null;
}

function isValidLegacyMap(map) {
  return Boolean(map)
    && LEGACY_SLOTS.includes(map.person1)
    && LEGACY_SLOTS.includes(map.person2)
    && map.person1 !== map.person2;
}

/**
 * Old slot → new slot for a people list still keyed groom/bride: the first of
 * the two declared becomes person1, so nothing moves on the couple's form.
 * @returns {{person1: string, person2: string}|null} null when neither is declared
 */
function deriveLegacySlotMap(peopleRows) {
  const principals = (Array.isArray(peopleRows) ? peopleRows : [])
    .map((p) => String(p?.role || '').trim().toLowerCase())
    .filter((r) => LEGACY_SLOTS.includes(r));
  if (!principals.length) return null;
  const first = principals[0];
  return { person1: first, person2: first === 'groom' ? 'bride' : 'groom' };
}

/** The template's slot map: recorded, else derived from old roles, else the default. */
function legacySlotMapFor(fieldSchema) {
  const schema = parseSchema(fieldSchema);
  if (schema && isValidLegacyMap(schema.legacySlotMap)) return schema.legacySlotMap;
  return deriveLegacySlotMap(schema?.people) || DEFAULT_LEGACY_SLOT_MAP;
}

function swapPrefix(key, from, to) {
  const k = String(key || '');
  if (k === from) return to;
  if (k.startsWith(`${from}_`)) return to + k.slice(from.length);
  return null;
}

/** `groom_father` → `person1_father` (per the map). Anything else is returned unchanged. */
function toPersonKey(key, map = DEFAULT_LEGACY_SLOT_MAP) {
  for (const slot of SLOTS) {
    const swapped = swapPrefix(key, map[slot], slot);
    if (swapped) return swapped;
  }
  return key;
}

/** `person1_father` → `groom_father` (per the map), or null when the key is not slot-based. */
function toLegacyKey(key, map = DEFAULT_LEGACY_SLOT_MAP) {
  for (const slot of SLOTS) {
    const swapped = swapPrefix(key, slot, map[slot]);
    if (swapped) return swapped;
  }
  return null;
}

/** Normalise the admin's "Groom, Bride" into a clean, de-duplicated list. */
function parseRoleOptions(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const opt = String(raw ?? '').trim().slice(0, 40);
    const key = opt.toLowerCase();
    if (!opt || seen.has(key)) continue;
    seen.add(key);
    out.push(opt);
  }
  return out;
}

/** "Bride" → "bride", "Co-host" → "co_host": the suffix of {{person1_is_<option>}}. */
function roleOptionSlug(option) {
  return String(option ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The declared option matching a choice (case-insensitive), or '' if none does. */
function matchRoleOption(options, choice) {
  const want = String(choice ?? '').trim().toLowerCase();
  if (!want) return '';
  return parseRoleOptions(options).find((o) => o.toLowerCase() === want) || '';
}

/**
 * A fieldSchema about to be saved, made consistent:
 *  - the slot map is carried over from the schema it replaces (the admin form
 *    and the Lab don't know about it, and losing it would flip the old-name
 *    aliases on designs that listed the bride first);
 *  - any groom/bride role or custom key is renamed to person1/person2;
 *  - roleOptions becomes a clean list ("Groom, Bride" → ["Groom", "Bride"]).
 */
function normalizeFieldSchema(nextSchema, previousSchema) {
  const next = parseSchema(nextSchema);
  if (!next) return nextSchema ?? null;
  const prev = parseSchema(previousSchema);
  const map = (prev && isValidLegacyMap(prev.legacySlotMap) && prev.legacySlotMap)
    || (isValidLegacyMap(next.legacySlotMap) && next.legacySlotMap)
    || deriveLegacySlotMap(next.people)
    || deriveLegacySlotMap(prev?.people)
    || DEFAULT_LEGACY_SLOT_MAP;
  const out = { ...next, legacySlotMap: { person1: map.person1, person2: map.person2 } };
  if (Array.isArray(next.people)) {
    out.people = next.people.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const row = { ...p, role: p.role ? toPersonKey(String(p.role), map) : p.role };
      const options = parseRoleOptions(p.roleOptions);
      if (options.length) row.roleOptions = options;
      else delete row.roleOptions;
      return row;
    });
  }
  if (Array.isArray(next.customFields)) {
    out.customFields = next.customFields.map((f) => (
      f && typeof f === 'object' && f.key ? { ...f, key: toPersonKey(String(f.key), map) } : f
    ));
  }
  const dashboard = normalizeDashboardSteps(next.dashboard);
  if (dashboard) out.dashboard = dashboard;
  else delete out.dashboard;
  return out;
}

/** Guest Options items a template can show its couples, in display order. */
const GUEST_OPTION_KEYS = ['instagram', 'hashtag', 'youtube', 'rsvp', 'wishes'];

/**
 * Which builder steps and items the couple sees for this template:
 *   { guestOptions: ['instagram', …], showMedia: boolean }
 * Absent (every template before this setting) means everything is shown, so
 * this returns null for anything that is not a usable block.
 */
function normalizeDashboardSteps(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  if (Array.isArray(value.guestOptions)) {
    const picked = new Set(value.guestOptions.map((k) => String(k).trim().toLowerCase()));
    out.guestOptions = GUEST_OPTION_KEYS.filter((k) => picked.has(k));
  }
  if (typeof value.showMedia === 'boolean') out.showMedia = value.showMedia;
  return Object.keys(out).length ? out : null;
}

module.exports = {
  SLOTS,
  LEGACY_SLOTS,
  DEFAULT_LEGACY_SLOT_MAP,
  parseSchema,
  deriveLegacySlotMap,
  legacySlotMapFor,
  toPersonKey,
  toLegacyKey,
  parseRoleOptions,
  roleOptionSlug,
  matchRoleOption,
  normalizeFieldSchema,
  normalizeDashboardSteps,
  GUEST_OPTION_KEYS,
};
