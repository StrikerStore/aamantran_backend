const jwt = require('jsonwebtoken');

function verifyAdminJWT(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, message: 'No token provided' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'aamantran:admin' });
    if (payload.role !== 'admin') {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ ok: false, message: 'Invalid or expired token' });
  }
}

module.exports = verifyAdminJWT;
