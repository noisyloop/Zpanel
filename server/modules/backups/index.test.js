const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Wire up temp dirs BEFORE requiring the module
const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'zpanel-backups-'));
const backupDir = path.join(tmpDir, 'backups');
process.env.DB_PATH    = path.join(tmpDir, 'test.db');
process.env.BACKUP_DIR = backupDir;
process.env.JWT_SECRET         = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const backups = require('./index');

// ── safeBackupPath ────────────────────────────────────────────────────────────

describe('safeBackupPath', () => {
  test('accepts a path inside BACKUP_DIR', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const p = path.join(backupDir, 'file.tar.gz');
    expect(backups.safeBackupPath(p)).toBe(p);
  });

  test('accepts BACKUP_DIR itself', () => {
    expect(backups.safeBackupPath(backupDir)).toBe(backupDir);
  });

  test('rejects path traversal outside BACKUP_DIR', () => {
    expect(() => backups.safeBackupPath('/etc/passwd')).toThrow('outside allowed directory');
  });

  test('rejects ../ escape', () => {
    const escape = path.join(backupDir, '../escape');
    expect(() => backups.safeBackupPath(escape)).toThrow('outside allowed directory');
  });
});

// ── listBackups / deleteBackup ────────────────────────────────────────────────

describe('listBackups', () => {
  const db   = require('../../db');
  const auth = require('../../auth');
  let userId;

  beforeAll(() => {
    const u = auth.createUser('backupuser', 'password123', 'user');
    userId = u.lastInsertRowid;
    fs.mkdirSync(backupDir, { recursive: true });

    // Insert a fake backup row directly
    db.prepare(
      "INSERT INTO backups (user_id, type, label, path, status) VALUES (?, 'files', 'test-backup', ?, 'ok')"
    ).run(userId, path.join(backupDir, 'fake.tar.gz'));
  });

  test('returns backups for the correct user', () => {
    const rows = backups.listBackups(userId);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(r => expect(r.user_id).toBe(userId));
  });

  test('returns empty array for user with no backups', () => {
    const u2 = auth.createUser('nobackups', 'password123', 'user');
    expect(backups.listBackups(u2.lastInsertRowid)).toHaveLength(0);
  });
});

describe('deleteBackup', () => {
  const db   = require('../../db');
  const auth = require('../../auth');
  let userId, otherId;

  beforeAll(() => {
    const u1 = auth.createUser('delowner', 'password123', 'user');
    const u2 = auth.createUser('delother', 'password123', 'user');
    userId  = u1.lastInsertRowid;
    otherId = u2.lastInsertRowid;
  });

  test('owner can delete their own backup', () => {
    const row = db.prepare(
      "INSERT INTO backups (user_id, type, label, path, status) VALUES (?, 'files', 'del-test', ?, 'ok')"
    ).run(userId, path.join(backupDir, 'del-test.tar.gz'));
    expect(() => backups.deleteBackup(row.lastInsertRowid, userId)).not.toThrow();
  });

  test('non-owner non-admin cannot delete', () => {
    const row = db.prepare(
      "INSERT INTO backups (user_id, type, label, path, status) VALUES (?, 'files', 'protected', ?, 'ok')"
    ).run(userId, path.join(backupDir, 'protected.tar.gz'));
    expect(() => backups.deleteBackup(row.lastInsertRowid, otherId)).toThrow('Forbidden');
  });

  test('throws for non-existent backup', () => {
    expect(() => backups.deleteBackup(999999, userId)).toThrow('Backup not found');
  });
});
