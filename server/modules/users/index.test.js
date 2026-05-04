const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Isolate DB for each test run
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpanel-users-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET         = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const usersModule = require('./index');

// ── validateUsername ─────────────────────────────────────────────────────────

describe('validateUsername', () => {
  test('accepts valid usernames', () => {
    expect(() => usersModule.validateUsername('alice')).not.toThrow();
    expect(() => usersModule.validateUsername('alice_123')).not.toThrow();
    expect(() => usersModule.validateUsername('bob-dev')).not.toThrow();
    expect(() => usersModule.validateUsername('a'.repeat(32))).not.toThrow();
  });

  test('rejects username shorter than 3 chars', () => {
    expect(() => usersModule.validateUsername('ab')).toThrow();
    expect(() => usersModule.validateUsername('')).toThrow();
  });

  test('rejects username longer than 32 chars', () => {
    expect(() => usersModule.validateUsername('a'.repeat(33))).toThrow();
  });

  test('rejects usernames with spaces or special chars', () => {
    expect(() => usersModule.validateUsername('bad user')).toThrow();
    expect(() => usersModule.validateUsername('user@domain')).toThrow();
    expect(() => usersModule.validateUsername('user;drop')).toThrow();
  });
});

// ── createUser ───────────────────────────────────────────────────────────────

describe('createUser', () => {
  test('creates a user and returns it without password', () => {
    const user = usersModule.createUser('testcreate', 'password123', 'user');
    expect(user.username).toBe('testcreate');
    expect(user.role).toBe('user');
    expect(user).not.toHaveProperty('password');
  });

  test('rejects password shorter than 8 chars', () => {
    expect(() => usersModule.createUser('pwtest', 'short', 'user')).toThrow('at least 8');
  });

  test('rejects invalid role', () => {
    expect(() => usersModule.createUser('roletest', 'password123', 'superadmin')).toThrow('Invalid role');
  });

  test('rejects duplicate username', () => {
    usersModule.createUser('dupuser', 'password123', 'user');
    expect(() => usersModule.createUser('dupuser', 'password456', 'user')).toThrow('already taken');
  });
});

// ── deleteUser ───────────────────────────────────────────────────────────────

describe('deleteUser', () => {
  test('deletes an existing user', () => {
    const created = usersModule.createUser('todelete', 'password123', 'user');
    expect(() => usersModule.deleteUser(created.id, 999)).not.toThrow();
  });

  test('throws when attempting to delete own account', () => {
    const user = usersModule.createUser('selfdelete', 'password123', 'user');
    expect(() => usersModule.deleteUser(user.id, user.id)).toThrow('Cannot delete your own account');
  });

  test('throws when user not found', () => {
    expect(() => usersModule.deleteUser(999999, 1)).toThrow('User not found');
  });
});

// ── changePassword ────────────────────────────────────────────────────────────

describe('changePassword', () => {
  test('accepts a valid new password', () => {
    const user = usersModule.createUser('pwchange', 'oldpassword', 'user');
    expect(() => usersModule.changePassword(user.id, 'newpassword123')).not.toThrow();
  });

  test('rejects password shorter than 8 chars', () => {
    const user = usersModule.createUser('pwshort', 'oldpassword', 'user');
    expect(() => usersModule.changePassword(user.id, 'short')).toThrow('at least 8');
  });
});

// ── changeRole ────────────────────────────────────────────────────────────────

describe('changeRole', () => {
  test('changes role to admin', () => {
    const user    = usersModule.createUser('promote', 'password123', 'user');
    const updated = usersModule.changeRole(user.id, 'admin', 999);
    expect(updated.role).toBe('admin');
  });

  test('rejects invalid role', () => {
    const user = usersModule.createUser('badrole', 'password123', 'user');
    expect(() => usersModule.changeRole(user.id, 'superadmin', 999)).toThrow('Invalid role');
  });

  test('throws when changing own role', () => {
    const user = usersModule.createUser('selfrole', 'password123', 'admin');
    expect(() => usersModule.changeRole(user.id, 'user', user.id)).toThrow('Cannot change your own role');
  });
});

// ── getResourceSummary ────────────────────────────────────────────────────────

describe('getResourceSummary', () => {
  test('returns zero counts for a user with no resources', () => {
    const user    = usersModule.createUser('emptyuser', 'password123', 'user');
    const summary = usersModule.getResourceSummary(user.id);
    expect(summary.domains).toBe(0);
    expect(summary.databases).toBe(0);
    expect(summary.mailboxes).toBe(0);
    expect(summary.ftp_accounts).toBe(0);
    expect(summary.cron_jobs).toBe(0);
    expect(summary.installed_apps).toBe(0);
    expect(summary.deploy_hooks).toBe(0);
    expect(summary.quota_mb).toBeNull();
  });
});
