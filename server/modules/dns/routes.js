const express = require('express');
const { requireAuth, audit } = require('../../auth');
const domains = require('../domains/index');
const dns     = require('./index');
const db      = require('../../db');

const router = express.Router({ mergeParams: true });

// Middleware — resolve domain and verify ownership
function resolveDomain(req, res, next) {
  const row = domains.get(parseInt(req.params.domainId, 10));
  if (!row) return res.status(404).json({ error: 'Domain not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.domain = row;
  next();
}

// GET /api/domains/:domainId/dns — list all records
router.get('/', requireAuth, resolveDomain, (req, res) => {
  const records = dns.listRecords(req.domain.id);
  const zone    = dns.readZoneFile(req.domain.domain);
  res.json({ records, zone });
});

// POST /api/domains/:domainId/dns — add record
router.post('/', requireAuth, resolveDomain, (req, res) => {
  const { type, name, value, ttl, priority } = req.body;
  if (!type || !name || !value) {
    return res.status(400).json({ error: 'type, name, value required' });
  }
  try {
    const record = dns.addRecord(req.domain.id, type.toUpperCase(), name, value, ttl, priority);
    const all    = dns.listRecords(req.domain.id);
    dns.writeZoneFile(req.domain.domain, req.user.username, all);
    audit(req, 'dns_add', req.domain.domain, { type, name, value }, 'ok');
    res.status(201).json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/domains/:domainId/dns/:recordId — update record
router.put('/:recordId', requireAuth, resolveDomain, (req, res) => {
  try {
    const record = dns.updateRecord(parseInt(req.params.recordId, 10), req.body);
    const all    = dns.listRecords(req.domain.id);
    dns.writeZoneFile(req.domain.domain, req.user.username, all);
    audit(req, 'dns_update', req.domain.domain, { recordId: req.params.recordId }, 'ok');
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/domains/:domainId/dns/:recordId — delete record
router.delete('/:recordId', requireAuth, resolveDomain, (req, res) => {
  try {
    dns.deleteRecord(parseInt(req.params.recordId, 10));
    const all = dns.listRecords(req.domain.id);
    dns.writeZoneFile(req.domain.domain, req.user.username, all);
    audit(req, 'dns_delete', req.domain.domain, { recordId: req.params.recordId }, 'ok');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/domains/:domainId/dns/zone — raw zone file
router.get('/zone', requireAuth, resolveDomain, (req, res) => {
  const zone = dns.readZoneFile(req.domain.domain) ||
    dns.buildZoneFile(req.domain.domain, req.user.username,
      dns.listRecords(req.domain.id), dns.makeSerial());
  res.type('text/plain').send(zone);
});

module.exports = router;
