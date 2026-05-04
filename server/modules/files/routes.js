const express = require('express');
const multer  = require('multer');
const path    = require('path');
const os      = require('os');
const { requireAuth, audit } = require('../../auth');
const files = require('./index');

const router = express.Router();

// Multer: store in OS temp dir, enforce size limit, any mimetype
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '50', 10);
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// GET /api/files?path=...  — list directory
router.get('/', requireAuth, (req, res) => {
  const userPath = req.query.path || '/';
  try {
    const entries = files.listDir(userPath);
    audit(req, 'file_list', userPath, null, 'ok');
    res.json({ path: userPath, entries });
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/files/download?path=...  — stream file download
router.get('/download', requireAuth, (req, res) => {
  const userPath = req.query.path;
  if (!userPath) return res.status(400).json({ error: 'path required' });
  try {
    const { stream, stat, name } = files.readStream(userPath);
    audit(req, 'file_download', userPath, null, 'ok');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    stream.pipe(res);
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/files/upload?dir=...  — upload file to directory
router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  const destDir = req.query.dir || '/';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const saved = files.saveUpload(req.file.path, destDir, req.file.originalname);
    audit(req, 'file_upload', saved, { originalname: req.file.originalname }, 'ok');
    res.json({ ok: true, path: saved });
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/files/rename  — rename or move a file/dir
router.post('/rename', requireAuth, (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    files.rename(from, to);
    audit(req, 'file_rename', from, { to }, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /api/files?path=...  — delete file or directory
router.delete('/', requireAuth, (req, res) => {
  const userPath = req.query.path;
  if (!userPath) return res.status(400).json({ error: 'path required' });
  try {
    files.remove(userPath);
    audit(req, 'file_delete', userPath, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/files/mkdir?path=...  — create directory
router.post('/mkdir', requireAuth, (req, res) => {
  const userPath = req.query.path || req.body?.path;
  if (!userPath) return res.status(400).json({ error: 'path required' });
  try {
    files.mkdir(userPath);
    audit(req, 'file_mkdir', userPath, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
