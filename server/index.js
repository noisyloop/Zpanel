require('dotenv').config();
const express    = require('express');
const http       = require('http');
const path       = require('path');
const cookieParser = require('cookie-parser');
const WebSocket  = require('ws');
const { verifyAccessToken } = require('./auth');
const { getSnapshot }       = require('./modules/stats');

// ── Express setup ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../client')));

// ── API routes ────────────────────────────────────────────────────────────────

app.use('/api/auth',  require('./auth/routes'));
app.use('/api/stats', require('./modules/stats/routes'));
app.use('/api/files', require('./modules/files/routes'));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws/stats' });

wss.on('connection', (ws, req) => {
  // Expect token as query param: /ws/stats?token=<jwt>
  const url    = new URL(req.url, 'http://localhost');
  const token  = url.searchParams.get('token');
  try {
    verifyAccessToken(token);
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(interval);
    try {
      ws.send(JSON.stringify(getSnapshot()));
    } catch {
      clearInterval(interval);
    }
  }, 2000);

  ws.on('close', () => clearInterval(interval));
});

// ── Seed default admin if no users exist ──────────────────────────────────────

(function seedAdmin() {
  const db   = require('./db');
  const auth = require('./auth');
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (count === 0) {
    const defaultPassword = process.env.ADMIN_PASSWORD || 'changeme';
    auth.createUser('admin', defaultPassword, 'admin');
    console.log('[zpanel] Default admin created. Username: admin');
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[zpanel] WARNING: Set ADMIN_PASSWORD in .env — default password "changeme" is insecure');
    }
  }
})();

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
server.listen(PORT, () => {
  console.log(`[zpanel] Listening on http://localhost:${PORT}`);
});

module.exports = { app, server };
