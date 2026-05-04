const express = require('express');
const { requireAuth, audit } = require('../../auth');
const email   = require('./index');
const domains = require('../domains/index');
const dns     = require('../dns');
const db      = require('../../db');

const router = express.Router();

const ctx = req => ({ user: req.user.username, ip: req.ip });

// ── Mailboxes ─────────────────────────────────────────────────────────────────

// GET /api/email/mailboxes
router.get('/mailboxes', requireAuth, (req, res) => {
  const list = req.user.role === 'admin'
    ? email.listAllMailboxes()
    : email.listMailboxes(req.user.sub);
  res.json(list);
});

// POST /api/email/mailboxes
router.post('/mailboxes', requireAuth, async (req, res) => {
  const { domainId, address, password, quotaMb } = req.body;
  if (!domainId || !address || !password) {
    return res.status(400).json({ error: 'domainId, address, password required' });
  }

  const domain = domains.get(parseInt(domainId, 10));
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  if (domain.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Ensure the email address belongs to this domain
  if (!address.endsWith(`@${domain.domain}`)) {
    return res.status(400).json({ error: `Address must end with @${domain.domain}` });
  }

  try {
    const box = await email.createMailbox(
      req.user.sub, domain.id, address, password, quotaMb || 500, ctx(req)
    );
    audit(req, 'mailbox_create', address, { quotaMb }, 'ok');
    res.status(201).json({ id: box.id, address: box.address, quota_mb: box.quota_mb });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/email/mailboxes/:id
router.delete('/mailboxes/:id', requireAuth, async (req, res) => {
  const box = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!box) return res.status(404).json({ error: 'Not found' });
  if (box.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await email.deleteMailbox(box.id, ctx(req));
    audit(req, 'mailbox_delete', box.address, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Aliases ───────────────────────────────────────────────────────────────────

// GET /api/email/aliases?domainId=
router.get('/aliases', requireAuth, (req, res) => {
  const domainId = parseInt(req.query.domainId, 10);
  if (!domainId) return res.status(400).json({ error: 'domainId required' });
  const domain = domains.get(domainId);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  if (domain.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(email.listAliases(domainId));
});

// POST /api/email/aliases
router.post('/aliases', requireAuth, (req, res) => {
  const { domainId, source, destination } = req.body;
  if (!domainId || !source || !destination) {
    return res.status(400).json({ error: 'domainId, source, destination required' });
  }
  const domain = domains.get(parseInt(domainId, 10));
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  if (domain.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const alias = email.createAlias(domain.id, source, destination);
    audit(req, 'alias_create', source, { destination }, 'ok');
    res.status(201).json(alias);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/email/aliases/:id
router.delete('/aliases/:id', requireAuth, (req, res) => {
  const alias = db.prepare('SELECT ea.*, d.user_id FROM email_aliases ea JOIN domains d ON d.id = ea.domain_id WHERE ea.id = ?')
    .get(parseInt(req.params.id, 10));
  if (!alias) return res.status(404).json({ error: 'Not found' });
  if (alias.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  email.deleteAlias(alias.id);
  audit(req, 'alias_delete', alias.source, null, 'ok');
  res.json({ ok: true });
});

// ── DKIM ──────────────────────────────────────────────────────────────────────

// POST /api/email/dkim — generate DKIM key pair for domain
router.post('/dkim', requireAuth, async (req, res) => {
  const { domainId, selector } = req.body;
  const domain = domains.get(parseInt(domainId, 10));
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  if (domain.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await email.generateDkimKey(domain.domain, selector || 'mail', ctx(req));
    audit(req, 'dkim_generate', domain.domain, { selector }, 'ok');

    // Optionally seed recommended DNS records
    const serverIp    = process.env.SERVER_IP || '127.0.0.1';
    const pubKeyValue = result.txtContent
      ? result.txtContent.replace(/\n|\t|"|\s{2,}/g, ' ').match(/p=[A-Za-z0-9+/=]+/)?.[0] || ''
      : '';
    const records = email.buildEmailDnsRecords(domain.domain, serverIp, pubKeyValue, selector || 'mail');

    res.json({ ...result, suggestedDnsRecords: records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email/config/:domainId — show postfix main.cf snippet
router.get('/config/:domainId', requireAuth, (req, res) => {
  const domain = domains.get(parseInt(req.params.domainId, 10));
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  const serverIp = process.env.SERVER_IP || '127.0.0.1';
  const snippet  = email.buildMainCfSnippet(`mail.${domain.domain}`);
  const dnsRecs  = email.buildEmailDnsRecords(domain.domain, serverIp, null);
  res.json({ mainCfSnippet: snippet, suggestedDnsRecords: dnsRecs });
});

module.exports = router;
