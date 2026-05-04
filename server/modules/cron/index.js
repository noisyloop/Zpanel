const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const db     = require('../../db');

// ── Cron expression validation ────────────────────────────────────────────────

// Allowed cron command characters — no shell metacharacters
const CMD_RE = /^[a-zA-Z0-9 /._@%+:=\-]{1,512}$/;

const FIELD_LIMITS = [
  { name: 'minute',  min: 0, max: 59 },
  { name: 'hour',    min: 0, max: 23 },
  { name: 'day',     min: 1, max: 31 },
  { name: 'month',   min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7  },
];

function validateField(value, { name, min, max }) {
  if (value === '*') return;

  // Step: */n or n/n
  if (value.includes('/')) {
    const [base, step] = value.split('/');
    const s = parseInt(step, 10);
    if (isNaN(s) || s < 1) throw new Error(`Invalid cron ${name} field: "${value}"`);
    if (base !== '*') validateField(base, { name, min, max });
    return;
  }

  // Range: n-m
  if (value.includes('-')) {
    const [lo, hi] = value.split('-').map(Number);
    if (isNaN(lo) || isNaN(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron ${name} field: "${value}"`);
    }
    return;
  }

  // List: n,m,p
  if (value.includes(',')) {
    for (const part of value.split(',')) {
      validateField(part.trim(), { name, min, max });
    }
    return;
  }

  // Plain number
  const n = parseInt(value, 10);
  if (isNaN(n) || n < min || n > max) {
    throw new Error(`Invalid cron ${name} field: "${value}"`);
  }
}

function validateExpression(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron expression must have 5 fields: min hour dom mon dow');
  parts.forEach((p, i) => validateField(p, FIELD_LIMITS[i]));
  return expr.trim();
}

function validateCommand(cmd) {
  if (!CMD_RE.test(cmd)) {
    throw new Error('Command contains disallowed characters');
  }
  return cmd.trim();
}

// ── Expression builder helper ─────────────────────────────────────────────────
// Converts a UI schedule object to a cron expression string.

function buildExpression({ minute = '*', hour = '*', dom = '*', month = '*', dow = '*' }) {
  const expr = `${minute} ${hour} ${dom} ${month} ${dow}`;
  return validateExpression(expr);
}

// ── Crontab read/write ────────────────────────────────────────────────────────
// We only ever read/write the crontab for the system user tied to a Zpanel user.
// Root crontab is never touched — system_user is validated against the DB record.

function readCrontab(systemUser) {
  try {
    return execFileSync('crontab', ['-l', '-u', systemUser], {
      encoding: 'utf8',
      shell: false,
    });
  } catch (err) {
    // crontab -l exits 1 when no crontab exists yet
    if (err.status === 1) return '';
    throw err;
  }
}

function writeCrontab(systemUser, content) {
  const tmp = path.join(os.tmpdir(), `zpanel-cron-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    execFileSync('crontab', ['-u', systemUser, tmp], { shell: false });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── Job CRUD ──────────────────────────────────────────────────────────────────

function createJob(userId, systemUser, expression, command) {
  expression = validateExpression(expression);
  command    = validateCommand(command);

  const row = db.prepare(
    `INSERT INTO cron_jobs (user_id, system_user, expression, command) VALUES (?, ?, ?, ?)`
  ).run(userId, systemUser, expression, command);

  syncCrontab(systemUser);
  return db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(row.lastInsertRowid);
}

function updateJob(id, fields) {
  const job = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Cron job not found');

  const expression = validateExpression(fields.expression ?? job.expression);
  const command    = validateCommand(fields.command ?? job.command);

  db.prepare('UPDATE cron_jobs SET expression=?, command=? WHERE id=?')
    .run(expression, command, id);

  syncCrontab(job.system_user);
  return db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id);
}

function deleteJob(id) {
  const job = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Cron job not found');
  db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
  syncCrontab(job.system_user);
  return job;
}

function listJobs(userId) {
  return db.prepare('SELECT * FROM cron_jobs WHERE user_id = ? ORDER BY id').all(userId);
}

// ── Crontab sync ──────────────────────────────────────────────────────────────
// Rebuilds the crontab for a system user from our DB records.
// Any lines not managed by Zpanel (no # zpanel: tag) are preserved.

const MANAGED_TAG = '# zpanel-managed';

function syncCrontab(systemUser) {
  let existing;
  try { existing = readCrontab(systemUser); } catch { existing = ''; }

  // Remove all previously managed lines (pairs: tag line + job line)
  const preserved = existing
    .split('\n')
    .reduce((acc, line, i, arr) => {
      if (line.trim() === MANAGED_TAG) return acc; // skip tag
      if (i > 0 && arr[i - 1].trim() === MANAGED_TAG) return acc; // skip job after tag
      acc.push(line);
      return acc;
    }, [])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const jobs = db.prepare(
    'SELECT * FROM cron_jobs WHERE system_user = ? ORDER BY id'
  ).all(systemUser);

  const managed = jobs.map(j => `${MANAGED_TAG}\n${j.expression} ${j.command}`).join('\n');
  const full    = [preserved, managed].filter(Boolean).join('\n') + '\n';

  try {
    writeCrontab(systemUser, full);
  } catch { /* crontab may not exist for user in dev */ }
}

module.exports = {
  validateExpression, validateCommand, buildExpression,
  createJob, updateJob, deleteJob, listJobs,
  readCrontab, writeCrontab, syncCrontab,
};
