require('dotenv').config();
for (const k of ['DATABASE_URL', 'JWT_SECRET', 'FRONTEND_URL']) {
  if (!process.env[k]) { console.error(`Missing ${k}`); process.exit(1); }
}
if (process.env.JWT_SECRET.length < 32) { console.error('JWT_SECRET too short'); process.exit(1); }
const helmet = require('helmet');
const express = require('express');
const cors = require('cors');
const db = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');   // with the other requires
const taskRoutes = require('./routes/taskRoutes');

const app = express();

// Middlewares
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL.split(',') }));
app.use(express.json({ limit: '10kb' }));

// Mount Authentication Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);                    // under the auth routes
app.get('/health', async (req, res) => {
  try { await db.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});
app.use('/api/tasks', taskRoutes);

// Start Server
const PORT = process.env.PORT || 5000;
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
