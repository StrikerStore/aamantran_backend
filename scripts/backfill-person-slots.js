/**
 * Backfill for the person1 / person2 rename (were groom / bride).
 *
 *   node scripts/backfill-person-slots.js            # dry run — counts only
 *   node scripts/backfill-person-slots.js --apply    # write changes
 *
 * Each template decides which old slot becomes person1: the first of groom/bride
 * in its people schema (what the couple saw as "Person 1"). For every template:
 *  1. Record that as fieldSchema.legacySlotMap on the template and on every one
 *     of its version snapshots, and rename the schema's people roles and
 *     custom-field keys (groom_father → person1_father, bride_family_line → …).
 *  2. Rename its demo data: person1Name/person2Name, people roles, custom keys.
 * For every event, with its template's map:
 *  3. EventPerson.role and EventCustomField.fieldKey.
 *  4. person1Name/person2Name from brideName/groomName (old columns untouched).
 * Then trial-demo payloads (kept a day) and the render cache (cleared).
 *
 * Task.assignedTo is left alone on purpose: a task assigned to "bride" meant the
 * actual bride, not the old bride slot (which held the groom on half the
 * events). The Tasks screen resolves "bride"/"groom" against the role each
 * person picks instead.
 *
 * Idempotent: a renamed key never matches again and an existing legacySlotMap
 * is reused, so a second run changes nothing. Safe to run on every deploy.
 */

const prisma = require('../src/utils/prisma');
const {
  DEFAULT_LEGACY_SLOT_MAP, parseSchema, legacySlotMapFor, toPersonKey,
} = require('../src/utils/personSlots');

const APPLY = process.argv.includes('--apply');

function log(...args) { console.log('[person-slots]', ...args); }

/** The schema with people roles and custom-field keys renamed, and the map recorded. */
function migrateSchema(fieldSchema, map) {
  const schema = parseSchema(fieldSchema);
  if (!schema) return { next: fieldSchema, changed: false };
  const next = { ...schema, legacySlotMap: map };
  if (Array.isArray(schema.people)) {
    next.people = schema.people.map((p) => (p && p.role ? { ...p, role: toPersonKey(p.role, map) } : p));
  }
  if (Array.isArray(schema.customFields)) {
    next.customFields = schema.customFields.map((f) => (f && f.key ? { ...f, key: toPersonKey(f.key, map) } : f));
  }
  const changed = JSON.stringify(next) !== JSON.stringify(schema);
  return { next, changed };
}

function renameRows(rows, map, keyNames) {
  if (!Array.isArray(rows)) return { next: rows, changed: false };
  let changed = false;
  const next = rows.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const out = { ...r };
    for (const k of keyNames) {
      if (typeof out[k] === 'string') {
        const renamed = toPersonKey(out[k], map);
        if (renamed !== out[k]) { out[k] = renamed; changed = true; }
      }
    }
    return out;
  });
  return { next, changed };
}

function parseJsonArray(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

async function main() {
  log(APPLY ? 'APPLY — writing changes' : 'dry run — nothing is written (pass --apply)');
  const totals = {
    templates: 0, versions: 0, demoData: 0, people: 0, customFields: 0,
    customFieldClashes: 0, eventNames: 0, trials: 0,
  };

  const templates = await prisma.template.findMany({
    select: {
      id: true, slug: true, fieldSchema: true,
      versions: { select: { id: true, fieldSchema: true } },
      demoData: {
        select: {
          id: true, brideName: true, groomName: true, person1Name: true, person2Name: true,
          people: true, customFields: true,
        },
      },
    },
  });

  const mapByTemplate = new Map();
  for (const t of templates) {
    const map = legacySlotMapFor(t.fieldSchema);
    mapByTemplate.set(t.id, map);
    const counts = { schema: 0, versions: 0, demo: 0 };

    const tpl = migrateSchema(t.fieldSchema, map);
    if (tpl.changed) {
      counts.schema = 1;
      if (APPLY) await prisma.template.update({ where: { id: t.id }, data: { fieldSchema: tpl.next } });
    }

    // Every snapshot carries the template's map: its HTML was written against the
    // same slots the events' rows are renamed with.
    for (const v of t.versions || []) {
      const ver = migrateSchema(v.fieldSchema, map);
      if (!ver.changed) continue;
      counts.versions += 1;
      if (APPLY) await prisma.templateVersion.update({ where: { id: v.id }, data: { fieldSchema: ver.next } });
    }

    const d = t.demoData;
    if (d) {
      const data = {};
      const legacyColumn = { groom: d.groomName, bride: d.brideName };
      if (!d.person1Name && legacyColumn[map.person1]) data.person1Name = legacyColumn[map.person1];
      if (!d.person2Name && legacyColumn[map.person2]) data.person2Name = legacyColumn[map.person2];
      const people = renameRows(parseJsonArray(d.people), map, ['role']);
      if (people.changed) data.people = people.next;
      const custom = renameRows(parseJsonArray(d.customFields), map, ['key', 'fieldKey']);
      if (custom.changed) data.customFields = custom.next;
      if (Object.keys(data).length) {
        counts.demo = 1;
        if (APPLY) await prisma.templateDemoData.update({ where: { id: d.id }, data });
      }
    }

    if (counts.schema || counts.versions || counts.demo) {
      log(`${t.slug}: person1=${map.person1} person2=${map.person2} · schema ${counts.schema} · versions ${counts.versions} · demo ${counts.demo}`);
    }
    totals.templates += counts.schema;
    totals.versions += counts.versions;
    totals.demoData += counts.demo;
  }

  const events = await prisma.event.findMany({
    select: {
      id: true, templateId: true, brideName: true, groomName: true, person1Name: true, person2Name: true,
      people: { select: { id: true, role: true } },
      customFields: { select: { id: true, fieldKey: true } },
    },
  });

  for (const ev of events) {
    const map = mapByTemplate.get(ev.templateId) || DEFAULT_LEGACY_SLOT_MAP;

    for (const p of ev.people) {
      const role = toPersonKey(p.role, map);
      if (role === p.role) continue;
      totals.people += 1;
      if (APPLY) await prisma.eventPerson.update({ where: { id: p.id }, data: { role } });
    }

    const keys = new Set(ev.customFields.map((f) => f.fieldKey));
    for (const f of ev.customFields) {
      const key = toPersonKey(f.fieldKey, map);
      if (key === f.fieldKey) continue;
      // (eventId, fieldKey) is unique: never overwrite a value already stored
      // under the new key. Reported so it can be merged by hand.
      if (keys.has(key)) {
        totals.customFieldClashes += 1;
        log(`event ${ev.id}: custom field ${f.fieldKey} not renamed — ${key} already exists`);
        continue;
      }
      totals.customFields += 1;
      keys.add(key);
      if (APPLY) await prisma.eventCustomField.update({ where: { id: f.id }, data: { fieldKey: key } });
    }

    const legacyColumn = { groom: ev.groomName, bride: ev.brideName };
    const names = {};
    if (!ev.person1Name && legacyColumn[map.person1]) names.person1Name = legacyColumn[map.person1];
    if (!ev.person2Name && legacyColumn[map.person2]) names.person2Name = legacyColumn[map.person2];
    if (Object.keys(names).length) {
      totals.eventNames += 1;
      if (APPLY) await prisma.event.update({ where: { id: ev.id }, data: names });
    }
  }

  // Trial payloads live a day; rename so a buyer's prefill lands on person1/person2.
  const trials = await prisma.trialDemo.findMany({ select: { id: true, templateId: true, payload: true } });
  for (const tr of trials) {
    const payload = tr.payload && typeof tr.payload === 'object' ? tr.payload : null;
    if (!payload || !Array.isArray(payload.people)) continue;
    const map = mapByTemplate.get(tr.templateId) || DEFAULT_LEGACY_SLOT_MAP;
    const people = renameRows(payload.people, map, ['role']);
    if (!people.changed) continue;
    totals.trials += 1;
    if (APPLY) await prisma.trialDemo.update({ where: { id: tr.id }, data: { payload: { ...payload, people: people.next } } });
  }

  if (APPLY) {
    const { count } = await prisma.eventRenderCache.deleteMany({});
    log(`render cache cleared: ${count}`);
  }

  log('totals', JSON.stringify(totals));
}

main()
  .catch((err) => {
    console.error('[person-slots] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
