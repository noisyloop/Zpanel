const express    = require('express');
const { requireAuth, audit } = require('../../auth');
const deploy = require('./index');

const router = express.Router();
const ctx    = req => ({ user: req.user.username, ip: req.ip });

// GET /api/deploy — list hooks for current user
router.get('/', requireAuth, (req, res) => {
  res.json(deploy.listHooks(req.user.sub));
});

// POST /api/deploy — create hook
router.post('/', requireAuth, (req, res) => {
  const { name, deployDir, branch, buildCmd, pm2Name } = req.body;
  if (!name || !deployDir) return res.status(400).json({ error: 'name and deployDir required' });
  try {
    const hook = deploy.createHook(req.user.sub, { name, deployDir, branch, buildCmd, pm2Name });
    audit(req, 'deploy_hook_create', name, { deployDir }, 'ok');
    res.status(201).json(hook);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/deploy/:id — update hook
router.put('/:id', requireAuth, (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const hook = deploy.getHook(id);
  if (!hook) return res.status(404).json({ error: 'Not found' });
  if (hook.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    res.json(deploy.updateHook(id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/deploy/:id
router.delete('/:id', requireAuth, (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const hook = deploy.getHook(id);
  if (!hook) return res.status(404).json({ error: 'Not found' });
  if (hook.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  deploy.deleteHook(id);
  audit(req, 'deploy_hook_delete', hook.name, null, 'ok');
  res.json({ ok: true });
});

// GET /api/deploy/:id/history
router.get('/:id/history', requireAuth, (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const hook = deploy.getHook(id);
  if (!hook) return res.status(404).json({ error: 'Not found' });
  if (hook.user_id !== req.user.sub && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(deploy.listHistory(id));
});

// POST /api/webhook/:id — inbound webhook (no auth — verified by HMAC)
// Raw body needed for HMAC — mount with express.raw() in index.js
router.post('/webhook/:id', express.raw({ type: '*/*' }), async (req, res) => {
  const hook = deploy.getHook(parseInt(req.params.id, 10));
  if (!hook) return res.status(404).json({ error: 'Not found' });

  const sig = req.headers['x-hub-signature-256'] || req.headers['x-gitlab-token'] || '';
  if (!deploy.verifySignature(req.body, hook.secret, sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse GitHub/GitLab payload — body is a Buffer at this point
  let payload = {};
  try {
    const parsed = JSON.parse(req.body.toString());
    payload = {
      commitSha: parsed.after                             || parsed.checkout_sha,
      commitMsg: parsed.head_commit?.message             || parsed.commits?.[0]?.message,
      pusher:    parsed.pusher?.name                     || parsed.user_username,
      branch:    parsed.ref?.replace('refs/heads/', '')  || parsed.object_ref,
    };
  } catch { /* non-JSON ping event */ }

  // Only deploy if branch matches
  if (payload.branch && payload.branch !== hook.branch) {
    return res.json({ skipped: true, reason: `branch ${payload.branch} != ${hook.branch}` });
  }

  // Fire and forget — respond immediately so GitHub doesn't retry
  res.json({ queued: true });

  deploy.runDeploy(hook, payload, { user: 'webhook', ip: req.ip }).catch(err => {
    console.error('[deploy] runDeploy error:', err.message);
  });
});

module.exports = router;
