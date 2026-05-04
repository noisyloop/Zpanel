const fs   = require('fs');
const path = require('path');
const db   = require('../../db');

const ZONE_DIR = process.env.ZONE_DIR || '/etc/bind/zones';

// ── Record validation ─────────────────────────────────────────────────────────

const VALIDATORS = {
  A:     v => /^(\d{1,3}\.){3}\d{1,3}$/.test(v),
  AAAA:  v => /^[0-9a-fA-F:]+$/.test(v),
  CNAME: v => /^[a-zA-Z0-9._*-]+$/.test(v),
  MX:    v => /^[a-zA-Z0-9._-]+$/.test(v),
  TXT:   v => typeof v === 'string' && v.length <= 2048,
  NS:    v => /^[a-zA-Z0-9._-]+$/.test(v),
  SRV:   v => typeof v === 'string',
};

const NAME_RE = /^(@|\*|[a-zA-Z0-9_*]([a-zA-Z0-9_*-]{0,61}[a-zA-Z0-9_*])?)$/;

function validateRecord(type, name, value) {
  if (!VALIDATORS[type]) throw new Error(`Unsupported record type: ${type}`);
  if (!NAME_RE.test(name)) throw new Error(`Invalid record name: ${name}`);
  if (!VALIDATORS[type](value)) throw new Error(`Invalid ${type} record value: ${value}`);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function addRecord(domainId, type, name, value, ttl = 3600, priority = null) {
  validateRecord(type, name, value);
  const row = db.prepare(
    `INSERT INTO dns_records (domain_id, type, name, value, ttl, priority)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(domainId, type, name, value, ttl, priority);
  return db.prepare('SELECT * FROM dns_records WHERE id = ?').get(row.lastInsertRowid);
}

function updateRecord(id, fields) {
  const row = db.prepare('SELECT * FROM dns_records WHERE id = ?').get(id);
  if (!row) throw new Error('Record not found');
  const type  = fields.type  ?? row.type;
  const name  = fields.name  ?? row.name;
  const value = fields.value ?? row.value;
  validateRecord(type, name, value);
  db.prepare(
    `UPDATE dns_records SET type=?, name=?, value=?, ttl=?, priority=? WHERE id=?`
  ).run(type, name, value, fields.ttl ?? row.ttl, fields.priority ?? row.priority, id);
  return db.prepare('SELECT * FROM dns_records WHERE id = ?').get(id);
}

function deleteRecord(id) {
  db.prepare('DELETE FROM dns_records WHERE id = ?').run(id);
}

function listRecords(domainId) {
  return db.prepare(
    'SELECT * FROM dns_records WHERE domain_id = ? ORDER BY type, name'
  ).all(domainId);
}

// ── Zone file generation ──────────────────────────────────────────────────────

/**
 * Build a BIND9-compatible zone file string from a set of records.
 * `serial` is YYYYMMDDNN format, incremented on each write.
 */
function buildZoneFile(domain, adminEmail, records, serial) {
  const fqdn    = domain.endsWith('.') ? domain : `${domain}.`;
  const email   = (adminEmail || `hostmaster.${domain}`).replace('@', '.').replace(/\.?$/, '.');
  const soa = `\
$ORIGIN ${fqdn}
$TTL 3600
@   IN  SOA ns1.${domain}. ${email} (
        ${serial}   ; serial
        3600        ; refresh
        900         ; retry
        604800      ; expire
        300 )       ; negative TTL
`;

  const lines = records.map(r => {
    const name  = r.name === '@' ? '@' : r.name;
    const prio  = r.priority != null ? `${r.priority} ` : '';
    const value = r.value.endsWith('.') ? r.value : (
      ['MX','NS','CNAME'].includes(r.type) ? `${r.value}.` : r.value
    );
    const txtVal = r.type === 'TXT' ? `"${r.value}"` : value;
    return `${name.padEnd(20)} ${String(r.ttl).padEnd(8)} IN  ${r.type.padEnd(8)} ${prio}${r.type === 'TXT' ? txtVal : value}`;
  });

  return soa + '\n' + lines.join('\n') + '\n';
}

function makeSerial() {
  const now = new Date();
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  // Use seconds-of-day as the two-digit NN (capped at 99)
  const nn = String(Math.floor((now % 86400000) / 864000)).padStart(2, '0');
  return parseInt(d + nn, 10);
}

function writeZoneFile(domain, adminEmail, records) {
  fs.mkdirSync(ZONE_DIR, { recursive: true });
  const filePath = path.join(ZONE_DIR, `db.${domain}`);
  const serial   = makeSerial();
  const content  = buildZoneFile(domain, adminEmail, records, serial);
  fs.writeFileSync(filePath, content, { mode: 0o644 });
  return { filePath, serial };
}

function readZoneFile(domain) {
  const filePath = path.join(ZONE_DIR, `db.${domain}`);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function removeZoneFile(domain) {
  const filePath = path.join(ZONE_DIR, `db.${domain}`);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

module.exports = {
  addRecord, updateRecord, deleteRecord, listRecords,
  buildZoneFile, writeZoneFile, readZoneFile, removeZoneFile,
  validateRecord, makeSerial, ZONE_DIR,
};
