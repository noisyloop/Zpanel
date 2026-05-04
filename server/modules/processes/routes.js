const express   = require('express');
const WebSocket = require('ws');
const { requireAuth, audit } = require('../../auth');
const pm2 = require('./index');

const router = express.Router();
const ctx    = req => ({ user: req.user.username, ip: req.ip });

// GET /api/processes — list all PM2 processes
router.get('/', requireAuth, async (req, res) => {
  try {
    const list = await pm2.list(ctx(req));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/processes/:name/start
router.post('/:name/start', requireAuth, async (req, res) => {
  try {
    await pm2.start(req.params.name, ctx(req));
    audit(req, 'pm2_start', req.params.name, null, 'ok');
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/processes/:name/stop
router.post('/:name/stop', requireAuth, async (req, res) => {
  try {
    await pm2.stop(req.params.name, ctx(req));
    audit(req, 'pm2_stop', req.params.name, null, 'ok');
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/processes/:name/restart
router.post('/:name/restart', requireAuth, async (req, res) => {
  try {
    await pm2.restart(req.params.name, ctx(req));
    audit(req, 'pm2_restart', req.params.name, null, 'ok');
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/processes/:name
router.delete('/:name', requireAuth, async (req, res) => {
  try {
    await pm2.remove(req.params.name, ctx(req));
    audit(req, 'pm2_delete', req.params.name, null, 'ok');
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/processes/save — pm2 save (persist process list)
router.post('/save', requireAuth, async (req, res) => {
  try {
    await pm2.save(ctx(req));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
