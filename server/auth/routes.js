const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('./index');
const db = require('../db');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/auth/login
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const user = auth.findUser(username);
  if (!user || !auth.verifyPassword(password, user.password)) {
    auth.audit(req, 'login_failed', username, null, 'invalid_credentials');
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id);

  const accessToken  = auth.issueAccessToken(user);
  const refreshToken = auth.issueRefreshToken(user.id);

  auth.audit(req, 'login', user.username, null, 'ok');

  res
    .cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    .json({ accessToken, user: { id: user.id, username: user.username, role: user.role } });
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  const row = auth.consumeRefreshToken(token);
  if (!row) return res.status(401).json({ error: 'Invalid or expired refresh token' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const accessToken     = auth.issueAccessToken(user);
  const newRefreshToken = auth.issueRefreshToken(user.id);

  res
    .cookie('refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    .json({ accessToken });
});

// POST /api/auth/logout
router.post('/logout', auth.requireAuth, (req, res) => {
  auth.revokeAllRefreshTokens(req.user.sub);
  auth.audit(req, 'logout', req.user.username, null, 'ok');
  res.clearCookie('refresh_token').json({ ok: true });
});

// GET /api/auth/me
router.get('/me', auth.requireAuth, (req, res) => {
  res.json({ id: req.user.sub, username: req.user.username, role: req.user.role });
});

// ── API key management ────────────────────────────────────────────────────────

const apiKeys = require('./apiKeys');

// GET /api/auth/keys — list caller's API keys (no plaintext returned)
router.get('/keys', auth.requireAuth, (req, res) => {
  res.json(apiKeys.listKeys(req.user.sub));
});

// POST /api/auth/keys — generate a new API key; plaintext returned once
router.post('/keys', auth.requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const key = apiKeys.generateKey(req.user.sub, name.trim());
  auth.audit(req, 'api_key_created', name, null, 'ok');
  res.status(201).json(key); // includes key.plaintext — show once only
});

// DELETE /api/auth/keys/:id — revoke a key
router.delete('/keys/:id', auth.requireAuth, (req, res) => {
  try {
    apiKeys.revokeKey(parseInt(req.params.id, 10), req.user.sub);
    auth.audit(req, 'api_key_revoked', req.params.id, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'FORBIDDEN' ? 403 : err.message === 'API key not found' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
