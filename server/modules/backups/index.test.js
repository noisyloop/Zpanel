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

// ── safeSourceDir / safeRestoreDir / assertDatabaseOwnership ────────────────
// These guards prevent the Phase 6 audit findings:
//   - Vuln 1: backupFiles reading arbitrary host paths (e.g. /etc/shadow)
//   - Vuln 2: backupDatabase dumping other tenants' DBs
//   - Vuln 3: restoreFiles writing into /etc/cron.d, etc.

describe('safeSourceDir / safeRestoreDir', () => {
  const db          = require('../../db');
  const auth        = require('../../auth');
  // Re-require to access the un-exported helpers via the module surface
  const backupsMod  = require('./index');
  let userId;

  // We need to drive the guard via backupFiles itself since the helpers
  // are not exported. The guard must throw before tar runs.
  beforeAll(() => {
    const u = auth.createUser('pathuser', 'password123', 'user');
    userId = u.lastInsertRowid;
    // Give the user one owned domain
    db.prepare(
      "INSERT INTO domains (user_id, domain, doc_root) VALUES (?, ?, ?)"
    ).run(userId, 'pathuser-site.com', path.join(tmpDir, 'sites', 'pathuser'));
    fs.mkdirSync(path.join(tmpDir, 'sites', 'pathuser'), { recursive: true });
  });

  test('rejects /etc/shadow as source (Vuln 1)', async () => {
    await expect(
      backupsMod.backupFiles(userId, 'user', '/etc/shadow', 'evil')
    ).rejects.toThrow('not within an allowed path');
  });

  test('rejects /root as source (Vuln 1)', async () => {
    await expect(
      backupsMod.backupFiles(userId, 'user', '/root', 'evil')
    ).rejects.toThrow('not within an allowed path');
  });

  test('rejects another user\'s docroot as source (Vuln 1)', async () => {
    const other = auth.createUser('otherpath', 'password123', 'user');
    db.prepare(
      "INSERT INTO domains (user_id, domain, doc_root) VALUES (?, ?, ?)"
    ).run(other.lastInsertRowid, 'other-pathuser.com', path.join(tmpDir, 'sites', 'other'));

    await expect(
      backupsMod.backupFiles(userId, 'user', path.join(tmpDir, 'sites', 'other'), 'evil')
    ).rejects.toThrow('not within an allowed path');
  });

  test('rejects /etc/cron.d as restore destination (Vuln 3)', async () => {
    // Plant a fake "ok" backup row owned by the user
    const row = db.prepare(
      "INSERT INTO backups (user_id, type, label, path, status) VALUES (?, 'files', 'x', ?, 'ok')"
    ).run(userId, path.join(backupDir, 'fake.tar.gz'));

    await expect(
      backupsMod.restoreFiles(row.lastInsertRowid, userId, 'user', '/etc/cron.d')
    ).rejects.toThrow('not within an allowed path');
  });

  test('rejects restoring another user\'s backup (Vuln 3)', async () => {
    const other = auth.createUser('victim', 'password123', 'user');
    const row = db.prepare(
      "INSERT INTO backups (user_id, type, label, path, status) VALUES (?, 'files', 'x', ?, 'ok')"
    ).run(other.lastInsertRowid, path.join(backupDir, 'victim.tar.gz'));

    await expect(
      backupsMod.restoreFiles(row.lastInsertRowid, userId, 'user', path.join(tmpDir, 'sites', 'pathuser'))
    ).rejects.toThrow('Forbidden');
  });

  test('rejects dumping a database the user does not own (Vuln 2)', async () => {
    const other = auth.createUser('dbowner', 'password123', 'user');
    db.prepare("INSERT INTO databases (user_id, db_name, db_user) VALUES (?, ?, ?)")
      .run(other.lastInsertRowid, 'victims_db', 'victims_user');

    await expect(
      backupsMod.backupDatabase(userId, 'user', 'victims_db', 'evil')
    ).rejects.toThrow('Database not found');
  });

  test('rejects dumping the mysql system database (Vuln 2)', async () => {
    await expect(
      backupsMod.backupDatabase(userId, 'user', 'mysql', 'evil')
    ).rejects.toThrow('Database not found');
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
