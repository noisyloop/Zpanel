const express = require('express');
const { requireAuth } = require('../../auth');
const { getSnapshot } = require('./index');

const router = express.Router();

// GET /api/stats — single snapshot
router.get('/', requireAuth, (req, res) => {
  try {
    res.json(getSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
