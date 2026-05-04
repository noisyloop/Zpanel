const db    = require('../../db');
const shell = require('../../shell');
const vhost = require('../domains/vhost');
const fs    = require('fs');
const path  = require('path');

// ── Certbot integration ───────────────────────────────────────────────────────

/**
 * Issue a certificate for `domain` using certbot --nginx.
 * Requires port 80 to be open (ACME HTTP-01 challenge).
 * Updates the vhost config to HTTPS redirect after issuance.
 */
async function issue(domain, email, context = {}) {
  vhost.safeDomain(domain);

  const args = [
    '--nginx', '-d', domain,
    '--non-interactive', '--agree-tos',
    `--email=${email}`,
    '--redirect',
  ];

  const result = await shell.run('certbot', args, context);
  if (result.code !== 0) {
    throw new Error(`certbot failed:\n${result.stderr || result.stdout}`);
  }

  // Parse expiry from certbot output or live cert file
  const expiresAt = parseCertExpiry(domain) || expiryFromNow(90);

  // Upsert ssl_certs row
  upsertCert(domain, expiresAt, 'active');

  return { domain, expiresAt, output: result.stdout };
}

/**
 * Trigger `certbot renew` for all or a specific domain.
 */
async function renew(domain = null, context = {}) {
  const args = ['renew', '--non-interactive'];
  const result = await shell.run('certbot', args, context);
  if (domain) upsertCert(domain, parseCertExpiry(domain) || expiryFromNow(90), 'active');
  return { output: result.stdout + result.stderr, code: result.code };
}

// ── Cert file parsing ─────────────────────────────────────────────────────────

function parseCertExpiry(domain) {
  // Let's Encrypt live cert location
  const certPath = `/etc/letsencrypt/live/${domain}/cert.pem`;
  if (!fs.existsSync(certPath)) return null;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('openssl', ['x509', '-enddate', '-noout', '-in', certPath],
      { encoding: 'utf8', shell: false });
    // notAfter=May 15 12:00:00 2026 GMT
    const match = out.match(/notAfter=(.+)/);
    return match ? new Date(match[1]).toISOString() : null;
  } catch {
    return null;
  }
}

function expiryFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function upsertCert(domain, expiresAt, status) {
  const existing = db.prepare('SELECT id FROM ssl_certs WHERE domain = ?').get(domain);
  if (existing) {
    db.prepare(
      `UPDATE ssl_certs SET issued_at=datetime('now'), expires_at=?, status=?, last_check=datetime('now')
       WHERE id=?`
    ).run(expiresAt, status, existing.id);
  } else {
    const domainRow = db.prepare('SELECT id FROM domains WHERE domain = ?').get(domain);
    db.prepare(
      `INSERT INTO ssl_certs (domain_id, domain, issued_at, expires_at, status, last_check)
       VALUES (?, ?, datetime('now'), ?, ?, datetime('now'))`
    ).run(domainRow?.id ?? null, domain, expiresAt, status);
  }
}

function getCert(domain) {
  return db.prepare('SELECT * FROM ssl_certs WHERE domain = ?').get(domain);
}

function listCerts(userId = null) {
  if (userId) {
    return db.prepare(
      `SELECT s.* FROM ssl_certs s
       JOIN domains d ON d.id = s.domain_id
       WHERE d.user_id = ? ORDER BY s.domain`
    ).all(userId);
  }
  return db.prepare('SELECT * FROM ssl_certs ORDER BY domain').all();
}

// ── Renewal scheduler ─────────────────────────────────────────────────────────

let renewalTimer = null;

/**
 * Start a background renewal check that runs daily.
 * Renews certs expiring within `thresholdDays` days.
 */
function startRenewalScheduler(thresholdDays = 30) {
  if (renewalTimer) return;

  async function checkAndRenew() {
    const cutoff = new Date(Date.now() + thresholdDays * 24 * 60 * 60 * 1000).toISOString();
    const due = db.prepare(
      `SELECT * FROM ssl_certs WHERE auto_renew = 1 AND status = 'active'
       AND expires_at < ?`
    ).all(cutoff);

    for (const cert of due) {
      try {
        await renew(cert.domain, { user: 'scheduler' });
        console.log(`[ssl] Renewed: ${cert.domain}`);
      } catch (err) {
        console.error(`[ssl] Renewal failed for ${cert.domain}:`, err.message);
        db.prepare(`UPDATE ssl_certs SET status='failed', last_check=datetime('now') WHERE id=?`)
          .run(cert.id);
      }
    }

    // Update last_check for all active certs
    db.prepare(`UPDATE ssl_certs SET last_check=datetime('now') WHERE status='active'`).run();
  }

  // Check once at startup, then every 24 hours
  checkAndRenew();
  renewalTimer = setInterval(checkAndRenew, 24 * 60 * 60 * 1000);
}

function stopRenewalScheduler() {
  if (renewalTimer) { clearInterval(renewalTimer); renewalTimer = null; }
}

module.exports = {
  issue, renew, getCert, listCerts, upsertCert,
  parseCertExpiry, startRenewalScheduler, stopRenewalScheduler,
};
