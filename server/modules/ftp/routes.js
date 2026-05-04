const express = require('express');
const { requireAuth, audit } = require('../../auth');
const ftp = require('./index');
const db  = require('../../db');

const router = express.Router();

// GET /api/ftp
router.get('/', requireAuth, (req, res) => {
  const list = req.user.role === 'admin'
    ? ftp.listAllAccounts()
    : ftp.listAccounts(req.user.sub);
  res.json(list);
});

// POST /api/ftp
router.post('/', requireAuth, async (req, res) => {
  const { ftpUser, password, chrootDir } = req.body;
  if (!ftpUser || !password || !chrootDir) {
    return res.status(400).json({ error: 'ftpUser, password, chrootDir required' });
  }
  try {
    const account = await ftp.createAccount(req.user.sub, ftpUser, password, chrootDir);
    audit(req, 'ftp_create', ftpUser, { chrootDir }, 'ok');
    res.status(201).json(account);
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /api/ftp/:id
router.delete('/:id', requireAuth, (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM ftp_accounts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    ftp.deleteAccount(id);
    audit(req, 'ftp_delete', row.ftp_user, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ftp/config — show vsftpd.conf snippet
router.get('/config', requireAuth, (req, res) => {
  res.json({ config: ftp.buildVsftpdSnippet() });
});

module.exports = router;
