/**
 * Read an uploaded template's HTML and report where it disagrees with the
 * declared `fieldSchema`.
 *
 * The failure this exists to catch: a developer declares `couple_story` but the
 * template prints `{{couple_history}}`. Nothing errors — the platform simply
 * renders an empty string — so the mistake survives until a real couple sees a
 * blank section. Comparing the two lists surfaces it at save time.
 *
 * Everything here is advisory. Findings are returned as warnings, never as a
 * reason to reject a save: the parse is a regex over Handlebars source, not a
 * real compile, so it can be wrong about generated or conditional markup and
 * must not be able to block a developer.
 */
const { readTemplateHtml, draftFolderName } = require('./fileManager');

/**
 * Variables the renderer always provides (services/templateRenderer.js).
 * A template using one of these needs no declaration, so they must never be
 * reported as undeclared.
 */
const BUILT_IN_VARS = new Set([
  'bride_name', 'groom_name',
  'venue_name', 'venue_address',
  'language', 'invite_url',
  'instagram_url', 'hashtag', 'hashtag_raw',
  'social_youtube_url', 'website_url',
  'rsvp_enabled', 'guest_notes_enabled',
  'people', 'venues', 'custom', 'functions', 'photos',
  'music_url', 'ganesh_image_url', 'media_slots',
  'wedding_date', 'wedding_date_iso', 'wedding_date_raw',
  'template_version_number', 'template_version_label',
  // Available inside {{#each functions}} / {{#each_media_slot}} blocks.
  'name', 'date', 'time', 'venue_map_url', 'venue_lat', 'venue_lng',
  'dress_code', 'notes', 'url', 'caption', 'type', 'id', 'photo_url',
]);

/** Handlebars built-ins and the helpers the platform registers. */
const KNOWN_HELPERS = new Set([
  'if', 'unless', 'each', 'with', 'else', 'log', 'lookup', 'this',
  'people_by_role', 'person', 'person_name', 'person_photo',
  'custom_field', 'if_role', 'if_custom',
  'each_media_slot', 'media_slot_url', 'has_media_slot',
  'youtube_embed_src',
]);

/** Strip {{!-- ... --}} and {{! ... }} so commented-out markup isn't counted. */
function stripHandlebarsComments(html) {
  return String(html)
    .replace(/\{\{!--[\s\S]*?--\}\}/g, '')
    .replace(/\{\{![\s\S]*?\}\}/g, '');
}

/**
 * Every `{{...}}` expression in the source, normalised.
 * Returns the raw inner text of each mustache, block helpers included.
 */
function extractExpressions(html) {
  const out = [];
  const re = /\{\{\{?([^}]+)\}?\}\}/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Words that make a `{{x_name}}` token read as a person rather than a field.
 *
 * `{{groom_father_name}}` is a role; `{{contact_name}}` is a custom field that
 * happens to end the same way. Nothing in the syntax separates them, so the
 * schema is consulted first and this vocabulary only breaks ties for tokens the
 * schema does not mention.
 */
const RELATION_WORDS = /(?:^|_)(?:bride|groom|father|mother|grandfather|grandmother|grandparent|parent|brother|sister|sibling|uncle|aunt|cousin|host|celebrant|retiree|birthday|couple|partner|spouse|witness|bestman|bridesmaid|groomsman)(?:_|$)/;

/**
 * Roles referenced through helpers or the flat {{role_name}} / {{role_photo}} form.
 *
 * @param {string[]} declaredRoles  Roles from fieldSchema.people — authoritative.
 * @param {string[]} declaredCustom Custom keys from fieldSchema — also authoritative.
 */
function extractRoles(html, expressions, declaredRoles = [], declaredCustom = []) {
  const roles = new Set();

  // {{#if_role people "groom_father"}}, {{person_name people "bride"}}, etc.
  // These name the role explicitly, so there is nothing to infer.
  const helperRe = /(?:if_role|person|people_by_role|person_name|person_photo)\s+people\s+"([^"]+)"/g;
  let m;
  while ((m = helperRe.exec(html)) !== null) roles.add(m[1]);

  // Flat form: {{groom_father_name}} / {{bride_photo}}.
  for (const expr of expressions) {
    const token = expr.replace(/^[#/^]/, '').split(/\s+/)[0];
    const hit = /^([a-z0-9_]+)_(name|photo)$/.exec(token);
    if (!hit || BUILT_IN_VARS.has(token)) continue;

    const candidate = hit[1];
    if (declaredRoles.includes(candidate)) { roles.add(candidate); continue; }
    // Declared as a custom field — believe the schema, not the suffix.
    if (declaredCustom.includes(token)) continue;
    if (RELATION_WORDS.test(candidate)) roles.add(candidate);
    // Otherwise it falls through to extractCustomKeys, which is the safer
    // default: a wrong "undeclared custom field" note costs a developer a
    // glance, a wrong "undeclared role" sends them editing the wrong section.
  }

  return roles;
}

/** Media slot keys referenced through the slot helpers. */
function extractMediaSlots(html) {
  const slots = new Set();
  const re = /(?:has_media_slot|each_media_slot|media_slot_url)\s+media_slots\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) slots.add(m[1]);

  // Flat shortcut: {{media_couple_carousel_url}} -> couple_carousel
  const flatRe = /\{\{\s*media_([a-zA-Z0-9_]+)_url\s*\}\}/g;
  while ((m = flatRe.exec(html)) !== null) slots.add(m[1]);

  return slots;
}

/**
 * Candidate custom-field keys: bare `{{some_key}}` mustaches that are neither a
 * built-in, a helper, a role-derived name, nor a block-local variable.
 */
function extractCustomKeys(expressions, roles, html) {
  const keys = new Set();

  // Explicit form leaves no doubt: {{custom_field custom "key"}} / {{#if_custom custom "key"}}
  const explicitRe = /(?:custom_field|if_custom)\s+custom\s+"([^"]+)"/g;
  let m;
  while ((m = explicitRe.exec(html)) !== null) keys.add(m[1]);

  const roleDerived = new Set();
  for (const role of roles) {
    roleDerived.add(`${role}_name`);
    roleDerived.add(`${role}_photo`);
  }

  for (const expr of expressions) {
    if (/^[/>]/.test(expr)) continue;                 // closers and partials

    const parts = expr.split(/\s+/);
    let token;

    if (/^[#^]/.test(expr)) {
      // A key used only as a guard — {{#if contact_name}} — still counts as
      // used. Without this it would be reported as "declared but unused",
      // which is exactly the false alarm that trains people to ignore warnings.
      const helper = parts[0].replace(/^[#^]/, '');
      if (!['if', 'unless', 'with'].includes(helper)) continue;
      if (parts.length !== 2) continue;               // sub-expressions, extra args
      token = parts[1];
    } else {
      // A bare custom variable is always a single token.
      if (parts.length !== 1) continue;
      token = parts[0];
    }

    token = token.replace(/^\.\//, '');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) continue;   // @index, this.x, paths
    if (BUILT_IN_VARS.has(token)) continue;
    if (KNOWN_HELPERS.has(token)) continue;
    if (roleDerived.has(token)) continue;
    if (/^media_[a-zA-Z0-9_]+_url$/.test(token)) continue;

    keys.add(token);
  }

  return keys;
}

/**
 * What the HTML actually references.
 *
 * The declared lists are advisory input, not a filter: they only resolve tokens
 * whose shape is genuinely ambiguous (see RELATION_WORDS).
 */
function analyseHtml(html, { declaredRoles = [], declaredCustom = [] } = {}) {
  const clean = stripHandlebarsComments(html);
  const expressions = extractExpressions(clean);
  const roles = extractRoles(clean, expressions, declaredRoles, declaredCustom);
  const mediaSlots = extractMediaSlots(clean);
  const customKeys = extractCustomKeys(expressions, roles, clean);

  return {
    roles: [...roles].sort(),
    mediaSlots: [...mediaSlots].sort(),
    customKeys: [...customKeys].sort(),
    usesRsvp:   /data-aamantran\s*=\s*"rsvp"/.test(clean),
    usesWishes: /data-aamantran\s*=\s*"wish"/.test(clean),
  };
}

function declaredList(fieldSchema, section, prop) {
  const rows = Array.isArray(fieldSchema?.[section]) ? fieldSchema[section] : [];
  return rows.map((r) => String(r?.[prop] || '').trim()).filter(Boolean);
}

/**
 * Compare a template's HTML against its declared schema.
 *
 * @returns {Promise<{ ok: boolean, warnings: Array, used: object, skipped?: string }>}
 */
async function checkSchemaAgainstHtml(template, fieldSchema) {
  let html;
  try {
    html = await readTemplateHtml(draftFolderName(template.slug), {
      preferredFile:    template.desktopEntryFile,
      desktopEntryFile: template.desktopEntryFile,
      mobileEntryFile:  template.mobileEntryFile,
    });
  } catch (err) {
    // No readable entry file — nothing to compare against. Never fatal.
    return { ok: true, warnings: [], used: null, skipped: err.message };
  }

  const declaredCustom = declaredList(fieldSchema, 'customFields', 'key');
  const declaredRoles  = declaredList(fieldSchema, 'people', 'role');
  const declaredSlots  = declaredList(fieldSchema, 'mediaSlots', 'key');

  const used = analyseHtml(html, { declaredRoles, declaredCustom });
  const warnings = [];

  // ── Used but not declared: renders blank in production ──
  for (const key of used.customKeys.filter((k) => !declaredCustom.includes(k))) {
    warnings.push({
      level: 'error',
      kind:  'custom-undeclared',
      key,
      message: `{{${key}}} is used in the HTML but not declared in customFields — it will always render empty.`,
    });
  }

  for (const role of used.roles.filter((r) => !declaredRoles.includes(r))) {
    warnings.push({
      level: 'error',
      kind:  'role-undeclared',
      key:   role,
      message: `Role "${role}" is used in the HTML but not declared in people — its name and photo will be empty.`,
    });
  }

  for (const slot of used.mediaSlots.filter((s) => !declaredSlots.includes(s))) {
    warnings.push({
      level: 'error',
      kind:  'slot-undeclared',
      key:   slot,
      message: `Media slot "${slot}" is used in the HTML but not declared in mediaSlots — nothing can ever be uploaded to it.`,
    });
  }

  // ── Declared but unused: usually a typo on one side or the other ──
  for (const key of declaredCustom) {
    if (!used.customKeys.includes(key)) {
      warnings.push({
        level: 'warn',
        kind:  'custom-unused',
        key,
        message: `customFields declares "${key}" but the HTML never prints it. Check for a typo on either side.`,
      });
    }
  }
  for (const role of declaredRoles) {
    if (!used.roles.includes(role)) {
      warnings.push({
        level: 'warn',
        kind:  'role-unused',
        key:   role,
        message: `people declares role "${role}" but the HTML never uses it.`,
      });
    }
  }
  for (const slot of declaredSlots) {
    if (!used.mediaSlots.includes(slot)) {
      warnings.push({
        level: 'warn',
        kind:  'slot-unused',
        key:   slot,
        message: `mediaSlots declares "${slot}" but the HTML never reads it.`,
      });
    }
  }

  return { ok: warnings.every((w) => w.level !== 'error'), warnings, used };
}

module.exports = {
  analyseHtml,
  checkSchemaAgainstHtml,
  BUILT_IN_VARS,
};
