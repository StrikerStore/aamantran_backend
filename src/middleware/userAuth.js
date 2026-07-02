const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const { userJwtSecret, passwordVersion } = require('../utils/authSecurity');

/**
 * Middleware: validates a user JWT (role: "user").
 * Sets req.user = { id, username, email }
 *
 * Tokens carry a `pv` fingerprint of the password hash at issue time; if the
 * password has changed since, the token is rejected so a password reset
 * invalidates all existing sessions.
 */
async function verifyUserJWT(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, message: 'No token provided' });
  }

  let payload;
  try {
    payload = jwt.verify(token, userJwtSecret(), { issuer: 'aamantran:user' });
  } catch {
    return res.status(401).json({ ok: false, message: 'Invalid or expired token' });
  }

  if (payload.role !== 'user') {
    return res.status(403).json({ ok: false, message: 'Forbidden — not a user token' });
  }

  // `pv` is only present on tokens issued after this check shipped; older
  // tokens skip it and simply age out.
  if (payload.pv) {
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { passwordHash: true },
    });
    if (!user || passwordVersion(user.passwordHash) !== payload.pv) {
      return res.status(401).json({ ok: false, message: 'Session expired — please sign in again.' });
    }
  }

  req.user = { id: payload.id, username: payload.username, email: payload.email };
  next();
}

module.exports = verifyUserJWT;
