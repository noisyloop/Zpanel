/**
 * TOTP (RFC 6238) implementation using only Node.js built-ins.
 *
 * How it works:
 *   TOTP(key, time) = HOTP(key, T)  where T = floor(unix_seconds / 30)
 *   HOTP(key, counter) = Truncate(HMAC-SHA1(key, counter))
 *
 * The key is stored as base32 (RFC 4648) so it can be shared with
 * authenticator apps via a scannable QR code.
 */

const crypto = require('crypto');
const QRCode = require('qrcode');
const db     = require('../db');

// ── Base32 codec ──────────────────────────────────────────────────────────────

const B32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) { out += B32_CHARS[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_CHARS[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  str = str.toUpperCase().replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = Buffer.allocUnsafe(Math.floor(str.length * 5 / 8));
  let idx = 0;
  for (const ch of str) {
    const i = B32_CHARS.indexOf(ch);
    if (i === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out[idx++] = (value >>> (bits - 8)) & 0xff; bits -= 8; }
  }
  return out.slice(0, idx);
}

// ── HOTP / TOTP core ─────────────────────────────────────────────────────────

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.allocUnsafe(8);
  // Counter as big-endian uint64 (BigInt handles the full range)
  msg.writeBigUInt64BE(BigInt(counter));
  const mac    = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[19] & 0x0f;
  const code   = (
    ((mac[offset]     & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) <<  8) |
     (mac[offset + 3] & 0xff)
  ) % 1_000_000;
  return String(code).padStart(6, '0');
}

function currentCounter() {
  return Math.floor(Date.now() / 1000 / 30);
}

// ── Public API ────────────────────────────────────────────────────────────────

function generateSecret() {
  // 20 bytes = 160 bits — matches the reference implementation (RFC 4226 §4)
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Verify a 6-digit TOTP code.
 * Accepts a ±1 step window (30 s each side) to tolerate clock skew.
 */
function verifyCode(secret, code) {
  const T   = currentCounter();
  const str = String(code).padStart(6, '0');
  return [T - 1, T, T + 1].some(t => hotp(secret, t) === str);
}

/**
 * Build the otpauth:// URI and return a PNG data-URL QR code.
 * Authenticator apps (Google, Authy, 1Password) scan this to add the account.
 */
async function buildSetupPayload(issuer, username, secret) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  const uri   = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  const qr    = await QRCode.toDataURL(uri);
  return { secret, uri, qr };
}

// ── Backup codes ──────────────────────────────────────────────────────────────
// 8 one-time codes, each 8 uppercase hex chars. Only the SHA-256 hash stored.

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateBackupCodes(userId) {
  // Delete any existing codes for this user
  db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(userId);

  const codes = Array.from({ length: 8 }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );
  const insert = db.prepare(
    'INSERT INTO totp_backup_codes (user_id, code_hash) VALUES (?, ?)'
  );
  codes.forEach(c => insert.run(userId, hashBackupCode(c)));
  return codes; // returned once in plaintext — never stored unhasheddddd
}

/**
 * Attempt to consume a backup code. Returns true if valid and unused.
 * Marks the code used so it cannot be reused.
 */
function consumeBackupCode(userId, code) {
  const hash = hashBackupCode(code.toUpperCase().trim());
  const row  = db.prepare(
    'SELECT * FROM totp_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL'
  ).get(userId, hash);
  if (!row) return false;
  db.prepare("UPDATE totp_backup_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return true;
}

// ── MFA challenge token helpers ───────────────────────────────────────────────
// Short-lived (5 min) opaque tokens bridging login step 1 → step 2 for TOTP users.

function issueMfaToken(userId) {
  const token     = crypto.randomBytes(20).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO mfa_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
  return token;
}

function consumeMfaToken(token) {
  const row = db.prepare(
    "SELECT * FROM mfa_tokens WHERE token = ? AND expires_at > datetime('now')"
  ).get(token);
  if (!row) return null;
  db.prepare('DELETE FROM mfa_tokens WHERE id = ?').run(row.id);
  return row; // contains user_id
}

module.exports = {
  generateSecret, verifyCode, buildSetupPayload,
  generateBackupCodes, consumeBackupCode,
  issueMfaToken, consumeMfaToken,
  base32Encode, base32Decode, hotp,
};
