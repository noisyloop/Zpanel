const crypto = require('crypto');
const path   = require('path');
const shell  = require('../../shell');
const db     = require('../../db');

// ── Hook CRUD ─────────────────────────────────────────────────────────────────

const DEPLOY_DIR_RE = /^\/[a-zA-Z0-9/_.-]{1,200}$/;
const BUILD_CMD_RE  = /^[a-zA-Z0-9 /._@%+:=\-]{1,256}$/;
const BRANCH_RE     = /^[a-zA-Z0-9/_.-]{1,100}$/;
const PM2_NAME_RE   = /^[a-zA-Z0-9_.-]{1,64}$/;

function validateHookParams({ deployDir, branch, buildCmd, pm2Name }) {
  if (!DEPLOY_DIR_RE.test(deployDir)) throw new Error('Invalid deploy_dir');
  if (branch && !BRANCH_RE.test(branch)) throw new Error('Invalid branch name');
  if (buildCmd && !BUILD_CMD_RE.test(buildCmd)) throw new Error('Invalid build_cmd');
  if (pm2Name && !PM2_NAME_RE.test(pm2Name)) throw new Error('Invalid pm2_name');
}

function createHook(userId, { name, deployDir, branch = 'main', buildCmd = null, pm2Name = null }) {
  validateHookParams({ deployDir, branch, buildCmd, pm2Name });
  const secret = crypto.randomBytes(32).toString('hex');
  const row = db.prepare(
    `INSERT INTO deploy_hooks (user_id, name, deploy_dir, branch, secret, build_cmd, pm2_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, name, deployDir, branch, secret, buildCmd, pm2Name);
  return db.prepare('SELECT * FROM deploy_hooks WHERE id = ?').get(row.lastInsertRowid);
}

function updateHook(id, fields) {
  const hook = db.prepare('SELECT * FROM deploy_hooks WHERE id = ?').get(id);
  if (!hook) throw new Error('Hook not found');
  const params = {
    deployDir: fields.deployDir ?? hook.deploy_dir,
    branch:    fields.branch    ?? hook.branch,
    buildCmd:  fields.buildCmd  ?? hook.build_cmd,
    pm2Name:   fields.pm2Name   ?? hook.pm2_name,
  };
  validateHookParams(params);
  db.prepare(
    `UPDATE deploy_hooks SET name=?, deploy_dir=?, branch=?, build_cmd=?, pm2_name=? WHERE id=?`
  ).run(fields.name ?? hook.name, params.deployDir, params.branch,
        params.buildCmd, params.pm2Name, id);
  return db.prepare('SELECT * FROM deploy_hooks WHERE id = ?').get(id);
}

function deleteHook(id) {
  const hook = db.prepare('SELECT * FROM deploy_hooks WHERE id = ?').get(id);
  if (!hook) throw new Error('Hook not found');
  db.prepare('DELETE FROM deploy_hooks WHERE id = ?').run(id);
  return hook;
}

function getHook(id) {
  return db.prepare('SELECT * FROM deploy_hooks WHERE id = ?').get(id);
}

function listHooks(userId) {
  return db.prepare('SELECT * FROM deploy_hooks WHERE user_id = ? ORDER BY name').all(userId);
}

// ── HMAC verification ─────────────────────────────────────────────────────────

function verifySignature(rawBody, secret, signatureHeader) {
  // GitHub: X-Hub-Signature-256: sha256=<hex>
  // GitLab: X-Gitlab-Token: <secret>
  if (!signatureHeader) return false;

  if (signatureHeader.startsWith('sha256=')) {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  }

  // GitLab plain token
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(secret));
  } catch {
    return false;
  }
}

// ── Deploy execution ──────────────────────────────────────────────────────────

async function runDeploy(hook, payload, context = {}) {
  const histRow = db.prepare(
    `INSERT INTO deploy_history (hook_id, commit_sha, commit_msg, triggered_by, status)
     VALUES (?, ?, ?, ?, 'running')`
  ).run(
    hook.id,
    payload.commitSha  || null,
    payload.commitMsg  || null,
    payload.pusher     || 'webhook',
  );
  const histId = histRow.lastInsertRowid;

  const lines = [];
  const log   = msg => lines.push(msg);

  try {
    // git pull
    log(`[deploy] git pull in ${hook.deploy_dir}`);
    const pull = await shell.run('git', ['-C', hook.deploy_dir, 'pull', 'origin', hook.branch], context);
    log(pull.stdout.trim() || pull.stderr.trim());
    if (pull.code !== 0) throw new Error(`git pull failed:\n${pull.stderr}`);

    // optional build step (npm install or composer install)
    if (hook.build_cmd) {
      log(`[deploy] build: ${hook.build_cmd}`);
      const [cmd, ...args] = hook.build_cmd.trim().split(/\s+/);
      const build = await shell.run(cmd, args, context);
      log(build.stdout.trim() || build.stderr.trim());
      if (build.code !== 0) throw new Error(`Build failed:\n${build.stderr}`);
    }

    // pm2 restart
    if (hook.pm2_name) {
      log(`[deploy] pm2 restart ${hook.pm2_name}`);
      await shell.run('pm2', ['restart', hook.pm2_name], context);
      await shell.run('pm2', ['save'], context);
    }

    // Get HEAD commit after pull
    const rev = await shell.run('git', ['-C', hook.deploy_dir, 'rev-parse', 'HEAD'], context);
    const sha = rev.stdout.trim().slice(0, 8);
    log(`[deploy] Done. HEAD: ${sha}`);

    db.prepare(
      `UPDATE deploy_history SET status='success', output=?, finished_at=datetime('now') WHERE id=?`
    ).run(lines.join('\n'), histId);

    return { success: true, output: lines.join('\n'), histId };
  } catch (err) {
    log(`[deploy] ERROR: ${err.message}`);
    db.prepare(
      `UPDATE deploy_history SET status='failed', output=?, finished_at=datetime('now') WHERE id=?`
    ).run(lines.join('\n'), histId);
    return { success: false, output: lines.join('\n'), error: err.message, histId };
  }
}

function listHistory(hookId, limit = 20) {
  return db.prepare(
    'SELECT * FROM deploy_history WHERE hook_id = ? ORDER BY id DESC LIMIT ?'
  ).all(hookId, limit);
}

module.exports = {
  createHook, updateHook, deleteHook, getHook, listHooks,
  verifySignature, runDeploy, listHistory, validateHookParams,
};
