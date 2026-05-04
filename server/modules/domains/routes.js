const express = require('express');
const { requireAuth, requireAdmin, audit } = require('../../auth');
const domains = require('./index');
const vhost   = require('./vhost');
const dns     = require('../dns');
const db      = require('../../db');

const router = express.Router();

// GET /api/domains — list domains for current user (admin sees all)
router.get('/', requireAuth, (req, res) => {
  const rows = req.user.role === 'admin'
    ? domains.listAll()
    : domains.list(req.user.sub);
  res.json(rows);
});

// POST /api/domains — add domain + deploy vhost
router.post('/', requireAuth, async (req, res) => {
  const { domain, docRoot } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });

  try {
    vhost.safeDomain(domain);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (domains.getByDomain(domain)) {
    return res.status(409).json({ error: 'Domain already exists' });
  }

  const username = req.user.username;
  let row;
  try {
    row = domains.create(req.user.sub, username, domain, { docRoot });
    audit(req, 'domain_create', domain, { docRoot: row.doc_root }, 'ok');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Deploy vhost (best-effort — panel works even without nginx available in dev)
  let vhostWarning = null;
  try {
    await vhost.deployVhost(domain, row.doc_root, {}, {
      user: req.user.username,
      ip:   req.ip,
    });
  } catch (err) {
    vhostWarning = err.message;
  }

  // Seed default DNS records (A record placeholder)
  try {
    const serverIp = process.env.SERVER_IP || '127.0.0.1';
    dns.addRecord(row.id, 'A', '@', serverIp, 3600);
    dns.addRecord(row.id, 'A', 'www', serverIp, 3600);
    dns.writeZoneFile(domain, req.user.username, db.prepare('SELECT * FROM dns_records WHERE domain_id = ?').all(row.id));
  } catch { /* non-fatal — zone generation optional */ }

  res.status(201).json({ domain: row, vhostWarning });
});

// DELETE /api/domains/:id — remove domain, vhost, DNS zone
router.delete('/:id', requireAuth, async (req, res) => {
  const row = domains.get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await vhost.removeVhost(row.domain, { user: req.user.username, ip: req.ip });
  } catch { /* best-effort */ }

  try { dns.removeZoneFile(row.domain); } catch { /* best-effort */ }

  domains.remove(row.id);
  audit(req, 'domain_delete', row.domain, null, 'ok');
  res.json({ ok: true });
});

// GET /api/domains/:id/vhost — show generated nginx config
router.get('/:id/vhost', requireAuth, (req, res) => {
  const row = domains.get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const config = vhost.readVhostFile(row.domain) ||
    vhost.buildVhostConfig(row.domain, row.doc_root);
  res.json({ domain: row.domain, config });
});

// POST /api/domains/:id/subdomains — create a subdomain under this domain
router.post('/:id/subdomains', requireAuth, async (req, res) => {
  const parent = domains.get(parseInt(req.params.id, 10));
  if (!parent) return res.status(404).json({ error: 'Parent domain not found' });
  if (parent.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { subdomain, docRoot, wildcard } = req.body;
  if (!subdomain) return res.status(400).json({ error: 'subdomain required' });

  const fullDomain = wildcard ? `*.${parent.domain}` : `${subdomain}.${parent.domain}`;

  try { vhost.safeDomain(wildcard ? parent.domain : fullDomain); } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (domains.getByDomain(fullDomain)) {
    return res.status(409).json({ error: 'Subdomain already exists' });
  }

  const username = req.user.username;
  const defaultRoot = require('path').join(
    vhost.VHOST_ROOT, username, parent.domain, subdomain
  );

  let row;
  try {
    row = domains.create(req.user.sub, username, fullDomain, {
      docRoot: docRoot || defaultRoot,
      isSubdomain: true,
      parentDomain: parent.domain,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Add DNS A record for subdomain
  try {
    const serverIp = process.env.SERVER_IP || '127.0.0.1';
    const recordName = wildcard ? '*' : subdomain;
    dns.addRecord(parent.id, 'A', recordName, serverIp, 3600);
    const allRecords = db.prepare('SELECT * FROM dns_records WHERE domain_id = ?').all(parent.id);
    dns.writeZoneFile(parent.domain, username, allRecords);
  } catch { /* non-fatal */ }

  let vhostWarning = null;
  try {
    await vhost.deployVhost(fullDomain, row.doc_root, {}, { user: username, ip: req.ip });
  } catch (err) { vhostWarning = err.message; }

  audit(req, 'subdomain_create', fullDomain, { parent: parent.domain }, 'ok');
  res.status(201).json({ domain: row, vhostWarning });
});

module.exports = router;
