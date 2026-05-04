const express = require('express');
const { requireAuth, audit } = require('../../auth');
const cron = require('./index');
const db   = require('../../db');

const router = express.Router();

// GET /api/cron — list jobs for current user
router.get('/', requireAuth, (req, res) => {
  res.json(cron.listJobs(req.user.sub));
});

// POST /api/cron — create job
router.post('/', requireAuth, (req, res) => {
  const { systemUser, expression, command } = req.body;
  if (!systemUser || !expression || !command) {
    return res.status(400).json({ error: 'systemUser, expression, command required' });
  }
  // Security: user may only manage their own system username, not root
  if (systemUser === 'root') {
    return res.status(403).json({ error: 'Cannot manage root crontab' });
  }
  try {
    const job = cron.createJob(req.user.sub, systemUser, expression, command);
    audit(req, 'cron_create', systemUser, { expression, command }, 'ok');
    res.status(201).json(job);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/cron/:id — update job
router.put('/:id', requireAuth, (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const job = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const updated = cron.updateJob(id, req.body);
    audit(req, 'cron_update', job.system_user, { id }, 'ok');
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/cron/:id
router.delete('/:id', requireAuth, (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const job = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    cron.deleteJob(id);
    audit(req, 'cron_delete', job.system_user, { id }, 'ok');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cron/build — convert schedule fields to cron expression
router.post('/build', requireAuth, (req, res) => {
  try {
    const expr = cron.buildExpression(req.body);
    res.json({ expression: expr });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/cron/raw?user=<systemUser> — read raw crontab
router.get('/raw', requireAuth, (req, res) => {
  const systemUser = req.query.user;
  if (!systemUser || systemUser === 'root') {
    return res.status(400).json({ error: 'valid user required' });
  }
  try {
    const raw = cron.readCrontab(systemUser);
    res.json({ raw });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
