const express = require('express');
const { requireAdmin } = require('../../auth');
const db = require('../../db');

const router = express.Router();

// GET /api/audit?limit=50&offset=0&username=&action=
// Returns paginated audit log entries. Admin only.
router.get('/', requireAdmin, (req, res) => {
  const limit    = Math.min(parseInt(req.query.limit  || '50', 10), 200);
  const offset   = Math.max(parseInt(req.query.offset || '0',  10), 0);
  const username = req.query.username?.trim() || null;
  const action   = req.query.action?.trim()   || null;

  let sql    = 'SELECT * FROM audit_log WHERE 1=1';
  const args = [];

  if (username) { sql += ' AND username = ?'; args.push(username); }
  if (action)   { sql += ' AND action   = ?'; args.push(action);   }

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);

  const rows  = db.prepare(sql).all(...args);
  const total = db.prepare(
    'SELECT COUNT(*) AS n FROM audit_log' +
    (username || action
      ? ' WHERE ' + [username && 'username = ?', action && 'action = ?'].filter(Boolean).join(' AND ')
      : '')
  ).get(...(username || action ? [username, action].filter(Boolean) : [])).n;

  res.json({ rows, total, limit, offset });
});

// GET /api/audit/actions — distinct action types (for filter dropdown)
router.get('/actions', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all();
  res.json(rows.map(r => r.action));
});

module.exports = router;
