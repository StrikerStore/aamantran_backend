const crypto = require('crypto');

/** RFC 6238 TOTP verification using only Node's crypto — no external dependency. */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(code % 1e6).padStart(6, '0');
}

/**
 * Verify a 6-digit TOTP code against a base32 secret.
 * Accepts ±windowSteps 30-second steps of clock drift.
 */
function verifyTotp(code, base32Secret, windowSteps = 1) {
  const normalized = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const key = base32Decode(base32Secret);
  if (!key.length) return false;

  const step = Math.floor(Date.now() / 1000 / 30);
  let ok = false;
  for (let i = -windowSteps; i <= windowSteps; i++) {
    const expected = hotp(key, step + i);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) ok = true;
  }
  return ok;
}

module.exports = { verifyTotp };
