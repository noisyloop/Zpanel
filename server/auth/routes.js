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

const totp = require('./totp');

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

  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  // If TOTP is enabled, issue a short-lived MFA challenge token instead of a session
  if (user.totp_enabled) {
    const mfaToken = totp.issueMfaToken(user.id);
    auth.audit(req, 'login_mfa_required', user.username, null, 'mfa_challenge');
    return res.json({ mfa_required: true, mfa_token: mfaToken });
  }

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

// POST /api/auth/totp/validate — step 2 of TOTP login
// Accepts { mfa_token, code } or { mfa_token, backup_code }
router.post('/totp/validate', loginLimiter, (req, res) => {
  const { mfa_token, code, backup_code } = req.body;
  if (!mfa_token) return res.status(400).json({ error: 'mfa_token required' });

  const mfaRow = totp.consumeMfaToken(mfa_token);
  if (!mfaRow)  return res.status(401).json({ error: 'MFA token invalid or expired' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(mfaRow.user_id);
  if (!user)    return res.status(401).json({ error: 'User not found' });

  let valid = false;
  if (backup_code) {
    valid = totp.consumeBackupCode(user.id, backup_code);
  } else if (code) {
    valid = totp.verifyCode(user.totp_secret, String(code));
  }

  if (!valid) {
    auth.audit(req, 'login_mfa_failed', user.username, null, 'invalid_code');
    return res.status(401).json({ error: 'Invalid code' });
  }

  const accessToken  = auth.issueAccessToken(user);
  const refreshToken = auth.issueRefreshToken(user.id);

  auth.audit(req, 'login', user.username, null, 'ok_mfa');
  res
    .cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    .json({ accessToken, user: { id: user.id, username: user.username, role: user.role } });
});

// POST /api/auth/totp/setup — generate secret + QR, but don't enable yet
router.post('/totp/setup', auth.requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });

  const secret  = totp.generateSecret();
  const payload = await totp.buildSetupPayload('Zpanel', user.username, secret);

  // Store secret temporarily (not enabled until confirmed)
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, user.id);
  res.json(payload); // { secret, uri, qr (data-URL PNG) }
});

// POST /api/auth/totp/confirm — verify a code against the pending secret, then enable
router.post('/totp/confirm', auth.requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user.totp_secret) return res.status(400).json({ error: 'Run /setup first' });
  if (user.totp_enabled) return res.status(400).json({ error: '2FA already enabled' });

  if (!totp.verifyCode(user.totp_secret, String(code))) {
    return res.status(401).json({ error: 'Invalid code — check your authenticator app' });
  }

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  const backupCodes = totp.generateBackupCodes(user.id);

  auth.audit(req, 'totp_enabled', req.user.username, null, 'ok');
  res.json({ ok: true, backup_codes: backupCodes }); // shown once
});

// DELETE /api/auth/totp — disable 2FA (requires current TOTP code or backup)
router.delete('/totp', auth.requireAuth, (req, res) => {
  const { code, backup_code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });

  let valid = false;
  if (backup_code) valid = totp.consumeBackupCode(user.id, backup_code);
  else if (code)   valid = totp.verifyCode(user.totp_secret, String(code));

  if (!valid) return res.status(401).json({ error: 'Invalid code' });

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(user.id);

  auth.audit(req, 'totp_disabled', req.user.username, null, 'ok');
  res.json({ ok: true });
});

// POST /api/auth/totp/backup — regenerate backup codes (requires TOTP code)
router.post('/totp/backup', auth.requireAuth, (req, res) => {
  const { code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user.totp_enabled) return res.status(400).json({ error: '2FA not enabled' });
  if (!totp.verifyCode(user.totp_secret, String(code))) {
    return res.status(401).json({ error: 'Invalid code' });
  }
  const backupCodes = totp.generateBackupCodes(user.id);
  auth.audit(req, 'totp_backup_regen', req.user.username, null, 'ok');
  res.json({ backup_codes: backupCodes });
});

// GET /api/auth/totp/status — current 2FA state for the authenticated user
router.get('/totp/status', auth.requireAuth, (req, res) => {
  const user = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.sub);
  const remaining = user?.totp_enabled
    ? db.prepare('SELECT COUNT(*) AS n FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL').get(req.user.sub).n
    : 0;
  res.json({ enabled: !!user?.totp_enabled, backup_codes_remaining: remaining });
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
