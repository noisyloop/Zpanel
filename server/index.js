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

app.use('/api/auth',   require('./auth/routes'));
app.use('/api/stats',  require('./modules/stats/routes'));
app.use('/api/files',  require('./modules/files/routes'));
app.use('/api/domains', require('./modules/domains/routes'));
app.use('/api/domains/:domainId/dns', require('./modules/dns/routes'));
app.use('/api/domains/:domainId/ssl', require('./modules/ssl/routes'));
app.use('/api/ssl',       require('./modules/ssl/routes'));
app.use('/api/email',     require('./modules/email/routes'));
app.use('/api/databases', require('./modules/databases/routes'));
app.use('/api/ftp',       require('./modules/ftp/routes'));
app.use('/api/cron',      require('./modules/cron/routes'));
app.use('/api/apps',      require('./modules/apps/routes'));
app.use('/api/processes', require('./modules/processes/routes'));
app.use('/api/isolation', require('./modules/isolation/routes'));
app.use('/api/deploy',    require('./modules/deploy/routes'));
app.use('/api/users',         require('./modules/users/routes'));
app.use('/api/audit',         require('./modules/audit/routes'));
app.use('/api/backups',       require('./modules/backups/routes'));
app.use('/api/notifications', require('./modules/notifications/routes'));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server  = http.createServer(app);
const wss     = new WebSocket.Server({ server, path: '/ws/stats' });
const wssLogs = new WebSocket.Server({ server, path: '/ws/logs' });

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

// ── PM2 log streaming WebSocket: /ws/logs?token=<jwt>&name=<pm2name> ─────────
const pm2Procs = require('./modules/processes');

wssLogs.on('connection', (ws, req) => {
  const url  = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const name  = url.searchParams.get('name');

  try { verifyAccessToken(token); } catch {
    ws.close(4001, 'Unauthorized'); return;
  }
  if (!name) { ws.close(4002, 'name required'); return; }

  let proc;
  try {
    proc = pm2Procs.tailLogs(name, 50);
  } catch (err) {
    ws.send(JSON.stringify({ error: err.message }));
    ws.close(); return;
  }

  const send = chunk => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ line: chunk.toString() }));
    }
  };

  proc.stdout.on('data', send);
  proc.stderr.on('data', send);
  proc.on('close', () => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
  ws.on('close', () => { try { proc.kill(); } catch { /* already gone */ } });
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

// ── SSL renewal scheduler ─────────────────────────────────────────────────────

require('./modules/ssl').startRenewalScheduler(30);

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
server.listen(PORT, () => {
  console.log(`[zpanel] Listening on http://localhost:${PORT}`);
});

module.exports = { app, server };
