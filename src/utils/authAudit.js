const prisma = require('./prisma');

/**
 * Structured auth audit logging (login attempts, password resets, deletions).
 * Written to console (Railway logs) and persisted to AuthAuditLog so the
 * trail survives redeploys — DPDP Rules 6(c)/(e) require security logs to be
 * kept for at least one year (pruned by dataRetention.service).
 */
function logAuthEvent(event, req, details = {}) {
  const ip = req?.ip || null;
  const ua = String(req?.headers?.['user-agent'] || '').slice(0, 160) || null;
  const { userId = null, ...rest } = details;

  console.log('[auth-audit]', JSON.stringify({ event, ip, ua, ts: new Date().toISOString(), ...details }));

  // Fire-and-forget: an audit-sink failure must never break the auth flow.
  prisma.authAuditLog
    .create({
      data: {
        event: String(event).slice(0, 64),
        ip,
        userAgent: ua,
        userId,
        details: Object.keys(rest).length ? rest : undefined,
      },
    })
    .catch((err) => console.error('[auth-audit] DB write failed:', err.message));
}

module.exports = { logAuthEvent };
