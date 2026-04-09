const jwt = require('jsonwebtoken');

const PREVIEW_TTL = '24h';

function mintInvitePreviewToken(slug) {
  return jwt.sign(
    { typ: 'inv_preview', slug: String(slug) },
    process.env.JWT_SECRET,
    { expiresIn: PREVIEW_TTL, issuer: 'aamantran:preview' }
  );
}

function verifyInvitePreviewToken(token, expectedSlug) {
  if (!token || !expectedSlug) return false;
  try {
    const p = jwt.verify(String(token), process.env.JWT_SECRET, { issuer: 'aamantran:preview' });
    return p.typ === 'inv_preview' && p.slug === String(expectedSlug);
  } catch {
    return false;
  }
}

module.exports = { mintInvitePreviewToken, verifyInvitePreviewToken };
