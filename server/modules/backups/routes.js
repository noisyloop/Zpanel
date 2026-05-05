const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { requireAuth, requireAdmin, audit } = require('../../auth');
const backups = require('./index');

const router = express.Router();

// GET /api/backups — list caller's backups (admin sees all)
router.get('/', requireAuth, (req, res) => {
  try {
    const rows = req.user.role === 'admin'
      ? require('../../db').prepare('SELECT * FROM backups ORDER BY id DESC').all()
      : backups.listBackups(req.user.sub);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backups/files — trigger a file backup
router.post('/files', requireAuth, async (req, res) => {
  const { sourceDir, label } = req.body;
  if (!sourceDir) return res.status(400).json({ error: 'sourceDir required' });
  try {
    const backup = await backups.backupFiles(req.user.sub, sourceDir, label || sourceDir, { user: req.user.username, ip: req.ip });
    audit(req, 'backup_files', sourceDir, null, 'ok');
    res.status(201).json(backup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backups/database — trigger a DB dump
router.post('/database', requireAuth, async (req, res) => {
  const { dbName, label } = req.body;
  if (!dbName) return res.status(400).json({ error: 'dbName required' });
  try {
    const backup = await backups.backupDatabase(req.user.sub, dbName, label || dbName, { user: req.user.username, ip: req.ip });
    audit(req, 'backup_database', dbName, null, 'ok');
    res.status(201).json(backup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backups/:id/restore — restore a file backup
router.post('/:id/restore', requireAuth, async (req, res) => {
  const { restoreDir } = req.body;
  if (!restoreDir) return res.status(400).json({ error: 'restoreDir required' });
  try {
    const result = await backups.restoreFiles(parseInt(req.params.id, 10), restoreDir, { user: req.user.username, ip: req.ip });
    audit(req, 'backup_restore', req.params.id, { restoreDir }, 'ok');
    res.json(result);
  } catch (err) {
    const status = err.message === 'Backup not found' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/backups/:id/download — stream the backup file
router.get('/:id/download', requireAuth, (req, res) => {
  try {
    const db   = require('../../db');
    const row  = db.prepare('SELECT * FROM backups WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ error: 'Backup not found' });
    if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    backups.safeBackupPath(row.path); // security: verify it's in BACKUP_DIR
    if (!fs.existsSync(row.path)) return res.status(404).json({ error: 'Backup file missing' });

    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(row.path)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(row.path).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/backups/:id
router.delete('/:id', requireAuth, (req, res) => {
  try {
    backups.deleteBackup(parseInt(req.params.id, 10), req.user.sub);
    audit(req, 'backup_deleted', req.params.id, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : err.message === 'Backup not found' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
