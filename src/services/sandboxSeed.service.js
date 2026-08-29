/**
 * Template Lab sandbox seeding.
 *
 * A developer who has just uploaded a ZIP should see a *fully populated*
 * invitation on the first open — not a skeleton with twenty blanks to fill in
 * before anything renders. This module builds that dataset.
 *
 * The interesting part is `deriveCustomFields`: the platform cannot know a
 * template's custom keys until they are declared in `fieldSchema`, so we read
 * the developer's own schema and invent a plausible value for every key they
 * declared. That is what makes `{{couple_story}}` and friends light up without
 * anyone hand-writing JSON.
 *
 * Presets mirror the empty-state checklist in guide.md §5 — one preset per row —
 * because that is where template bugs actually live: the `{{#if}}` guards, not
 * the happy path.
 */
const prisma = require('../utils/prisma');

/** Photos used when the template declares a photo slot. Public, royalty-free. */
const STOCK_PHOTOS = [
  'https://images.unsplash.com/photo-1519741497674-611481863552?w=1200&q=80',
  'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?w=1200&q=80',
  'https://images.unsplash.com/photo-1583939003579-730e3918a45a?w=1200&q=80',
  'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?w=1200&q=80',
  'https://images.unsplash.com/photo-1522673607200-164d1b6ce486?w=1200&q=80',
];

/**
 * Every role the guide documents, so a template's `{{#if_role}}` blocks all
 * resolve. Templates that use only a subset simply ignore the extras.
 */
const PEOPLE = [
  { role: 'groom',              name: 'Arjun Sharma' },
  { role: 'bride',              name: 'Meera Nair' },
  { role: 'groom_father',       name: 'Rajesh Sharma' },
  { role: 'groom_mother',       name: 'Sunita Sharma' },
  { role: 'bride_father',       name: 'Vikram Nair' },
  { role: 'bride_mother',       name: 'Latha Nair' },
  { role: 'groom_grandfather',  name: 'Mohanlal Sharma' },
  { role: 'groom_grandmother',  name: 'Kamala Sharma' },
  { role: 'bride_grandfather',  name: 'Raman Nair' },
  { role: 'bride_grandmother',  name: 'Sarojini Nair' },
];

const VENUES = [
  { name: 'Green Lawns',        address: 'MG Road, Pune 411001',   mapUrl: 'https://maps.google.com/?q=Green+Lawns+Pune' },
  { name: 'Sharma Residence',   address: 'Koregaon Park, Pune',    mapUrl: 'https://maps.google.com/?q=Koregaon+Park+Pune' },
  { name: 'Hotel Grand Palace', address: 'FC Road, Pune 411004',   mapUrl: 'https://maps.google.com/?q=Hotel+Grand+Palace+Pune' },
];

/** Base ceremony set. `many-functions` pads this out; `single-function` trims it. */
const FUNCTIONS = [
  { name: 'Mehendi', dayOffset: -2, startTime: '4:00 PM', dressCode: 'Yellow & floral',  venue: 1, notes: 'Bring your dancing shoes.' },
  { name: 'Haldi',   dayOffset: -1, startTime: '10:00 AM', dressCode: 'Marigold yellow', venue: 1, notes: '' },
  { name: 'Wedding', dayOffset:  0, startTime: '9:30 AM',  dressCode: 'Traditional',     venue: 2, notes: 'Breakfast served from 8 AM.' },
];

const EXTRA_FUNCTIONS = [
  { name: 'Roka',       dayOffset: -6, startTime: '6:00 PM', dressCode: 'Indo-western', venue: 0, notes: '' },
  { name: 'Sangeet',    dayOffset: -3, startTime: '7:00 PM', dressCode: 'Cocktail',     venue: 2, notes: '' },
  { name: 'Baraat',     dayOffset:  0, startTime: '8:00 AM', dressCode: 'Traditional',  venue: 2, notes: '' },
  { name: 'Reception',  dayOffset:  1, startTime: '7:30 PM', dressCode: 'Black tie',    venue: 2, notes: '' },
  { name: 'Vidaai',     dayOffset:  1, startTime: '11:00 PM', dressCode: '',            venue: 2, notes: '' },
];

const LINKS = {
  instagramUrl:     'https://instagram.com/aamantran.online',
  instagramHashtag: 'ArjunWedsMeera',
  socialYoutubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
  websiteUrl:       'https://www.aamantran.online',
};

/**
 * Preset scenarios — each one is a row of the guide.md §5 checklist.
 * `label` is what the Lab UI shows; `hint` explains what it proves.
 */
const PRESETS = {
  'full': {
    label: 'Everything filled',
    hint:  'The design as intended — all optional fields populated.',
  },
  'minimal': {
    label: 'Optional fields blank',
    hint:  'Custom fields, links and hashtag cleared. Nothing should leave a gap or a stray heading.',
    customFields: false, links: false,
  },
  'single-function': {
    label: 'One function',
    hint:  'Tiles must survive a single ceremony; the RSVP function list hides itself.',
    functionCount: 1,
  },
  'many-functions': {
    label: 'Eight functions',
    hint:  'Tile grid must not overflow, and the RSVP checkbox list must stay usable.',
    functionCount: 8,
  },
  'no-media': {
    label: 'No photos or music',
    hint:  'The carousel and the music button should disappear cleanly, not render empty frames.',
    media: false,
  },
  'guest-features-off': {
    label: 'RSVP + wishes off',
    hint:  'Both blocks must vanish and the page must still flow into the footer.',
    rsvpEnabled: false, guestNotesEnabled: false,
  },
  'no-date': {
    label: 'No date, no functions',
    // `Function.date` is non-nullable and the renderer falls back to the first
    // function's date, so the ONLY way {{wedding_date_iso}} comes through empty
    // is with no functions at all. Dropping just the custom field would leave
    // the countdown happily counting and prove nothing.
    hint:  'Nothing scheduled yet. Countdown and date-reveal must not print NaN, and the function grid must collapse.',
    weddingDate: false, functionCount: 0,
  },
};

function presetConfig(name) {
  const preset = PRESETS[name];
  if (!preset) {
    const err = new Error(`Unknown preset "${name}". Valid: ${Object.keys(PRESETS).join(', ')}`);
    err.status = 400;
    throw err;
  }
  return {
    customFields:      preset.customFields      !== false,
    links:             preset.links             !== false,
    media:             preset.media             !== false,
    weddingDate:       preset.weddingDate       !== false,
    rsvpEnabled:       preset.rsvpEnabled       !== false,
    guestNotesEnabled: preset.guestNotesEnabled !== false,
    functionCount:     preset.functionCount ?? FUNCTIONS.length,
  };
}

/** The wedding sits comfortably in the future so countdowns always have something to count. */
function baseWeddingDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 6);
  d.setHours(12, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toYyyyMmDd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Invent a believable value for one declared custom field.
 *
 * Keyed on `type` first, then on recognisable key names — a field called
 * `contact_phone` should look like a phone number, not lorem, or the developer
 * can't tell whether their formatting works.
 */
function sampleCustomValue(field, weddingDate) {
  const key  = String(field.key || '').toLowerCase();
  const type = String(field.type || 'text').toLowerCase();

  if (type === 'date') return toYyyyMmDd(weddingDate);
  if (type === 'number') return '2';

  if (/phone|mobile|contact_no|number/.test(key)) return '+91 98765 43210';
  if (/email/.test(key))                          return 'hello@aamantran.online';
  if (/url|link|website/.test(key))               return 'https://www.aamantran.online';
  if (/youtube|video/.test(key))                  return 'https://youtu.be/dQw4w9WgXcQ';
  if (/hashtag/.test(key))                        return 'ArjunWedsMeera';
  if (/name|person|poc|coordinator/.test(key))    return 'Rohit Sharma';
  if (/time/.test(key))                           return '7:30 PM';
  if (/dress|attire/.test(key))                   return 'Traditional Indian';

  if (type === 'textarea' || /story|about|message|note|caption|reminder|description/.test(key)) {
    return 'We met on a rainy Tuesday in Pune and never quite looked back. '
      + 'Six monsoons later we would love for you to stand beside us as we begin the next chapter.';
  }

  return 'Sample value';
}

/**
 * Read the developer's own fieldSchema and build one EventCustomField row per
 * declared key. Keys the schema does not declare are not invented — a template
 * printing an undeclared `{{key}}` *should* render blank, because that is
 * exactly what happens in production.
 */
function deriveCustomFields(fieldSchema, weddingDate) {
  const declared = Array.isArray(fieldSchema?.customFields) ? fieldSchema.customFields : [];
  const rows = [];
  const seen = new Set();

  for (const field of declared) {
    const key = String(field?.key || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      fieldKey:   key,
      fieldValue: sampleCustomValue(field, weddingDate),
      fieldType:  String(field?.type || 'text').toLowerCase() === 'date' ? 'date' : 'text',
    });
  }

  // `wedding_date` drives {{wedding_date_iso}}, which every countdown and
  // date-reveal reads. Seed it even when the schema doesn't declare it, so the
  // template's JS has a date to work with.
  if (!seen.has('wedding_date')) {
    rows.push({ fieldKey: 'wedding_date', fieldValue: toYyyyMmDd(weddingDate), fieldType: 'date' });
  }

  return rows;
}

/**
 * Photo slots the template declares, most specific first. Falls back to
 * `couple_carousel` so a template whose schema isn't filled in yet still shows
 * images rather than an empty section.
 */
function photoSlotKeys(fieldSchema) {
  const slots = Array.isArray(fieldSchema?.mediaSlots) ? fieldSchema.mediaSlots : [];
  const photoSlots = slots
    .filter((s) => String(s?.type || 'photo').toLowerCase() === 'photo')
    .map((s) => String(s.key || '').trim())
    .filter(Boolean);
  return photoSlots.length ? photoSlots : ['couple_carousel'];
}

/** The music slot the template declares, or the conventional default. */
function musicSlotKey(fieldSchema) {
  const slots = Array.isArray(fieldSchema?.mediaSlots) ? fieldSchema.mediaSlots : [];
  const found = slots.find((s) => String(s?.type || '').toLowerCase() === 'music');
  return String(found?.key || 'background_music');
}

/**
 * Build every child row for a sandbox event. The event itself must already
 * exist — the caller owns its lifecycle (delete-and-recreate on reseed).
 *
 * @param {object}  args
 * @param {string}  args.eventId
 * @param {object}  args.fieldSchema   The template's declared schema (may be null).
 * @param {string}  args.preset        Key of PRESETS.
 * @param {string} [args.musicUrl]     GlobalAsset URL chosen by the developer.
 * @returns {Promise<{ weddingDate: Date|null, counts: object }>}
 */
async function seedSandboxContent({ eventId, fieldSchema, preset = 'full', musicUrl = null }) {
  const cfg = presetConfig(preset);
  const weddingDate = baseWeddingDate();

  // ── People ──
  await prisma.eventPerson.createMany({
    data: PEOPLE.map((p, i) => ({
      eventId, role: p.role, name: p.name, photoUrl: null, sortOrder: i,
    })),
  });

  // ── Venues, then functions that point at them ──
  const venueRows = [];
  for (const v of VENUES) {
    venueRows.push(await prisma.venue.create({
      data: { eventId, name: v.name, address: v.address, mapUrl: v.mapUrl, city: 'Pune', state: 'Maharashtra' },
    }));
  }

  const wanted = [...FUNCTIONS, ...EXTRA_FUNCTIONS].slice(0, Math.max(0, cfg.functionCount));
  // `single-function` should be the wedding itself, not the mehendi.
  const chosen = cfg.functionCount === 1 ? [FUNCTIONS[2]] : wanted;

  if (chosen.length) await prisma.function.createMany({
    data: chosen.map((fn, i) => {
      const venue = venueRows[fn.venue] || venueRows[0];
      return {
        eventId,
        name:         fn.name,
        date:         addDays(weddingDate, fn.dayOffset),
        startTime:    fn.startTime,
        venueId:      venue.id,
        venueName:    venue.name,
        venueAddress: venue.address,
        venueMapUrl:  venue.mapUrl,
        dressCode:    fn.dressCode || null,
        notes:        fn.notes || null,
        sortOrder:    i,
      };
    }),
  });

  // ── Custom fields ──
  let customRows = [];
  if (cfg.customFields) {
    customRows = deriveCustomFields(fieldSchema, weddingDate);
    // `no-date` must also drop the seeded wedding_date, or the countdown still
    // finds a date through the custom-field path in templateRenderer.
    if (!cfg.weddingDate) customRows = customRows.filter((r) => r.fieldKey !== 'wedding_date');
    if (customRows.length) {
      await prisma.eventCustomField.createMany({ data: customRows.map((r) => ({ eventId, ...r })) });
    }
  }

  // ── Media ──
  const mediaRows = [];
  if (cfg.media) {
    const slotKey = photoSlotKeys(fieldSchema)[0];
    STOCK_PHOTOS.forEach((url, i) => {
      mediaRows.push({ eventId, type: 'photo', url, caption: '', slotKey, sortOrder: i });
    });
    if (musicUrl) {
      mediaRows.push({
        eventId, type: 'music', url: musicUrl, caption: '',
        slotKey: musicSlotKey(fieldSchema), sortOrder: 0,
      });
    }
    if (mediaRows.length) await prisma.media.createMany({ data: mediaRows });
  }

  // ── Links, toggles and the names shown before the wizard runs ──
  await prisma.event.update({
    where: { id: eventId },
    data: {
      groomName:         'Arjun',
      brideName:         'Meera',
      instagramUrl:      cfg.links ? LINKS.instagramUrl : null,
      instagramHashtag:  cfg.links ? LINKS.instagramHashtag : null,
      socialYoutubeUrl:  cfg.links ? LINKS.socialYoutubeUrl : null,
      websiteUrl:        cfg.links ? LINKS.websiteUrl : null,
      rsvpEnabled:       cfg.rsvpEnabled,
      guestNotesEnabled: cfg.guestNotesEnabled,
    },
  });

  return {
    weddingDate: cfg.weddingDate ? weddingDate : null,
    counts: {
      people:       PEOPLE.length,
      venues:       venueRows.length,
      functions:    chosen.length,
      customFields: customRows.length,
      media:        mediaRows.length,
    },
  };
}

module.exports = {
  PRESETS,
  seedSandboxContent,
  deriveCustomFields,
  photoSlotKeys,
  musicSlotKey,
  toYyyyMmDd,
};
