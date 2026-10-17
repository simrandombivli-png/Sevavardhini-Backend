const express = require('express');
const router = express.Router();
const { login, getMe ,changePassword} = require('../controllers/authController');
const { authenticateToken } = require('../middleware/authMiddleware');
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'production' ? 10 : 100,
  message: { success: false, message: 'Too many attempts, try again later' } });

router.post('/login', loginLimiter, login);   
router.get('/me', authenticateToken, getMe);
router.patch('/change-password', authenticateToken, changePassword);
module.exports = router;