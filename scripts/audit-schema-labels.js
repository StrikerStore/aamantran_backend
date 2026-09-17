/**
 * List templates whose fieldSchema labels contain Handlebars tokens.
 *
 * Form labels are printed verbatim in the couple's dashboard — nothing
 * substitutes variables there — so a label such as "{{groom_name}} Father's
 * Name" reaches the customer as that exact text. The admin form now rejects
 * these on save; this script finds the ones stored before that guard existed.
 *
 * Read-only: it reports, it never writes. Fix the labels in Admin → Templates.
 *
 * Usage: node scripts/audit-schema-labels.js
 */
const prisma = require('../src/utils/prisma');

const TOKEN_RE = /\{\{|\}\}/;

function collectBadLabels(fieldSchema) {
  let schema = fieldSchema;
  if (typeof schema === 'string') {
    try { schema = JSON.parse(schema); } catch { return []; }
  }
  if (!schema || typeof schema !== 'object') return [];

  const bad = [];
  const scanRows = (rows, kind, idKey) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row && typeof row === 'object' && TOKEN_RE.test(String(row.label || ''))) {
        bad.push({ kind, id: String(row[idKey] || '(unnamed)'), label: String(row.label) });
      }
    }
  };

  scanRows(schema.people, 'person', 'role');
  scanRows(schema.customFields, 'custom field', 'key');
  scanRows(schema.mediaSlots, 'media slot', 'key');

  const fnFields = schema.functionFields;
  if (fnFields && typeof fnFields === 'object') {
    for (const [key, cfg] of Object.entries(fnFields)) {
      if (cfg && typeof cfg === 'object' && TOKEN_RE.test(String(cfg.label || ''))) {
        bad.push({ kind: 'ceremony field', id: key, label: String(cfg.label) });
      }
    }
  }

  return bad;
}

async function main() {
  const templates = await prisma.template.findMany({
    select: { id: true, slug: true, name: true, isActive: true, fieldSchema: true },
    orderBy: { name: 'asc' },
  });

  let affected = 0;
  for (const t of templates) {
    const bad = collectBadLabels(t.fieldSchema);
    if (!bad.length) continue;
    affected++;
    console.log(`\n${t.name}  (${t.slug})${t.isActive ? '' : '  [inactive]'}`);
    for (const row of bad) {
      console.log(`  ${row.kind} "${row.id}": ${row.label}`);
    }
  }

  console.log(
    affected
      ? `\n${affected} of ${templates.length} templates need a label fix in Admin → Templates.`
      : `\nNo token labels found across ${templates.length} templates.`,
  );
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
