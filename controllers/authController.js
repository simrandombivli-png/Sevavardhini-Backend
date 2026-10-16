const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // top of file



// LOGIN USER
// LOGIN USER
const login = async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const { rows } = await db.query(
      `SELECT user_id, user_name, email, role, password, user_is_active
         FROM users WHERE lower(email) = $1`, [email]);
    const user = rows[0];

    // always run bcrypt, even for unknown emails, so response time doesn't reveal who exists
    const ok = await bcrypt.compare(password, user?.password || DUMMY_HASH);
    if (!user || !user.password || !user.user_is_active || !ok) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign({ user_id: user.user_id }, process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256' });

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};



// GET CURRENT USER PROFILE
const getMe = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT user_id, user_name, email, role, user_created_at FROM users WHERE user_id = $1',
      [req.user.user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.status(200).json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('GetMe Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = { login, getMe };