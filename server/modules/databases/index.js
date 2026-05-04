const db     = require('../../db');
const crypto = require('crypto');

// ── Name sanitisation ─────────────────────────────────────────────────────────
// MySQL identifiers: letters, digits, underscores, max 64 chars.
// We enforce a tighter pattern to prevent any injection.

const IDENT_RE = /^[a-zA-Z0-9_]{1,48}$/;

function sanitise(name, label) {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid ${label}: only letters, digits and underscores allowed (max 48 chars)`);
  }
  return name;
}

// ── MySQL connection ──────────────────────────────────────────────────────────

let mysql = null;

function getConn() {
  if (mysql) return mysql;
  try {
    // Optional peer dependency — not installed by default; used in production.
    const m = require('mysql2/promise');
    mysql = m.createPool({
      host:     process.env.MYSQL_HOST     || '127.0.0.1',
      port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
      user:     process.env.MYSQL_ROOT_USER || 'root',
      password: process.env.MYSQL_ROOT_PASS || '',
      multipleStatements: false,
    });
    return mysql;
  } catch {
    throw new Error('mysql2 not installed — run: npm install mysql2');
  }
}

// ── Provisioning ──────────────────────────────────────────────────────────────

async function createDatabase(userId, dbNameRaw, dbUserRaw, dbPasswordRaw) {
  const dbName = sanitise(dbNameRaw, 'database name');
  const dbUser = sanitise(dbUserRaw, 'database user');

  // Check for uniqueness in our metadata DB first
  if (db.prepare('SELECT id FROM databases WHERE db_name = ?').get(dbName)) {
    throw new Error(`Database "${dbName}" already exists`);
  }

  const pool = getConn();
  const conn = await pool.getConnection();
  try {
    // Use backtick-quoted identifiers — safe because we validated above
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await conn.query(
      `CREATE USER IF NOT EXISTS ?@'localhost' IDENTIFIED BY ?`,
      [dbUser, dbPasswordRaw]
    );
    await conn.query(
      `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@'localhost'`,
      [dbUser]
    );
    await conn.query('FLUSH PRIVILEGES');
  } finally {
    conn.release();
  }

  const row = db.prepare(
    `INSERT INTO databases (user_id, db_name, db_user) VALUES (?, ?, ?)`
  ).run(userId, dbName, dbUser);

  return db.prepare('SELECT * FROM databases WHERE id = ?').get(row.lastInsertRowid);
}

async function dropDatabase(id) {
  const row = db.prepare('SELECT * FROM databases WHERE id = ?').get(id);
  if (!row) throw new Error('Database not found');

  sanitise(row.db_name, 'database name');
  sanitise(row.db_user, 'database user');

  const pool = getConn();
  const conn = await pool.getConnection();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${row.db_name}\``);
    await conn.query(`DROP USER IF EXISTS ?@'localhost'`, [row.db_user]);
    await conn.query('FLUSH PRIVILEGES');
  } finally {
    conn.release();
  }

  db.prepare('DELETE FROM databases WHERE id = ?').run(id);
  return row;
}

function listDatabases(userId) {
  return db.prepare('SELECT * FROM databases WHERE user_id = ? ORDER BY db_name').all(userId);
}

function listAllDatabases() {
  return db.prepare('SELECT * FROM databases ORDER BY db_name').all();
}

// ── Table & row count info ────────────────────────────────────────────────────

async function getTables(dbName) {
  sanitise(dbName, 'database name');
  const pool = getConn();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME AS name,
              TABLE_ROWS  AS approx_rows,
              ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024, 1) AS size_kb
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [dbName]
    );
    return rows;
  } finally {
    conn.release();
  }
}

// ── Safe query runner ─────────────────────────────────────────────────────────
// Only SELECT, SHOW, DESCRIBE, EXPLAIN allowed — no DDL/DML via this endpoint.

const SAFE_QUERY_RE = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\s/i;

async function runQuery(dbName, query) {
  sanitise(dbName, 'database name');
  if (!SAFE_QUERY_RE.test(query)) {
    throw new Error('Only SELECT, SHOW, DESCRIBE, and EXPLAIN are allowed in the query runner');
  }
  if (query.length > 4096) throw new Error('Query too long (max 4096 chars)');

  const pool = getConn();
  const conn = await pool.getConnection();
  try {
    await conn.query(`USE \`${dbName}\``);
    const [rows, fields] = await conn.query(query);
    return {
      columns: fields?.map(f => f.name) || [],
      rows: Array.isArray(rows) ? rows.slice(0, 500) : rows, // cap at 500 rows
    };
  } finally {
    conn.release();
  }
}

module.exports = {
  createDatabase, dropDatabase, listDatabases, listAllDatabases,
  getTables, runQuery, sanitise,
};
