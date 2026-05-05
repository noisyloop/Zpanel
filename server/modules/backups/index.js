const fs   = require('fs');
const path = require('path');
const shell = require('../../shell');
const db    = require('../../db');

const BACKUP_DIR  = process.env.BACKUP_DIR || '/var/backups/zpanel';
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '10', 10);
const VHOST_ROOT  = process.env.VHOST_ROOT || '/var/www';
const HOME_BASE   = process.env.HOME_BASE  || '/home/zpanel-users';

// ── Path safety ───────────────────────────────────────────────────────────────

function safeBackupPath(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(BACKUP_DIR + '/') && resolved !== BACKUP_DIR) {
    throw Object.assign(new Error('Backup path outside allowed directory'), { code: 'FORBIDDEN' });
  }
  return resolved;
}

// Safe SOURCE for a per-user backup. Allows:
//  • the user's domain document roots (rows in `domains` joined by user_id)
//  • the user's system home directory (system_users.home_dir, if provisioned)
// Admins bypass with explicit allowlist of VHOST_ROOT and HOME_BASE.
function safeSourceDir(userId, role, sourceDir) {
  const resolved = path.resolve(sourceDir);

  const allowed = new Set();
  if (role === 'admin') {
    allowed.add(VHOST_ROOT);
    allowed.add(HOME_BASE);
  }

  // Per-user docroots
  const docroots = db.prepare('SELECT doc_root FROM domains WHERE user_id = ?').all(userId);
  for (const r of docroots) allowed.add(path.resolve(r.doc_root));

  // Per-user home directory
  const sysUser = db.prepare('SELECT home_dir FROM system_users WHERE user_id = ?').get(userId);
  if (sysUser?.home_dir) allowed.add(path.resolve(sysUser.home_dir));

  for (const root of allowed) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }

  throw Object.assign(
    new Error('Source directory is not within an allowed path for this user'),
    { code: 'FORBIDDEN' },
  );
}

// Safe RESTORE destination — same allowlist as the source.
// This is the critical guard: without it, restore can extract a tarball
// into /etc/cron.d, /root/.ssh, etc.
function safeRestoreDir(userId, role, restoreDir) {
  return safeSourceDir(userId, role, restoreDir);
}

// Verify that a database name belongs to the requesting user (admins bypass).
function assertDatabaseOwnership(userId, role, dbName) {
  if (role === 'admin') return true;
  const owned = db.prepare('SELECT id FROM databases WHERE user_id = ? AND db_name = ?').get(userId, dbName);
  if (!owned) {
    throw Object.assign(new Error('Database not found'), { code: 'NOT_FOUND' });
  }
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Enforce retention: delete oldest rows + files beyond MAX_BACKUPS per user+type
function enforceRetention(userId, type) {
  const rows = db.prepare(
    'SELECT * FROM backups WHERE user_id = ? AND type = ? ORDER BY id DESC'
  ).all(userId, type);

  const toDelete = rows.slice(MAX_BACKUPS);
  for (const row of toDelete) {
    try { fs.unlinkSync(row.path); } catch { /* already gone */ }
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
  }
}

// ── File backup ───────────────────────────────────────────────────────────────
// Creates a gzipped tar archive of `sourceDir` into BACKUP_DIR.

async function backupFiles(userId, role, sourceDir, label, context = {}) {
  ensureBackupDir();

  // SECURITY: source must belong to this user (or admin) — prevents arbitrary
  // file read of /etc/shadow, /root/.ssh, other tenants' data, etc.
  const safe    = safeSourceDir(userId, role, sourceDir);
  const outFile = path.join(BACKUP_DIR, `files-${userId}-${timestamp()}.tar.gz`);
  const row     = db.prepare(
    "INSERT INTO backups (user_id, type, label, path, status) VALUES (?, 'files', ?, ?, 'pending')"
  ).run(userId, label, outFile);
  const id = row.lastInsertRowid;

  try {
    const result = await shell.run('tar', ['-czf', outFile, '-C', path.dirname(safe), path.basename(safe)], context);
    if (result.code !== 0) throw new Error(`tar failed: ${result.stderr}`);

    const { size } = fs.statSync(outFile);
    db.prepare("UPDATE backups SET status='ok', size_bytes=? WHERE id=?").run(size, id);
    enforceRetention(userId, 'files');
    return db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  } catch (err) {
    db.prepare("UPDATE backups SET status='failed' WHERE id=?").run(id);
    throw err;
  }
}

// ── Database backup ───────────────────────────────────────────────────────────
// Dumps a MySQL database using mysqldump.

async function backupDatabase(userId, role, dbName, label, context = {}) {
  ensureBackupDir();

  const host    = process.env.MYSQL_HOST      || '127.0.0.1';
  const port    = process.env.MYSQL_PORT      || '3306';
  const user    = process.env.MYSQL_ROOT_USER || 'root';
  const pass    = process.env.MYSQL_ROOT_PASS || '';
  const outFile = path.join(BACKUP_DIR, `db-${userId}-${timestamp()}.sql.gz`);

  // Validate dbName format: must match the same rule as createDatabase
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(dbName)) throw new Error('Invalid database name');

  // SECURITY: verify the user owns this database before dumping with root creds.
  // Without this check, any panel user could dump `mysql`, other tenants' DBs, etc.
  assertDatabaseOwnership(userId, role, dbName);

  const row = db.prepare(
    "INSERT INTO backups (user_id, type, label, path, status) VALUES (?, 'database', ?, ?, 'pending')"
  ).run(userId, label, outFile);
  const id = row.lastInsertRowid;

  try {
    const args = [
      `--host=${host}`, `--port=${port}`, `--user=${user}`,
      pass ? `--password=${pass}` : '--no-tablespaces',
      '--single-transaction', '--quick', '--routines',
      '--result-file', outFile, dbName,
    ];
    const result = await shell.run('mysqldump', args, context);
    if (result.code !== 0) throw new Error(`mysqldump failed: ${result.stderr}`);

    const { size } = fs.statSync(outFile);
    db.prepare("UPDATE backups SET status='ok', size_bytes=? WHERE id=?").run(size, id);
    enforceRetention(userId, 'database');
    return db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  } catch (err) {
    db.prepare("UPDATE backups SET status='failed' WHERE id=?").run(id);
    throw err;
  }
}

// ── Restore ───────────────────────────────────────────────────────────────────

async function restoreFiles(backupId, userId, role, restoreDir, context = {}) {
  const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId);
  if (!backup || backup.type !== 'files') throw new Error('Backup not found');
  if (backup.status !== 'ok')             throw new Error('Backup is not usable');

  // SECURITY: only the backup owner (or an admin) may restore.
  if (backup.user_id !== userId && role !== 'admin') {
    throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });
  }

  safeBackupPath(backup.path);                                  // archive lives in BACKUP_DIR
  const safe = safeRestoreDir(userId, role, restoreDir);        // destination is in user's tree
  fs.mkdirSync(safe, { recursive: true });

  // Use safe extraction flags: don't honour stored owners, ACLs, or xattrs;
  // refuse to follow symlinks pointing outside the destination.
  const result = await shell.run('tar', [
    '-xzf', backup.path,
    '-C', safe,
    '--no-same-owner',
    '--no-overwrite-dir',
  ], context);
  if (result.code !== 0) throw new Error(`Restore failed: ${result.stderr}`);
  return { ok: true, restored_to: safe };
}

// ── CRUD helpers ──────────────────────────────────────────────────────────────

function listBackups(userId) {
  return db.prepare('SELECT * FROM backups WHERE user_id = ? ORDER BY id DESC').all(userId);
}

function deleteBackup(id, userId) {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  if (!row) throw new Error('Backup not found');

  // Allow admins to delete any backup; users only their own
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (row.user_id !== userId && user?.role !== 'admin') {
    throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });
  }

  try { fs.unlinkSync(row.path); } catch { /* already gone */ }
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  return row;
}

module.exports = {
  backupFiles, backupDatabase, restoreFiles,
  listBackups, deleteBackup, safeBackupPath,
  BACKUP_DIR,
};
