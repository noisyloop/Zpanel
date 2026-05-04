const bcrypt = require('bcrypt');
const db     = require('../../db');

const SALT_ROUNDS = 12;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

function validateUsername(username) {
  if (!USERNAME_RE.test(username)) {
    throw new Error('Username must be 3–32 characters: letters, numbers, _ or -');
  }
}

// ── List / read ───────────────────────────────────────────────────────────────

function listUsers() {
  const users = db.prepare(
    'SELECT id, username, role, created_at, last_login FROM users ORDER BY id'
  ).all();

  const countIn = (table) =>
    db.prepare(`SELECT user_id, COUNT(*) AS n FROM ${table} GROUP BY user_id`).all()
      .reduce((m, r) => { m[r.user_id] = r.n; return m; }, {});

  const domainCounts   = countIn('domains');
  const dbCounts       = countIn('databases');
  const mailboxCounts  = countIn('mailboxes');

  return users.map(u => ({
    ...u,
    domains:   domainCounts[u.id]  || 0,
    databases: dbCounts[u.id]      || 0,
    mailboxes: mailboxCounts[u.id] || 0,
  }));
}

function getUser(id) {
  return db.prepare('SELECT id, username, role, created_at, last_login FROM users WHERE id = ?').get(id);
}

// ── Resource summary for one user ─────────────────────────────────────────────

function getResourceSummary(userId) {
  const count = (table) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId).n;

  const sysUser = db.prepare('SELECT quota_mb FROM system_users WHERE user_id = ?').get(userId);

  return {
    domains:      count('domains'),
    databases:    count('databases'),
    mailboxes:    count('mailboxes'),
    ftp_accounts: count('ftp_accounts'),
    cron_jobs:    count('cron_jobs'),
    installed_apps: db.prepare(
      "SELECT COUNT(*) AS n FROM installed_apps WHERE user_id = ? AND status != 'removed'"
    ).get(userId).n,
    deploy_hooks: count('deploy_hooks'),
    quota_mb:     sysUser?.quota_mb ?? null,
  };
}

// ── Create ────────────────────────────────────────────────────────────────────

function createUser(username, plainPassword, role = 'user') {
  validateUsername(username);
  if (!plainPassword || plainPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (!['admin', 'user'].includes(role)) throw new Error('Invalid role');

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) throw new Error(`Username "${username}" is already taken`);

  const password = bcrypt.hashSync(plainPassword, SALT_ROUNDS);
  const row = db.prepare(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)'
  ).run(username, password, role);

  return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(row.lastInsertRowid);
}

// ── Delete ────────────────────────────────────────────────────────────────────

function deleteUser(id, requesterId) {
  if (id === requesterId) throw new Error('Cannot delete your own account');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return user;
}

// ── Change password ───────────────────────────────────────────────────────────

function changePassword(id, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');
  const hash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
}

// ── Change role ───────────────────────────────────────────────────────────────

function changeRole(id, role, requesterId) {
  if (!['admin', 'user'].includes(role)) throw new Error('Invalid role');
  if (id === requesterId) throw new Error('Cannot change your own role');
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
}

module.exports = {
  listUsers, getUser, getResourceSummary,
  createUser, deleteUser, changePassword, changeRole,
  validateUsername,
};
