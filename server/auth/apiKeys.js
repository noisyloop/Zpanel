const crypto = require('crypto');
const db     = require('../db');

// Key format: zpk_<40 hex chars>
// Only the SHA-256 hash is stored; the plaintext is shown once at creation.

const PREFIX = 'zpk_';

function generateKey(userId, name) {
  const plaintext = PREFIX + crypto.randomBytes(20).toString('hex');
  const keyHash   = crypto.createHash('sha256').update(plaintext).digest('hex');
  const prefix    = plaintext.slice(0, PREFIX.length + 8); // "zpk_" + 8 chars

  const row = db.prepare(
    `INSERT INTO api_keys (user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?)`
  ).run(userId, name, keyHash, prefix);

  return {
    id:        row.lastInsertRowid,
    name,
    prefix,
    plaintext, // returned ONCE — caller must surface this to the user immediately
    created_at: new Date().toISOString(),
  };
}

function verifyApiKey(plaintext) {
  if (!plaintext?.startsWith(PREFIX)) return null;
  const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const keyRow  = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
  if (!keyRow) return null;

  // Update last_used timestamp
  db.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").run(keyRow.id);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(keyRow.user_id);
}

function listKeys(userId) {
  return db.prepare(
    'SELECT id, name, prefix, last_used, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

function revokeKey(id, userId) {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!row) throw new Error('API key not found');
  // Users can only revoke their own keys; admins can revoke any
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (row.user_id !== userId && user?.role !== 'admin') {
    throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });
  }
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  return row;
}

module.exports = { generateKey, verifyApiKey, listKeys, revokeKey, PREFIX };
