const express = require('express');
const { requireAuth, requireAdmin, audit } = require('../../auth');
const isolation = require('./index');

const router = express.Router();
const ctx    = req => ({ user: req.user.username, ip: req.ip });

// GET /api/isolation/me — current user's system user + quota
router.get('/me', requireAuth, async (req, res) => {
  const sysUser = isolation.getSystemUser(req.user.sub);
  if (!sysUser) return res.json({ systemUser: null });
  const quota = await isolation.getQuota(req.user.sub, ctx(req));
  res.json({ systemUser: sysUser, quota });
});

// POST /api/isolation/provision — create system user for current account
router.post('/provision', requireAuth, async (req, res) => {
  const { quotaMb } = req.body;
  try {
    const sysUser = await isolation.createSystemUser(
      req.user.sub, req.user.username, quotaMb || 2048, ctx(req)
    );
    audit(req, 'sysuser_create', sysUser.system_user, { quotaMb }, 'ok');
    res.status(201).json(sysUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/isolation/quota — update quota for current user
router.put('/quota', requireAuth, async (req, res) => {
  const { quotaMb } = req.body;
  if (!quotaMb || quotaMb < 1) return res.status(400).json({ error: 'quotaMb must be > 0' });
  try {
    const row = await isolation.setQuota(req.user.sub, quotaMb, ctx(req));
    audit(req, 'quota_update', req.user.username, { quotaMb }, 'ok');
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/isolation/users — admin: list all system users
router.get('/users', requireAdmin, (req, res) => {
  res.json(isolation.listAllSystemUsers());
});

// DELETE /api/isolation/:userId — admin: remove system user
router.delete('/:userId', requireAdmin, async (req, res) => {
  try {
    const row = await isolation.deleteSystemUser(parseInt(req.params.userId, 10), ctx(req));
    if (!row) return res.status(404).json({ error: 'Not found' });
    audit(req, 'sysuser_delete', row.system_user, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
