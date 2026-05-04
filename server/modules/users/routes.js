const express = require('express');
const { requireAuth, requireAdmin, audit } = require('../../auth');
const users = require('./index');

const router = express.Router();

// GET /api/users — admin: list all users with resource counts
router.get('/', requireAdmin, (req, res) => {
  try {
    res.json(users.listUsers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id — admin or self
router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user.role !== 'admin' && req.user.sub !== id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const user = users.getUser(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// GET /api/users/:id/summary — admin or self
router.get('/:id/summary', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user.role !== 'admin' && req.user.sub !== id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    res.json(users.getResourceSummary(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users — admin: create a new panel user
router.post('/', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    const user = users.createUser(username, password, role || 'user');
    audit(req, 'user_created', username, { role: user.role }, 'ok');
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/users/:id — admin: delete a user (cannot delete self)
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const user = users.deleteUser(id, req.user.sub);
    audit(req, 'user_deleted', user.username, null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const status = err.message === 'Cannot delete your own account' ? 400
                 : err.message === 'User not found' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// PATCH /api/users/:id/password — admin or self: change password
router.patch('/:id/password', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user.role !== 'admin' && req.user.sub !== id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    users.changePassword(id, password);
    audit(req, 'password_changed', String(id), null, 'ok');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/users/:id/role — admin: change role (cannot change own role)
router.patch('/:id/role', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'role required' });
  try {
    const user = users.changeRole(id, role, req.user.sub);
    audit(req, 'role_changed', user.username, { role }, 'ok');
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
