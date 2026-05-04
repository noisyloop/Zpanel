const fs    = require('fs');
const path  = require('path');
const shell = require('../../shell');
const db    = require('../../db');

const HOME_BASE  = process.env.HOME_BASE  || '/home/zpanel-users';
const QUOTA_FS   = process.env.QUOTA_FS   || '/';

// ── System user name derivation ───────────────────────────────────────────────
// Panel username → safe Linux username: lowercase, max 32, alphanumeric+underscore.

function deriveSystemUser(panelUsername) {
  const safe = panelUsername.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  return `zp_${safe}`;
}

// ── Create Linux system user ──────────────────────────────────────────────────

async function createSystemUser(userId, panelUsername, quotaMb = 2048, context = {}) {
  const existing = db.prepare('SELECT * FROM system_users WHERE user_id = ?').get(userId);
  if (existing) return existing;

  const sysUser = deriveSystemUser(panelUsername);
  const homeDir = path.join(HOME_BASE, sysUser);

  // useradd -m creates the home directory
  const result = await shell.run('useradd', [
    '-m', '-d', homeDir, '-s', '/usr/sbin/nologin', sysUser,
  ], context);

  if (result.code !== 0 && !result.stderr.includes('already exists')) {
    throw new Error(`useradd failed: ${result.stderr}`);
  }

  // Set disk quota (soft = hard = quotaMb, inode limits left open)
  const quotaKb = String(quotaMb * 1024);
  try {
    await shell.run('setquota', ['-u', sysUser, quotaKb, quotaKb, '0', '0', QUOTA_FS], context);
  } catch { /* quotas may not be enabled in dev */ }

  // Ensure home dir ownership
  try {
    await shell.run('chown', ['-R', `${sysUser}:${sysUser}`, homeDir], context);
  } catch { /* home dir may not exist in dev */ }

  const row = db.prepare(
    `INSERT INTO system_users (user_id, system_user, home_dir, quota_mb) VALUES (?, ?, ?, ?)`
  ).run(userId, sysUser, homeDir, quotaMb);

  return db.prepare('SELECT * FROM system_users WHERE id = ?').get(row.lastInsertRowid);
}

// ── Delete Linux system user ──────────────────────────────────────────────────

async function deleteSystemUser(userId, context = {}) {
  const row = db.prepare('SELECT * FROM system_users WHERE user_id = ?').get(userId);
  if (!row) return null;

  await shell.run('userdel', ['-r', row.system_user], context);
  db.prepare('DELETE FROM system_users WHERE id = ?').run(row.id);
  return row;
}

// ── Quota info ────────────────────────────────────────────────────────────────

async function getQuota(userId, context = {}) {
  const row = db.prepare('SELECT * FROM system_users WHERE user_id = ?').get(userId);
  if (!row) return null;

  try {
    const { stdout } = await shell.run('repquota', ['-u', QUOTA_FS], context);
    const line = stdout.split('\n').find(l => l.startsWith(row.system_user));
    if (!line) return { system_user: row.system_user, quota_mb: row.quota_mb, used_kb: 0 };
    // repquota output: user -- used soft hard ...
    const parts = line.trim().split(/\s+/);
    return {
      system_user: row.system_user,
      quota_mb:    row.quota_mb,
      used_kb:     parseInt(parts[2], 10) || 0,
    };
  } catch {
    return { system_user: row.system_user, quota_mb: row.quota_mb, used_kb: null };
  }
}

// ── Update quota ──────────────────────────────────────────────────────────────

async function setQuota(userId, quotaMb, context = {}) {
  const row = db.prepare('SELECT * FROM system_users WHERE user_id = ?').get(userId);
  if (!row) throw new Error('System user not found');

  const quotaKb = String(quotaMb * 1024);
  await shell.run('setquota', ['-u', row.system_user, quotaKb, quotaKb, '0', '0', QUOTA_FS], context);
  db.prepare('UPDATE system_users SET quota_mb = ? WHERE id = ?').run(quotaMb, row.id);
  return db.prepare('SELECT * FROM system_users WHERE id = ?').get(row.id);
}

function getSystemUser(userId) {
  return db.prepare('SELECT * FROM system_users WHERE user_id = ?').get(userId);
}

function listAllSystemUsers() {
  return db.prepare('SELECT su.*, u.username FROM system_users su JOIN users u ON u.id = su.user_id').all();
}

module.exports = {
  createSystemUser, deleteSystemUser, getQuota, setQuota,
  getSystemUser, listAllSystemUsers, deriveSystemUser,
};
