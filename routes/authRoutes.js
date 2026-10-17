const express = require('express');
const router = express.Router();
const { login, getMe } = require('../controllers/authController');
const { authenticateToken } = require('../middleware/authMiddleware');
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10,
  message: { success: false, message: 'Too many attempts, try again later' } });
limit: process.env.NODE_ENV === 'production' ? 10 : 100,
router.post('/login', loginLimiter, login);   
router.get('/me', authenticateToken, getMe);

module.exports = router;