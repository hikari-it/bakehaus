const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured before starting the Bakehaus API');
}

function verifyToken(req, res, next) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) {
    return res.status(401).json({ error: 'Akses ditolak: Token tidak ditemukan' });
  }

  jwt.verify(match[1], JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ error: 'Token tidak valid atau sudah kedaluwarsa' });
    }
    req.user = user;
    next();
  });
}

function optionalToken(req, res, next) {
  if (!req.headers.authorization) return next();
  return verifyToken(req, res, next);
}

function requireRole(...roles) {
  const allowed = new Set(roles.map(role => role.toLowerCase()));
  return (req, res, next) => verifyToken(req, res, () => {
    const role = String(req.user.role || '').toLowerCase();
    if (!allowed.has(role)) {
      return res.status(403).json({ error: 'Akses tidak diizinkan untuk peran ini' });
    }
    next();
  });
}

module.exports = { JWT_SECRET, verifyToken, optionalToken, requireRole };
