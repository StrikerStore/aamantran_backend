const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const { devJwtSecret, passwordVersion } = require('../utils/authSecurity');

/**
 * Middleware: validates a Template Lab developer JWT (role: "dev").
 * Sets req.dev = { id, handle, email, sandboxUserId }
 *
 * Deliberately its own issuer and secret so a developer token is never
 * interchangeable with an admin or couple token — a Lab session must not be
 * able to reach /api/v1/* no matter how the routers are mounted.
 *
 * Like middleware/userAuth.js, tokens carry a `pv` fingerprint of the password
 * hash at issue time, so rotating a developer's password immediately kills any
 * session left open on a contractor's machine.
 */
async function verifyDevJWT(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, message: 'No token provided' });
  }

  let payload;
  try {
    payload = jwt.verify(token, devJwtSecret(), { issuer: 'aamantran:dev' });
  } catch {
    return res.status(401).json({ ok: false, message: 'Invalid or expired token' });
  }

  if (payload.role !== 'dev') {
    return res.status(403).json({ ok: false, message: 'Forbidden — not a developer token' });
  }

  // Re-read on every request: access is revoked by flipping isActive, and that
  // must take effect immediately rather than when the token happens to expire.
  const dev = await prisma.developerAccount.findUnique({
    where:  { id: payload.id },
    select: { id: true, handle: true, email: true, isActive: true, passwordHash: true, sandboxUserId: true },
  });

  if (!dev || !dev.isActive) {
    return res.status(401).json({ ok: false, message: 'This developer account is no longer active.' });
  }
  if (passwordVersion(dev.passwordHash) !== payload.pv) {
    return res.status(401).json({ ok: false, message: 'Session expired — please sign in again.' });
  }

  req.dev = {
    id:            dev.id,
    handle:        dev.handle,
    email:         dev.email,
    sandboxUserId: dev.sandboxUserId,
  };
  next();
}

module.exports = verifyDevJWT;
