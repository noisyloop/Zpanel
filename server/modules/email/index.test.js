const os   = require('os');
const path = require('path');

process.env.DB_PATH              = path.join(os.tmpdir(), `zpanel-test-email-${Date.now()}.db`);
process.env.VIRTUAL_MAILBOX_BASE = path.join(os.tmpdir(), 'zpanel-vmail-test');
process.env.POSTFIX_DIR          = path.join(os.tmpdir(), 'zpanel-postfix-test');
process.env.DKIM_DIR             = path.join(os.tmpdir(), 'zpanel-dkim-test');

const email = require('./index');

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* ignore */ }
});

describe('validateAddress', () => {
  test('accepts valid addresses', () => {
    expect(() => email.validateAddress('user@example.com')).not.toThrow();
    expect(() => email.validateAddress('user+tag@sub.example.org')).not.toThrow();
  });

  test('rejects invalid addresses', () => {
    expect(() => email.validateAddress('notanemail')).toThrow('Invalid email');
    expect(() => email.validateAddress('@nodomain.com')).toThrow('Invalid email');
    expect(() => email.validateAddress('user@')).toThrow('Invalid email');
    expect(() => email.validateAddress('')).toThrow('Invalid email');
  });

  test('normalises to lowercase', () => {
    expect(email.validateAddress('User@EXAMPLE.COM')).toBe('user@example.com');
  });
});

describe('buildEmailDnsRecords', () => {
  test('returns five records', () => {
    const recs = email.buildEmailDnsRecords('example.com', '1.2.3.4', 'v=DKIM1; k=rsa; p=ABC');
    expect(recs).toHaveLength(5);
    const types = recs.map(r => r.type);
    expect(types).toContain('MX');
    expect(types).toContain('TXT');
    expect(types).toContain('A');
  });

  test('SPF record contains server IP', () => {
    const recs = email.buildEmailDnsRecords('example.com', '5.6.7.8', null);
    const spf  = recs.find(r => r.type === 'TXT' && r.name === '@');
    expect(spf.value).toContain('5.6.7.8');
  });

  test('DMARC record present', () => {
    const recs  = email.buildEmailDnsRecords('example.com', '1.2.3.4', null);
    const dmarc = recs.find(r => r.name === '_dmarc');
    expect(dmarc.value).toContain('v=DMARC1');
  });
});

describe('buildMainCfSnippet', () => {
  test('contains virtual_mailbox_base', () => {
    const snippet = email.buildMainCfSnippet('mail.example.com');
    expect(snippet).toContain('virtual_mailbox_base');
    expect(snippet).toContain('mail.example.com');
  });
});
