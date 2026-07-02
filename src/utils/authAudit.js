/**
 * Structured auth audit logging (login attempts, password resets).
 * Console-based so it lands in Railway logs; swap sink for a DB table
 * or external service when one is available.
 */
function logAuthEvent(event, req, details = {}) {
  const entry = {
    event,
    ip: req.ip,
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
    ts: new Date().toISOString(),
    ...details,
  };
  console.log('[auth-audit]', JSON.stringify(entry));
}

module.exports = { logAuthEvent };
