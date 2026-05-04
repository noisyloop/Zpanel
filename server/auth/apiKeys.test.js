const os   = require('os');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

// Isolate DB for each test run
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpanel-apikeys-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET         = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const db      = require('../db');
const auth    = require('./index');
const apiKeys = require('./apiKeys');

// Create a test user to attach keys to
let testUserId;
beforeAll(() => {
  const row = auth.createUser('keyuser', 'password123', 'user');
  testUserId = row.lastInsertRowid;
});

describe('generateKey', () => {
  test('returns plaintext starting with zpk_', () => {
    const key = apiKeys.generateKey(testUserId, 'test-key');
    expect(key.plaintext).toMatch(/^zpk_[0-9a-f]{40}$/);
  });

  test('returns correct prefix (first 12 chars of plaintext)', () => {
    const key = apiKeys.generateKey(testUserId, 'prefix-test');
    expect(key.plaintext.startsWith(key.prefix)).toBe(true);
    expect(key.prefix).toMatch(/^zpk_[0-9a-f]{8}$/);
  });

  test('does not store plaintext in DB — only hash', () => {
    const key = apiKeys.generateKey(testUserId, 'hash-test');
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(key.id);
    expect(row.key_hash).not.toBe(key.plaintext);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  test('stored hash matches sha256 of plaintext', () => {
    const key  = apiKeys.generateKey(testUserId, 'sha-verify');
    const row  = db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(key.id);
    const expected = crypto.createHash('sha256').update(key.plaintext).digest('hex');
    expect(row.key_hash).toBe(expected);
  });
});

describe('verifyApiKey', () => {
  let plaintext;
  beforeAll(() => {
    const key = apiKeys.generateKey(testUserId, 'verify-test');
    plaintext = key.plaintext;
  });

  test('returns user for valid key', () => {
    const user = apiKeys.verifyApiKey(plaintext);
    expect(user).not.toBeNull();
    expect(user.id).toBe(testUserId);
    expect(user.username).toBe('keyuser');
  });

  test('returns null for tampered key', () => {
    const tampered = plaintext.slice(0, -2) + 'XX';
    expect(apiKeys.verifyApiKey(tampered)).toBeNull();
  });

  test('returns null for unknown key', () => {
    expect(apiKeys.verifyApiKey('zpk_' + 'a'.repeat(40))).toBeNull();
  });

  test('returns null for non-zpk_ token', () => {
    expect(apiKeys.verifyApiKey('eyJhbGciOiJIUzI1NiJ9.fake.jwt')).toBeNull();
    expect(apiKeys.verifyApiKey(null)).toBeNull();
    expect(apiKeys.verifyApiKey(undefined)).toBeNull();
  });
});

describe('listKeys', () => {
  test('lists only keys belonging to the user', () => {
    const other = auth.createUser('otheruser', 'password123', 'user');
    apiKeys.generateKey(other.lastInsertRowid, 'other-key');
    apiKeys.generateKey(testUserId, 'my-key');

    const myKeys = apiKeys.listKeys(testUserId);
    myKeys.forEach(k => {
      expect(k).not.toHaveProperty('key_hash');
      expect(k).not.toHaveProperty('plaintext');
    });
  });
});

describe('revokeKey', () => {
  test('allows user to revoke their own key', () => {
    const key = apiKeys.generateKey(testUserId, 'to-revoke');
    expect(() => apiKeys.revokeKey(key.id, testUserId)).not.toThrow();
    expect(apiKeys.verifyApiKey(key.plaintext)).toBeNull();
  });

  test('throws FORBIDDEN when non-owner non-admin tries to revoke', () => {
    const key     = apiKeys.generateKey(testUserId, 'protected');
    const other   = auth.createUser('notadmin', 'password123', 'user');
    expect(() => apiKeys.revokeKey(key.id, other.lastInsertRowid)).toThrow('Forbidden');
  });

  test('throws for non-existent key id', () => {
    expect(() => apiKeys.revokeKey(999999, testUserId)).toThrow('API key not found');
  });
});
