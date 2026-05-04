const express = require('express');
const { requireAuth, requireAdmin, audit } = require('../../auth');
const domains = require('../domains/index');
const ssl     = require('./index');

const router = express.Router({ mergeParams: true });

// GET /api/domains/:domainId/ssl — cert status for domain
router.get('/', requireAuth, (req, res) => {
  const row = domains.get(parseInt(req.params.domainId, 10));
  if (!row) return res.status(404).json({ error: 'Domain not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const cert = ssl.getCert(row.domain);
  res.json({ domain: row.domain, cert: cert || null });
});

// POST /api/domains/:domainId/ssl — issue certificate
router.post('/', requireAuth, async (req, res) => {
  const row = domains.get(parseInt(req.params.domainId, 10));
  if (!row) return res.status(404).json({ error: 'Domain not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const email = req.body.email || process.env.CERTBOT_EMAIL;
  if (!email) return res.status(400).json({ error: 'email required (or set CERTBOT_EMAIL in env)' });

  try {
    const result = await ssl.issue(row.domain, email, { user: req.user.username, ip: req.ip });
    audit(req, 'ssl_issue', row.domain, { email }, 'ok');
    res.json(result);
  } catch (err) {
    audit(req, 'ssl_issue', row.domain, { email }, 'failed');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/domains/:domainId/ssl/renew — manually trigger renewal
router.post('/renew', requireAuth, async (req, res) => {
  const row = domains.get(parseInt(req.params.domainId, 10));
  if (!row) return res.status(404).json({ error: 'Domain not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await ssl.renew(row.domain, { user: req.user.username, ip: req.ip });
    audit(req, 'ssl_renew', row.domain, null, result.code === 0 ? 'ok' : 'failed');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ssl — list all certs (admin: all; user: own)
router.get('/all', requireAuth, (req, res) => {
  const certs = req.user.role === 'admin'
    ? ssl.listCerts()
    : ssl.listCerts(req.user.sub);
  res.json(certs);
});

module.exports = router;
