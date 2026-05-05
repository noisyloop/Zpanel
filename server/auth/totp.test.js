const os   = require('os');
const path = require('path');
const fs   = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpanel-totp-'));
process.env.DB_PATH            = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET         = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const auth = require('./index');
const totp = require('./totp');

// Seed a user
let userId;
beforeAll(() => {
  const r = auth.createUser('totpuser', 'password123', 'user');
  userId = r.lastInsertRowid;
});

// ── base32 codec ─────────────────────────────────────────────────────────────

describe('base32Encode / base32Decode', () => {
  test('round-trips arbitrary bytes', () => {
    const buf = Buffer.from([0x00, 0xff, 0x80, 0x01, 0xde, 0xad, 0xbe, 0xef]);
    const encoded = totp.base32Encode(buf);
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(totp.base32Decode(encoded)).toEqual(buf);
  });

  test('round-trips known RFC 4648 test vector', () => {
    // "foobar" → base32 = "MZXW6YTBOI======"
    const buf = Buffer.from('foobar');
    expect(totp.base32Encode(buf)).toBe('MZXW6YTBOI');
  });

  test('decode is case-insensitive', () => {
    const secret = totp.generateSecret();
    const decoded1 = totp.base32Decode(secret.toUpperCase());
    const decoded2 = totp.base32Decode(secret.toLowerCase());
    expect(decoded1).toEqual(decoded2);
  });

  test('throws on invalid character', () => {
    expect(() => totp.base32Decode('INVALID1!')).toThrow('Invalid base32');
  });
});

// ── HOTP ─────────────────────────────────────────────────────────────────────

describe('hotp', () => {
  // RFC 4226 Appendix D test vectors — secret = "12345678901234567890" as ASCII
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));

  test.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
  ])('counter %d → code %s', (counter, expected) => {
    expect(totp.hotp(secret, counter)).toBe(expected);
  });
});

// ── generateSecret / verifyCode ───────────────────────────────────────────────

describe('generateSecret', () => {
  test('produces a valid base32 string', () => {
    const s = totp.generateSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThan(10);
  });

  test('each call returns a unique secret', () => {
    const s1 = totp.generateSecret();
    const s2 = totp.generateSecret();
    expect(s1).not.toBe(s2);
  });
});

describe('verifyCode', () => {
  test('rejects an obviously wrong code', () => {
    const secret = totp.generateSecret();
    expect(totp.verifyCode(secret, '000000')).toBe(false);
    expect(totp.verifyCode(secret, '123456')).toBe(false);
  });

  test('accepts the current TOTP code for a known secret', () => {
    const secret  = totp.generateSecret();
    // Generate the correct code inline
    const counter = Math.floor(Date.now() / 1000 / 30);
    const code    = totp.hotp(secret, counter);
    expect(totp.verifyCode(secret, code)).toBe(true);
  });
});

// ── Backup codes ──────────────────────────────────────────────────────────────

describe('generateBackupCodes', () => {
  test('returns 8 codes', () => {
    const codes = totp.generateBackupCodes(userId);
    expect(codes).toHaveLength(8);
  });

  test('each code is 8 uppercase hex chars', () => {
    const codes = totp.generateBackupCodes(userId);
    codes.forEach(c => expect(c).toMatch(/^[0-9A-F]{8}$/));
  });

  test('all codes are unique', () => {
    const codes = totp.generateBackupCodes(userId);
    expect(new Set(codes).size).toBe(8);
  });
});

describe('consumeBackupCode', () => {
  test('accepts a valid unused code', () => {
    const codes = totp.generateBackupCodes(userId);
    expect(totp.consumeBackupCode(userId, codes[0])).toBe(true);
  });

  test('rejects a code that has already been used', () => {
    const codes = totp.generateBackupCodes(userId);
    totp.consumeBackupCode(userId, codes[0]);
    // Second use should fail
    expect(totp.consumeBackupCode(userId, codes[0])).toBe(false);
  });

  test('rejects a code that does not exist', () => {
    expect(totp.consumeBackupCode(userId, 'DEADBEEF')).toBe(false);
  });

  test('is case-insensitive', () => {
    const codes = totp.generateBackupCodes(userId);
    expect(totp.consumeBackupCode(userId, codes[0].toLowerCase())).toBe(true);
  });
});

// ── MFA tokens ───────────────────────────────────────────────────────────────

describe('issueMfaToken / consumeMfaToken', () => {
  test('issued token can be consumed once', () => {
    const token = totp.issueMfaToken(userId);
    expect(token).toMatch(/^[0-9a-f]{40}$/);
    const row = totp.consumeMfaToken(token);
    expect(row).not.toBeNull();
    expect(row.user_id).toBe(userId);
  });

  test('token cannot be consumed twice', () => {
    const token = totp.issueMfaToken(userId);
    totp.consumeMfaToken(token);
    expect(totp.consumeMfaToken(token)).toBeNull();
  });

  test('returns null for unknown token', () => {
    expect(totp.consumeMfaToken('deadbeefdeadbeef')).toBeNull();
  });
});
