/**
 * Notification system — DB logging + optional SMTP delivery via nodemailer.
 *
 * SMTP is configured via environment variables. If SMTP_HOST is not set,
 * notifications are only logged to the audit_log table — no error is thrown.
 * This lets the system work in dev without a mail server.
 */

const nodemailer = require('nodemailer');
const db         = require('../../db');

// ── SMTP transport (lazily initialised) ───────────────────────────────────────

let _transport = null;

function getTransport() {
  if (_transport) return _transport;
  const host = process.env.SMTP_HOST;
  if (!host) return null; // SMTP not configured

  _transport = nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT  || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth:   process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  });
  return _transport;
}

// ── Preference helpers ────────────────────────────────────────────────────────

function getPrefs(userId) {
  return db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').get(userId) || {
    user_id: userId, email: null,
    notify_ssl_expiry: 1, notify_deploy_fail: 1, notify_quota_warn: 1,
  };
}

function setPrefs(userId, { email, notify_ssl_expiry, notify_deploy_fail, notify_quota_warn }) {
  db.prepare(`
    INSERT INTO notification_prefs (user_id, email, notify_ssl_expiry, notify_deploy_fail, notify_quota_warn, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      email               = excluded.email,
      notify_ssl_expiry   = excluded.notify_ssl_expiry,
      notify_deploy_fail  = excluded.notify_deploy_fail,
      notify_quota_warn   = excluded.notify_quota_warn,
      updated_at          = excluded.updated_at
  `).run(
    userId,
    email             ?? null,
    notify_ssl_expiry ?? 1,
    notify_deploy_fail ?? 1,
    notify_quota_warn  ?? 1,
  );
  return getPrefs(userId);
}

// ── Core send ─────────────────────────────────────────────────────────────────

/**
 * Send a notification to a user.
 * Always writes to audit_log; sends email only when SMTP is configured
 * and the user has an email address in their prefs.
 */
async function notify(userId, subject, body) {
  // Audit log record — capture the inserted id so we can update *exactly* this
  // row later. (SQLite doesn't support ORDER BY/LIMIT on UPDATE without a
  // build-time flag that better-sqlite3 doesn't set, so we cannot rely on it.)
  const insert = db.prepare(
    `INSERT INTO audit_log (user_id, action, target, args, result)
     VALUES (?, 'notification_sent', ?, ?, 'queued')`
  ).run(userId, subject, body?.slice(0, 200) ?? null);
  const auditId = insert.lastInsertRowid;

  const prefs     = getPrefs(userId);
  const transport = getTransport();
  if (!transport || !prefs.email) return; // no SMTP or no address — silently skip

  try {
    await transport.sendMail({
      from:    process.env.SMTP_FROM || `noreply@${process.env.SMTP_HOST}`,
      to:      prefs.email,
      subject: `[Zpanel] ${subject}`,
      text:    body,
    });
    db.prepare("UPDATE audit_log SET result = 'sent' WHERE id = ?").run(auditId);
  } catch (err) {
    db.prepare('UPDATE audit_log SET result = ? WHERE id = ?')
      .run(`smtp_error: ${err.message}`, auditId);
  }
}

// ── Typed notification helpers (called by other modules) ──────────────────────

async function notifySslExpiry(userId, domain, daysLeft) {
  const prefs = getPrefs(userId);
  if (!prefs.notify_ssl_expiry) return;
  await notify(userId,
    `SSL certificate for ${domain} expires in ${daysLeft} day(s)`,
    `Your SSL certificate for ${domain} will expire in ${daysLeft} day(s).\n\nLog in to Zpanel and renew it under SSL Certs.`
  );
}

async function notifyDeployFail(userId, hookName, error) {
  const prefs = getPrefs(userId);
  if (!prefs.notify_deploy_fail) return;
  await notify(userId,
    `Deploy failed: ${hookName}`,
    `The deploy hook "${hookName}" failed with the following error:\n\n${error}`
  );
}

async function notifyQuotaWarning(userId, systemUser, usedPct) {
  const prefs = getPrefs(userId);
  if (!prefs.notify_quota_warn) return;
  await notify(userId,
    `Disk quota warning: ${systemUser} at ${usedPct}%`,
    `The user "${systemUser}" is using ${usedPct}% of their disk quota.\n\nLog in to Zpanel to manage disk usage or increase the quota.`
  );
}

module.exports = { getPrefs, setPrefs, notify, notifySslExpiry, notifyDeployFail, notifyQuotaWarning };
