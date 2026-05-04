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
`);

module.exports = db;
