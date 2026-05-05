const express = require('express');
const { requireAuth } = require('../../auth');
const notifications   = require('./index');

const router = express.Router();

// GET /api/notifications/prefs — get caller's notification preferences
router.get('/prefs', requireAuth, (req, res) => {
  res.json(notifications.getPrefs(req.user.sub));
});

// PUT /api/notifications/prefs — update preferences
router.put('/prefs', requireAuth, (req, res) => {
  const { email, notify_ssl_expiry, notify_deploy_fail, notify_quota_warn } = req.body;
  try {
    const prefs = notifications.setPrefs(req.user.sub, {
      email,
      notify_ssl_expiry:  notify_ssl_expiry  !== undefined ? (notify_ssl_expiry  ? 1 : 0) : undefined,
      notify_deploy_fail: notify_deploy_fail !== undefined ? (notify_deploy_fail ? 1 : 0) : undefined,
      notify_quota_warn:  notify_quota_warn  !== undefined ? (notify_quota_warn  ? 1 : 0) : undefined,
    });
    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/test — send a test notification to verify SMTP
router.post('/test', requireAuth, async (req, res) => {
  try {
    await notifications.notify(
      req.user.sub,
      'Test notification from Zpanel',
      'This is a test. If you received this, email notifications are working correctly.'
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
