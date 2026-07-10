const crypto = require('crypto');
const siteUrls = require('../config/siteUrls');
const { timingSafeEqualStr } = require('./authSecurity');

/**
 * Signed unsubscribe links for marketing emails (DPDP consent withdrawal —
 * must be as easy as opting in, no login required). Token is an HMAC of the
 * lowercased email, so links can't be forged to unsubscribe someone else.
 */
function unsubscribeSecret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
}

function unsubscribeToken(email) {
  return crypto
    .createHmac('sha256', unsubscribeSecret())
    .update(String(email).trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function verifyUnsubscribeToken(email, token) {
  return timingSafeEqualStr(unsubscribeToken(email), String(token || ''));
}

function buildUnsubscribeUrl(email) {
  const e = String(email).trim().toLowerCase();
  return `${siteUrls.apiBaseUrl()}/api/unsubscribe?email=${encodeURIComponent(e)}&token=${unsubscribeToken(e)}`;
}

module.exports = { unsubscribeToken, verifyUnsubscribeToken, buildUnsubscribeUrl };
