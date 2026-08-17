const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const apiRoutes = require('./routes/api');
const db = require('./db');
const redis = require('./redis');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Health Check Endpoint for Docker
app.get('/health', async (req, res) => {
  try {
    // Check DB connection
    await db.query('SELECT 1');
    // Check Redis connection
    await redis.ping();
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// API Routes
app.use('/api', apiRoutes);

// Fallback route to serve frontend app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API Gateway Service running on http://0.0.0.0:${PORT}`);
});
