const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const dbPath = path.resolve(process.env.DB_PATH || './db/zpanel.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login  TEXT
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT    NOT NULL UNIQUE,
    expires_at  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    username    TEXT,
    action      TEXT    NOT NULL,
    target      TEXT,
    args        TEXT,
    ip          TEXT,
    result      TEXT,
    ts          TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 2: domains / vhosts
  CREATE TABLE IF NOT EXISTS domains (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain        TEXT    NOT NULL UNIQUE,
    doc_root      TEXT    NOT NULL,
    is_subdomain  INTEGER NOT NULL DEFAULT 0,
    parent_domain TEXT,
    php_version   TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 2: DNS records
  CREATE TABLE IF NOT EXISTS dns_records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id  INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    type       TEXT    NOT NULL CHECK(type IN ('A','AAAA','CNAME','MX','TXT','NS','SRV')),
    name       TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    ttl        INTEGER NOT NULL DEFAULT 3600,
    priority   INTEGER,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 2: SSL certificates
  CREATE TABLE IF NOT EXISTS ssl_certs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    domain      TEXT    NOT NULL,
    issued_at   TEXT,
    expires_at  TEXT,
    auto_renew  INTEGER NOT NULL DEFAULT 1,
    last_check  TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','expired','failed'))
  );

  -- Phase 3: email mailboxes
  CREATE TABLE IF NOT EXISTS mailboxes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    address     TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    quota_mb    INTEGER NOT NULL DEFAULT 500,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 3: email aliases
  CREATE TABLE IF NOT EXISTS email_aliases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    source      TEXT    NOT NULL,
    destination TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 3: MySQL databases
  CREATE TABLE IF NOT EXISTS databases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    db_name     TEXT    NOT NULL UNIQUE,
    db_user     TEXT    NOT NULL,
    db_host     TEXT    NOT NULL DEFAULT 'localhost',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 3: FTP accounts
  CREATE TABLE IF NOT EXISTS ftp_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ftp_user    TEXT    NOT NULL UNIQUE,
    chroot_dir  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 3: cron jobs
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    system_user TEXT    NOT NULL,
    expression  TEXT    NOT NULL,
    command     TEXT    NOT NULL,
    last_output TEXT,
    last_run    TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 4: one-click installed apps
  CREATE TABLE IF NOT EXISTS installed_apps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain_id   INTEGER REFERENCES domains(id) ON DELETE SET NULL,
    app_type    TEXT    NOT NULL CHECK(app_type IN ('wordpress','ghost','static')),
    app_version TEXT,
    install_dir TEXT    NOT NULL,
    db_name     TEXT,
    db_user     TEXT,
    pm2_name    TEXT,
    status      TEXT    NOT NULL DEFAULT 'installing' CHECK(status IN ('installing','active','failed','removed')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 4: deploy webhook hooks
  CREATE TABLE IF NOT EXISTS deploy_hooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    deploy_dir  TEXT    NOT NULL,
    branch      TEXT    NOT NULL DEFAULT 'main',
    secret      TEXT    NOT NULL,
    build_cmd   TEXT,
    pm2_name    TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 4: deploy history
  CREATE TABLE IF NOT EXISTS deploy_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    hook_id     INTEGER NOT NULL REFERENCES deploy_hooks(id) ON DELETE CASCADE,
    commit_sha  TEXT,
    commit_msg  TEXT,
    triggered_by TEXT,
    output      TEXT,
    status      TEXT    NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed')),
    started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  -- Phase 4: system users (per Zpanel account)
  CREATE TABLE IF NOT EXISTS system_users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    system_user TEXT    NOT NULL UNIQUE,
    home_dir    TEXT    NOT NULL,
    quota_mb    INTEGER NOT NULL DEFAULT 2048,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 5: API keys for programmatic access
  CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    key_hash    TEXT    NOT NULL UNIQUE,
    prefix      TEXT    NOT NULL,
    last_used   TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 6: TOTP backup codes
  CREATE TABLE IF NOT EXISTS totp_backup_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash   TEXT    NOT NULL,
    used_at     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 6: Short-lived MFA challenge tokens (used between login step 1 and step 2)
  CREATE TABLE IF NOT EXISTS mfa_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT    NOT NULL UNIQUE,
    expires_at  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 6: File and DB backups
  CREATE TABLE IF NOT EXISTS backups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT    NOT NULL CHECK(type IN ('files','database')),
    label       TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    size_bytes  INTEGER,
    status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ok','failed')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 6: Per-user notification preferences
  CREATE TABLE IF NOT EXISTS notification_prefs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    email               TEXT,
    notify_ssl_expiry   INTEGER NOT NULL DEFAULT 1,
    notify_deploy_fail  INTEGER NOT NULL DEFAULT 1,
    notify_quota_warn   INTEGER NOT NULL DEFAULT 1,
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Phase 6 migrations: add TOTP columns to users table ──────────────────────
// SQLite does not support "ADD COLUMN IF NOT EXISTS" so we check first.
(function migrateUsers() {
  const cols = db.pragma('table_info(users)').map(c => c.name);
  if (!cols.includes('totp_secret'))  db.exec("ALTER TABLE users ADD COLUMN totp_secret  TEXT");
  if (!cols.includes('totp_enabled')) db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0");
})();

module.exports = db;
