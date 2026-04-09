/**
 * Template fieldSchema.mediaSlots drives per-slot uploads in user/admin UIs.
 * @typedef {{ key: string, label?: string, type: string, multiple?: boolean, max?: number, accept?: string, allowUrl?: boolean }} MediaSlotDef
 */

function parseFieldSchema(fieldSchema) {
  if (fieldSchema == null) return null;
  if (typeof fieldSchema === 'string') {
    try {
      return JSON.parse(fieldSchema);
    } catch {
      return null;
    }
  }
  return fieldSchema;
}

/**
 * @param {unknown} fieldSchema
 * @returns {MediaSlotDef[]|null} null → legacy single-form UI
 */
function getMediaSlots(fieldSchema) {
  const fs = parseFieldSchema(fieldSchema);
  if (!fs || !Array.isArray(fs.mediaSlots) || fs.mediaSlots.length === 0) return null;
  return fs.mediaSlots
    .filter((s) => s && typeof s.key === 'string' && String(s.key).trim())
    .map((s) => ({
      key: String(s.key).trim(),
      label: s.label || s.key,
      type: s.type === 'music' ? 'music' : s.type === 'video' ? 'video' : 'photo',
      multiple: !!s.multiple,
      max: typeof s.max === 'number' && s.max > 0 ? s.max : (s.multiple ? 24 : 1),
      accept: typeof s.accept === 'string' ? s.accept : defaultAccept(s.type),
      allowUrl: s.allowUrl !== false,
    }));
}

function defaultAccept(slotType) {
  if (slotType === 'music') return 'audio/*';
  if (slotType === 'video') return 'video/*';
  return 'image/*';
}

/**
 * @param {MediaSlotDef|null} slot
 * @param {string} url
 * @param {boolean} hasFile
 */
function assertUrlAllowed(slot, url, hasFile) {
  if (hasFile) return { ok: true };
  const u = String(url || '').trim();
  if (!u) return { ok: false, message: 'URL or file is required' };
  if (slot && slot.allowUrl === false) {
    return { ok: false, message: 'This slot only accepts uploaded files' };
  }
  return { ok: true };
}

/**
 * Map slot type to persisted Media.type
 * @param {string} slotType
 */
function mediaTypeForSlot(slotType) {
  if (slotType === 'music') return 'music';
  if (slotType === 'video') return 'video';
  return 'photo';
}

function inferTypeFromFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(lower)) return 'music';
  if (/\.(mp4|webm|mov)$/.test(lower)) return 'video';
  return 'photo';
}

/**
 * @param {MediaSlotDef[]|null} slots
 * @param {string|null|undefined} slotKey
 * @returns {MediaSlotDef|null}
 */
function findSlot(slots, slotKey) {
  if (!slots || !slotKey) return null;
  return slots.find((s) => s.key === slotKey) || null;
}

module.exports = {
  getMediaSlots,
  findSlot,
  assertUrlAllowed,
  mediaTypeForSlot,
  inferTypeFromFilename,
  parseFieldSchema,
};
