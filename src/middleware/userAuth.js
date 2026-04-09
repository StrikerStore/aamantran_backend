const jwt = require('jsonwebtoken');

/**
 * Middleware: validates a user JWT (role: "user").
 * Sets req.user = { id, username, email }
 */
function verifyUserJWT(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, message: 'No token provided' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'aamantran:user' });
    if (payload.role !== 'user') {
      return res.status(403).json({ ok: false, message: 'Forbidden — not a user token' });
    }
    req.user = { id: payload.id, username: payload.username, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ ok: false, message: 'Invalid or expired token' });
  }
}

module.exports = verifyUserJWT;
