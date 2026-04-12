const Handlebars = require('handlebars');
const { readTemplateHtml } = require('./fileManager');
const { injectAamantranRuntime } = require('./aamantranSdk');
const siteUrls = require('../config/siteUrls');

// ─── Handlebars helpers ──────────────────────────────────────────────────────

/**
 * {{#people_by_role people "bride"}} ... {{this.name}} ... {{/people_by_role}}
 * Iterates over people matching the given role.
 */
Handlebars.registerHelper('people_by_role', function (people, role, options) {
  const matches = (people || []).filter(p => p.role === role);
  if (!matches.length) return options.inverse ? options.inverse(this) : '';
  return matches.map(p => options.fn(p)).join('');
});

/**
 * {{#person people "bride"}} {{name}} {{/person}}
 * Block helper for a single person by role (first match).
 */
Handlebars.registerHelper('person', function (people, role, options) {
  const match = (people || []).find(p => p.role === role);
  if (!match) return options.inverse ? options.inverse(this) : '';
  return options.fn(match);
});

/**
 * {{person_name people "bride_father"}}
 * Simple inline helper — returns the name of the first person with that role.
 */
Handlebars.registerHelper('person_name', function (people, role) {
  const match = (people || []).find(p => p.role === role);
  return match ? match.name : '';
});

/**
 * {{person_photo people "bride"}}
 */
Handlebars.registerHelper('person_photo', function (people, role) {
  const match = (people || []).find(p => p.role === role);
  return match ? (match.photo_url || '') : '';
});

/**
 * {{custom_field custom "love_story"}}
 */
Handlebars.registerHelper('custom_field', function (custom, key) {
  return custom && custom[key] != null ? custom[key] : '';
});

/**
 * {{#if_role people "bride"}} ... {{/if_role}}
 * Conditional: renders block only if a person with that role exists.
 */
Handlebars.registerHelper('if_role', function (people, role, options) {
  const exists = (people || []).some(p => p.role === role);
  return exists ? options.fn(this) : (options.inverse ? options.inverse(this) : '');
});

/**
 * {{#if_custom custom "love_story"}} ... {{/if_custom}}
 * Conditional: renders block only if that custom field has a value.
 */
Handlebars.registerHelper('if_custom', function (custom, key, options) {
  const val = custom && custom[key];
  return val ? options.fn(this) : (options.inverse ? options.inverse(this) : '');
});

/**
 * {{#each_media_slot media_slots "couple_carousel"}}<img src="{{url}}" />{{/each_media_slot}}
 */
Handlebars.registerHelper('each_media_slot', function (slots, key, options) {
  const arr = (slots && slots[key]) || [];
  if (!arr.length) return options.inverse ? options.inverse(this) : '';
  return arr.map((item) => options.fn(item)).join('');
});

/** {{media_slot_url media_slots "ganesh"}} */
Handlebars.registerHelper('media_slot_url', function (slots, key) {
  const arr = (slots && slots[key]) || [];
  return arr[0]?.url || '';
});

function youtubeEmbedSrc(url) {
  if (url == null || typeof url !== 'string') return '';
  const u = url.trim();
  if (!u) return '';
  let id = '';
  try {
    if (u.includes('youtu.be/')) {
      id = u.split('youtu.be/')[1].split(/[?&#/]/)[0];
    } else {
      const parsed = new URL(u);
      if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtube-nocookie.com')) {
        id = parsed.searchParams.get('v') || '';
        if (!id) {
          const m = parsed.pathname.match(/\/embed\/([^/?]+)/);
          if (m) id = m[1];
        }
        if (!id) {
          const s = parsed.pathname.match(/\/shorts\/([^/?]+)/);
          if (s) id = s[1];
        }
      }
    }
  } catch {
    return '';
  }
  if (!id || !/^[\w-]{6,}$/.test(id)) return '';
  return `https://www.youtube.com/embed/${id}?rel=0`;
}

/** {{youtube_embed_src youtube_url}} — use with {{#if (youtube_embed_src youtube_url)}} */
Handlebars.registerHelper('youtube_embed_src', function (url) {
  return youtubeEmbedSrc(url);
});

/** {{#if (has_media_slot media_slots "couple_carousel")}} */
Handlebars.registerHelper('has_media_slot', function (slots, key) {
  const arr = (slots && slots[key]) || [];
  return arr.length > 0;
});

// ─── Core rendering ──────────────────────────────────────────────────────────

/**
 * Render a template with the given data object.
 * The template HTML uses {{variable}} tokens (Handlebars syntax).
 *
 * @param {string} folderName - e.g. "floral-design-14463"
 * @param {object} data       - key/value pairs to inject
 * @param {object} options    - { variant: 'desktop'|'mobile', preferredFile?: string }
 * @returns {string}          - fully rendered HTML string
 */
async function renderTemplate(folderName, data, options = {}) {
  const html = await readTemplateHtml(folderName, {
    variant: options.variant,
    preferredFile: options.preferredFile,
    desktopEntryFile: options.desktopEntryFile,
    mobileEntryFile: options.mobileEntryFile,
  });

  // Compile and render
  const template = Handlebars.compile(html, { noEscape: true });
  const rendered = template(data);
  if (options.aamantranContext) {
    return injectAamantranRuntime(rendered, options.aamantranContext);
  }
  return rendered;
}

/**
 * Build the data object for a couple's live invitation.
 * Produces flat shortcut variables (bride_name, groom_name, etc.)
 * PLUS structured arrays (people[], venues[], functions[], custom{}).
 */
function buildInvitationData(event) {
  // ── People: structured array ──
  const people = (event.people || [])
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(p => ({
      role:      p.role,
      name:      p.name,
      photo_url: p.photoUrl || '',
      extra:     p.extraData || {},
    }));

  // ── People: flat shortcut variables ──
  // Generates {{bride_name}}, {{bride_photo}}, {{groom_father_name}}, etc.
  const peopleFlatVars = {};
  for (const p of people) {
    const prefix = p.role; // e.g. "bride", "groom_father", "birthday_person"
    peopleFlatVars[`${prefix}_name`]  = p.name;
    peopleFlatVars[`${prefix}_photo`] = p.photo_url;
    if (p.extra) {
      for (const [k, v] of Object.entries(p.extra)) {
        peopleFlatVars[`${prefix}_${k}`] = v; // e.g. bride_bio, groom_subtitle
      }
    }
  }

  // ── Venues: structured array ──
  const venues = (event.venues || []).map(v => ({
    id:      v.id,
    name:    v.name,
    address: v.address || '',
    lat:     v.lat != null ? String(v.lat) : '',
    lng:     v.lng != null ? String(v.lng) : '',
    map_url: v.mapUrl || '',
    city:    v.city || '',
    state:   v.state || '',
  }));

  // ── Custom fields: key→value object ──
  const custom = {};
  for (const cf of (event.customFields || [])) {
    custom[cf.fieldKey] = cf.fieldType === 'json'
      ? safeJsonParse(cf.fieldValue)
      : cf.fieldValue;
  }

  // ── Functions (sub-events) ──
  const functions = (event.functions || []).map(fn => {
    // Prefer linked venue over inline fields
    const v = fn.venue;
    return {
      name:          fn.name,
      date:          formatDate(fn.date),
      time:          fn.startTime || '',
      venue_name:    v?.name    || fn.venueName    || '',
      venue_address: v?.address || fn.venueAddress || '',
      venue_map_url: v?.mapUrl  || fn.venueMapUrl  || '',
      venue_lat:     v?.lat != null ? String(v.lat) : (fn.venueLat != null ? String(fn.venueLat) : ''),
      venue_lng:     v?.lng != null ? String(v.lng) : (fn.venueLng != null ? String(fn.venueLng) : ''),
      dress_code:    fn.dressCode || '',
      notes:         fn.notes || '',
    };
  });

  // ── Media (ordered; slotKey groups for template helpers) ──
  const sortedMedia = [...(event.media || [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  );

  const media_slots = {};
  for (const m of sortedMedia) {
    const key = m.slotKey || '_legacy';
    if (!media_slots[key]) media_slots[key] = [];
    media_slots[key].push({ url: m.url, caption: m.caption || '', type: m.type });
  }

  const photos = sortedMedia
    .filter(m => m.type === 'photo' && m.slotKey !== 'ganesh')
    .map(m => ({ url: m.url, caption: m.caption || '' }));

  const musicUrl = sortedMedia.find(m => m.type === 'music')?.url || '';

  const ganeshFromSlot = sortedMedia.find(m => m.slotKey === 'ganesh')?.url;
  const ganeshImageUrl =
    custom.ganesh_image_url ||
    ganeshFromSlot ||
    sortedMedia.find(m => m.type === 'ganesh')?.url ||
    photos[0]?.url ||
    '';

  const mediaSlotFlat = {};
  for (const [k, arr] of Object.entries(media_slots)) {
    if (k.startsWith('_')) continue;
    const safe = String(k).replace(/[^a-zA-Z0-9_]/g, '_');
    mediaSlotFlat[`media_${safe}_url`] = arr[0]?.url || '';
  }

  const instagram_url = (event.instagramUrl && String(event.instagramUrl).trim()) || '';
  const social_youtube_url = (event.socialYoutubeUrl && String(event.socialYoutubeUrl).trim()) || '';
  const website_url = (event.websiteUrl && String(event.websiteUrl).trim()) || '';
  const rsvp_enabled = event.rsvpEnabled !== false;
  const guest_notes_enabled = event.guestNotesEnabled !== false;

  return {
    // Backward-compat flat vars (still work in existing templates)
    bride_name:    event.brideName  || peopleFlatVars.bride_name  || '',
    groom_name:    event.groomName  || peopleFlatVars.groom_name  || '',
    wedding_date:  event.functions?.[0] ? formatDate(event.functions[0].date) : '',
    venue_name:    event.functions?.[0]?.venueName || '',
    venue_address: event.functions?.[0]?.venueAddress || '',
    language:      event.language || 'en',
    invite_url:    `${siteUrls.apiBaseUrl()}/i/${event.slug}`,

    instagram_url,
    social_youtube_url,
    website_url,
    rsvp_enabled,
    guest_notes_enabled,

    // New structured data
    people,
    venues,
    custom,
    functions,
    photos,
    music_url: musicUrl,
    ganesh_image_url: ganeshImageUrl,
    media_slots,

    // Spread all flat people vars so {{bride_father_name}}, {{retiree_name}} etc. work
    ...peopleFlatVars,

    // Spread all custom fields so {{love_story}}, {{hashtag}} etc. work directly
    ...custom,

    // e.g. {{media_couple_carousel_url}} for first image in that slot
    ...mediaSlotFlat,
  };
}

function inferMediaType(url) {
  const s = String(url);
  if (/\.(mp3|wav|ogg|aac|m4a|flac)$/i.test(s)) return 'music';
  if (/\.(mp4|webm|mov)$/i.test(s)) return 'video';
  return 'photo';
}

/**
 * Convert demo media map → { slotKey: [{ url, caption, type }] }
 * Supports both old format { key: "url" } and new format { key: ["url1", "url2"] }.
 */
function buildDemoMediaSlots(demoUrls) {
  if (!demoUrls || typeof demoUrls !== 'object') return {};
  const slots = {};
  for (const [key, val] of Object.entries(demoUrls)) {
    if (!val) continue;
    const urls = Array.isArray(val) ? val : [val];
    slots[key] = urls.filter(Boolean).map(u => ({
      url: String(u), caption: '', type: inferMediaType(u),
    }));
  }
  return slots;
}

/** Flat vars: { media_ganesh_url: "https://..." } for direct {{media_ganesh_url}} usage (first URL per slot). */
function buildDemoMediaSlotFlat(demoUrls) {
  if (!demoUrls || typeof demoUrls !== 'object') return {};
  const flat = {};
  for (const [key, val] of Object.entries(demoUrls)) {
    if (!val) continue;
    const first = Array.isArray(val) ? val[0] : val;
    if (!first) continue;
    const safe = String(key).replace(/[^a-zA-Z0-9_]/g, '_');
    flat[`media_${safe}_url`] = String(first);
  }
  return flat;
}

/**
 * Build the data object for a template's live demo.
 * Now supports people and customFields from demo data.
 */
function buildDemoData(demoData) {
  // ── People from demo data ──
  const demoPeople = (demoData.people || []).map((p, i) => ({
    role:      p.role || `person${i + 1}`,
    name:      p.name || '',
    photo_url: p.photo_url || '',
    extra:     {},
  }));

  const peopleFlatVars = {};
  for (const p of demoPeople) {
    peopleFlatVars[`${p.role}_name`]  = p.name;
    peopleFlatVars[`${p.role}_photo`] = p.photo_url;
  }

  // ── Custom fields from demo data ──
  const custom = {};
  for (const cf of (demoData.customFields || [])) {
    custom[cf.key] = cf.value || '';
  }

  const rsvpDemo = demoData.rsvpEnabled !== false && demoData.rsvp_enabled !== false;
  const notesDemo = demoData.guestNotesEnabled !== false && demoData.guest_notes_enabled !== false;

  return {
    // Backward-compat flat vars
    bride_name:    demoData.brideName  || peopleFlatVars.bride_name  || '',
    groom_name:    demoData.groomName  || peopleFlatVars.groom_name  || '',
    wedding_date:  demoData.weddingDate || '',
    venue_name:    demoData.venueName   || '',
    venue_address: demoData.venueAddress || '',
    language:      demoData.language || 'en',
    invite_url:    '#',

    instagram_url:       demoData.instagramUrl || demoData.instagram_url || '',
    social_youtube_url:  demoData.socialYoutubeUrl || demoData.social_youtube_url || '',
    website_url:         demoData.websiteUrl || demoData.website_url || '',
    rsvp_enabled:        rsvpDemo,
    guest_notes_enabled: notesDemo,

    // Structured arrays
    people:    demoPeople,
    venues:    [],
    custom,
    functions: (demoData.functions || [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(fn => ({
        name:          fn.name,
        date:          fn.date,
        time:          fn.time,
        venue_name:    fn.venueName,
        venue_address: fn.venueAddress || '',
        dress_code:    '',
        notes:         '',
      })),
    photos:    (() => {
      // Primary: explicit photoUrls array (legacy field)
      const fromPhotoUrls = (demoData.photoUrls || []).filter(Boolean).map(url => ({ url, caption: '' }));
      if (fromPhotoUrls.length) return fromPhotoUrls;
      // Fallback: pull from the 'photos' or 'gallery' media slot (uploaded via R2 media-slot system)
      const mediaSlots  = demoData.mediaSlotDemoUrls || {};
      const slotPhotos  = (mediaSlots.photos || mediaSlots.gallery || []);
      const slotUrls    = Array.isArray(slotPhotos) ? slotPhotos : (slotPhotos ? [slotPhotos] : []);
      return slotUrls.filter(Boolean).map(u => ({ url: String(u), caption: '' }));
    })(),
    music_url: demoData.musicUrl || '',
    ganesh_image_url: custom.ganesh_image_url || (demoData.photoUrls || [])[0] || '',

    // Media slots from demo URLs — builds same structure as live invitations
    media_slots: buildDemoMediaSlots(demoData.mediaSlotDemoUrls),

    // Spread flat people vars
    ...peopleFlatVars,
    // Spread custom fields
    ...custom,
    // Spread flat media slot vars (e.g. {{media_ganesh_url}})
    ...buildDemoMediaSlotFlat(demoData.mediaSlotDemoUrls),
  };
}

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

module.exports = { renderTemplate, buildInvitationData, buildDemoData };
