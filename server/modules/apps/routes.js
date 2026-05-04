const express = require('express');
const { requireAuth, audit } = require('../../auth');
const apps = require('./index');
const db   = require('../../db');

const router = express.Router();
const ctx    = req => ({ user: req.user.username, ip: req.ip });

// GET /api/apps
router.get('/', requireAuth, (req, res) => {
  const list = req.user.role === 'admin' ? apps.listAllApps() : apps.listApps(req.user.sub);
  res.json(list);
});

// POST /api/apps/wordpress
router.post('/wordpress', requireAuth, async (req, res) => {
  const { domainId, installDir, dbName, dbUser, dbPassword, siteUrl, adminEmail } = req.body;
  if (!installDir || !dbName || !dbUser || !dbPassword || !siteUrl) {
    return res.status(400).json({ error: 'installDir, dbName, dbUser, dbPassword, siteUrl required' });
  }

  // Stream progress via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = msg => res.write(`data: ${JSON.stringify({ log: msg })}\n\n`);

  try {
    const app = await apps.installWordPress(
      { userId: req.user.sub, domainId, installDir, dbName, dbUser, dbPassword, siteUrl, adminEmail },
      ctx(req), send
    );
    audit(req, 'app_install', 'wordpress', { installDir }, 'ok');
    res.write(`data: ${JSON.stringify({ done: true, app })}\n\n`);
  } catch (err) {
    audit(req, 'app_install', 'wordpress', { installDir }, 'failed');
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// POST /api/apps/ghost
router.post('/ghost', requireAuth, async (req, res) => {
  const { domainId, installDir, siteUrl, pm2Name } = req.body;
  if (!installDir || !siteUrl) {
    return res.status(400).json({ error: 'installDir, siteUrl required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const send = msg => res.write(`data: ${JSON.stringify({ log: msg })}\n\n`);

  try {
    const app = await apps.installGhost(
      { userId: req.user.sub, domainId, installDir, siteUrl, pm2Name }, ctx(req), send
    );
    audit(req, 'app_install', 'ghost', { installDir }, 'ok');
    res.write(`data: ${JSON.stringify({ done: true, app })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// POST /api/apps/static
router.post('/static', requireAuth, async (req, res) => {
  const { domainId, installDir, archivePath } = req.body;
  if (!installDir || !archivePath) {
    return res.status(400).json({ error: 'installDir, archivePath required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const send = msg => res.write(`data: ${JSON.stringify({ log: msg })}\n\n`);

  try {
    const app = await apps.installStatic(
      { userId: req.user.sub, domainId, installDir, archivePath }, ctx(req), send
    );
    audit(req, 'app_install', 'static', { installDir }, 'ok');
    res.write(`data: ${JSON.stringify({ done: true, app })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// DELETE /api/apps/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const send = msg => res.write(`data: ${JSON.stringify({ log: msg })}\n\n`);

  try {
    await apps.uninstall(row.id, ctx(req), send);
    audit(req, 'app_uninstall', row.app_type, { id: row.id }, 'ok');
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

module.exports = router;
