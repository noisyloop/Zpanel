const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Redirect zone files and DB to temp locations
const tmpZones = fs.mkdtempSync(path.join(os.tmpdir(), 'zpanel-zones-'));
process.env.ZONE_DIR = tmpZones;
process.env.DB_PATH  = path.join(os.tmpdir(), `zpanel-test-dns-${Date.now()}.db`);

const db  = require('../../db');
const dns = require('./index');

// Create a test user + domain in DB so FK constraints are satisfied
let testDomainId;
beforeAll(() => {
  db.prepare("INSERT INTO users (username, password, role) VALUES ('dnstest', 'x', 'admin')").run();
  const userId = db.prepare("SELECT id FROM users WHERE username='dnstest'").get().id;
  db.prepare("INSERT INTO domains (user_id, domain, doc_root) VALUES (?, 'dns-test.com', '/var/www/dns-test.com')").run(userId);
  testDomainId = db.prepare("SELECT id FROM domains WHERE domain='dns-test.com'").get().id;
});

afterAll(() => {
  fs.rmSync(tmpZones, { recursive: true, force: true });
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* ignore */ }
});

describe('validateRecord', () => {
  test('accepts valid A record', () => {
    expect(() => dns.validateRecord('A', '@', '1.2.3.4')).not.toThrow();
  });
  test('accepts valid MX record', () => {
    expect(() => dns.validateRecord('MX', '@', 'mail.example.com')).not.toThrow();
  });
  test('accepts wildcard name', () => {
    expect(() => dns.validateRecord('A', '*', '1.2.3.4')).not.toThrow();
  });
  test('rejects bad IP for A record', () => {
    expect(() => dns.validateRecord('A', '@', 'not-an-ip')).toThrow();
  });
  test('rejects unsupported type', () => {
    expect(() => dns.validateRecord('PTR', '@', '1.2.3.4')).toThrow('Unsupported');
  });
  test('rejects invalid name with spaces', () => {
    expect(() => dns.validateRecord('A', 'bad name', '1.2.3.4')).toThrow('Invalid record name');
  });
});

describe('addRecord / listRecords / deleteRecord', () => {
  test('adds and retrieves a record', () => {
    const r = dns.addRecord(testDomainId, 'A', '@', '5.6.7.8', 3600);
    expect(r.type).toBe('A');
    expect(r.value).toBe('5.6.7.8');

    const list = dns.listRecords(testDomainId);
    expect(list.some(x => x.id === r.id)).toBe(true);
  });

  test('deletes a record', () => {
    const r = dns.addRecord(testDomainId, 'TXT', '@', 'v=spf1 include:mx ~all', 3600);
    dns.deleteRecord(r.id);
    const list = dns.listRecords(testDomainId);
    expect(list.some(x => x.id === r.id)).toBe(false);
  });
});

describe('buildZoneFile', () => {
  test('contains SOA and $ORIGIN', () => {
    const records = [
      { type: 'A',  name: '@',   value: '1.2.3.4',     ttl: 3600, priority: null },
      { type: 'MX', name: '@',   value: 'mail.test.com', ttl: 3600, priority: 10 },
      { type: 'TXT', name: '@',  value: 'v=spf1 ~all',  ttl: 3600, priority: null },
    ];
    const zone = dns.buildZoneFile('test.com', 'admin@test.com', records, 2026010101);
    expect(zone).toContain('$ORIGIN test.com.');
    expect(zone).toContain('SOA');
    expect(zone).toContain('2026010101');
    expect(zone).toContain('1.2.3.4');
    expect(zone).toContain('"v=spf1 ~all"');
    expect(zone).toContain('10 ');
  });

  test('writes zone file to disk', () => {
    const records = [{ type: 'A', name: '@', value: '9.9.9.9', ttl: 3600, priority: null }];
    const { filePath } = dns.writeZoneFile('disk-test.com', 'admin', records);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('9.9.9.9');
  });
});
