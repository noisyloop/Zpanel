const fs   = require('fs');
const path = require('path');
const shell = require('../../shell');
const db    = require('../../db');

const BACKUP_DIR  = process.env.BACKUP_DIR || '/var/backups/zpanel';
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '10', 10);

// ── Path safety ───────────────────────────────────────────────────────────────

function safeBackupPath(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(BACKUP_DIR + '/') && resolved !== BACKUP_DIR) {
    throw Object.assign(new Error('Backup path outside allowed directory'), { code: 'FORBIDDEN' });
  }
  return resolved;
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

async function backupFiles(userId, sourceDir, label, context = {}) {
  ensureBackupDir();

  const safe    = path.resolve(sourceDir);
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

async function backupDatabase(userId, dbName, label, context = {}) {
  ensureBackupDir();

  const host    = process.env.MYSQL_HOST      || '127.0.0.1';
  const port    = process.env.MYSQL_PORT      || '3306';
  const user    = process.env.MYSQL_ROOT_USER || 'root';
  const pass    = process.env.MYSQL_ROOT_PASS || '';
  const outFile = path.join(BACKUP_DIR, `db-${userId}-${timestamp()}.sql.gz`);

  // Validate dbName: must match the same rule as createDatabase
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(dbName)) throw new Error('Invalid database name');

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

async function restoreFiles(backupId, restoreDir, context = {}) {
  const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId);
  if (!backup || backup.type !== 'files') throw new Error('Backup not found');
  if (backup.status !== 'ok') throw new Error('Backup is not usable');

  safeBackupPath(backup.path); // ensure it's within BACKUP_DIR
  const safe = path.resolve(restoreDir);
  fs.mkdirSync(safe, { recursive: true });

  const result = await shell.run('tar', ['-xzf', backup.path, '-C', safe], context);
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
