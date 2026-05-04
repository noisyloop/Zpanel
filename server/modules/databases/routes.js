const express = require('express');
const { requireAuth, audit } = require('../../auth');
const dbs = require('./index');

const router = express.Router();

// GET /api/databases
router.get('/', requireAuth, (req, res) => {
  const list = req.user.role === 'admin'
    ? dbs.listAllDatabases()
    : dbs.listDatabases(req.user.sub);
  res.json(list);
});

// POST /api/databases
router.post('/', requireAuth, async (req, res) => {
  const { dbName, dbUser, dbPassword } = req.body;
  if (!dbName || !dbUser || !dbPassword) {
    return res.status(400).json({ error: 'dbName, dbUser, dbPassword required' });
  }
  try {
    const row = await dbs.createDatabase(req.user.sub, dbName, dbUser, dbPassword);
    audit(req, 'db_create', dbName, { dbUser }, 'ok');
    res.status(201).json({ id: row.id, db_name: row.db_name, db_user: row.db_user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/databases/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = require('../../db').prepare('SELECT * FROM databases WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await dbs.dropDatabase(id);
    audit(req, 'db_drop', row.db_name, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/databases/:id/tables
router.get('/:id/tables', requireAuth, async (req, res) => {
  const row = require('../../db').prepare('SELECT * FROM databases WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const tables = await dbs.getTables(row.db_name);
    res.json(tables);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/databases/:id/query — read-only query runner
router.post('/:id/query', requireAuth, async (req, res) => {
  const row = require('../../db').prepare('SELECT * FROM databases WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const result = await dbs.runQuery(row.db_name, query);
    audit(req, 'db_query', row.db_name, { queryLen: query.length }, 'ok');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
