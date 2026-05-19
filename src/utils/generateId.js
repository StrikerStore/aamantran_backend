// Returns a random 5-digit number as a string: "14463"
function generateId() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

// Returns a human-readable order reference: AO-DDMMYY-HHMMSS-XXXX
// Example: AO-190526-143052-A8K3
// Purely a display/reference ID — not used in any business logic.
function generateOrderId() {
  const now  = new Date();
  const dd   = String(now.getDate()).padStart(2, '0');
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const yy   = String(now.getFullYear()).slice(-2);
  const hh   = String(now.getHours()).padStart(2, '0');
  const min  = String(now.getMinutes()).padStart(2, '0');
  const ss   = String(now.getSeconds()).padStart(2, '0');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rand = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `AO-${dd}${mm}${yy}-${hh}${min}${ss}-${rand}`;
}

module.exports = { generateId, generateOrderId };
