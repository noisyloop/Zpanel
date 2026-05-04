const db = require('../db');

// Middleware factory: checks the row at req.params.id in `table` is owned by the
// authenticated user (via ownerColumn). Admins bypass the check entirely.
//
// Usage:
//   router.delete('/:id', requireAuth, requireOwner('domains'), handler)
//
// Table and ownerColumn are developer-supplied constants — never user input.

function requireOwner(table, ownerColumn = 'user_id') {
  // Validate at middleware-creation time so mistakes fail loudly during startup
  if (!/^[a-z_]+$/.test(table))       throw new Error(`requireOwner: invalid table name "${table}"`);
  if (!/^[a-z_]+$/.test(ownerColumn)) throw new Error(`requireOwner: invalid ownerColumn "${ownerColumn}"`);

  const stmt = db.prepare(`SELECT "${ownerColumn}" FROM "${table}" WHERE id = ?`);

  return (req, res, next) => {
    if (req.user.role === 'admin') return next();

    const rowId = parseInt(req.params.id, 10);
    if (isNaN(rowId)) return res.status(400).json({ error: 'Invalid id' });

    const row = stmt.get(rowId);
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (row[ownerColumn] !== req.user.sub) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = requireOwner;
