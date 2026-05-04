const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
require('dotenv').config();

const SALT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set in environment');
}

// ── User management ──────────────────────────────────────────────────────────

function createUser(username, plainPassword, role = 'user') {
  const password = bcrypt.hashSync(plainPassword, SALT_ROUNDS);
  const stmt = db.prepare(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)'
  );
  return stmt.run(username, password, role);
}

function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function verifyPassword(plainPassword, hash) {
  return bcrypt.compareSync(plainPassword, hash);
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function issueRefreshToken(userId) {
  const token = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).run(userId, token, expiresAt);
  return token;
}

function consumeRefreshToken(token) {
  const row = db.prepare(
    'SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > datetime(\'now\')'
  ).get(token);
  if (!row) return null;
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(row.id);
  return row;
}

function revokeAllRefreshTokens(userId) {
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── Middleware ────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = verifyAccessToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    next();
  });
}

// ── Audit helper ──────────────────────────────────────────────────────────────

function audit(req, action, target, args, result) {
  const userId = req.user?.sub ?? null;
  const username = req.user?.username ?? 'anonymous';
  const ip = req.ip;
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, target, args, ip, result) VALUES (?,?,?,?,?,?,?)'
  ).run(userId, username, action, target ?? null, args ? JSON.stringify(args) : null, ip, result ?? null);
}

module.exports = {
  createUser, findUser, verifyPassword,
  issueAccessToken, issueRefreshToken, consumeRefreshToken,
  revokeAllRefreshTokens, verifyAccessToken,
  requireAuth, requireAdmin, audit,
};
