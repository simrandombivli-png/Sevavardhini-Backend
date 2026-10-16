const jwt = require('jsonwebtoken');
const db = require('../config/db'); // add at top

  const db = require('../config/db'); // add at top

  const authenticateToken = async (req, res, next) => {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ success: false, message: 'Access token required' });
    }
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    const { rows } = await db.query(
      'SELECT user_id, role, user_is_active FROM users WHERE user_id = $1', [payload.user_id]);
    if (!rows[0] || !rows[0].user_is_active) {
      return res.status(401).json({ success: false, message: 'Account not available' });
    }
    req.user = { user_id: rows[0].user_id, role: rows[0].role };
    next();
  };

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied: Unauthorized role' });
    }
    next();
  };
};

module.exports = { authenticateToken, authorizeRoles };