require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./config/db');
const authRoutes = require('./routes/authRoutes');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Mount Authentication Routes
app.use('/api/auth', authRoutes);

// Test Route to check database connection
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT user_id, user_name, email, role, user_created_at FROM users'
    );
    res.status(200).json({
      success: true,
      message: 'Database connected successfully!',
      users: result.rows
    });
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});