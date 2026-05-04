const shell = require('../../shell');

// ── PM2 JSON list ─────────────────────────────────────────────────────────────

async function list(context = {}) {
  const { stdout, code } = await shell.run('pm2', ['jlist'], context);
  if (code !== 0) return [];
  try {
    const raw = JSON.parse(stdout);
    return raw.map(proc => ({
      id:       proc.pm_id,
      name:     proc.name,
      status:   proc.pm2_env?.status ?? 'unknown',
      pid:      proc.pid,
      uptime:   proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
      restarts: proc.pm2_env?.restart_time ?? 0,
      cpu:      proc.monit?.cpu ?? 0,
      memMb:    proc.monit?.memory ? Math.round(proc.monit.memory / 1024 / 1024) : 0,
      cwd:      proc.pm2_env?.pm_cwd ?? null,
    }));
  } catch {
    return [];
  }
}

// ── Single process actions ────────────────────────────────────────────────────

// `nameOrId` is validated to be alphanumeric (safe for the whitelist)
function safeName(n) {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(String(n))) {
    throw new Error(`Invalid PM2 process name/id: ${n}`);
  }
  return String(n);
}

async function start(nameOrId, context = {}) {
  return shell.run('pm2', ['start', safeName(nameOrId)], context);
}

async function stop(nameOrId, context = {}) {
  return shell.run('pm2', ['stop', safeName(nameOrId)], context);
}

async function restart(nameOrId, context = {}) {
  return shell.run('pm2', ['restart', safeName(nameOrId)], context);
}

async function remove(nameOrId, context = {}) {
  const r = await shell.run('pm2', ['delete', safeName(nameOrId)], context);
  await shell.run('pm2', ['save'], context);
  return r;
}

async function save(context = {}) {
  return shell.run('pm2', ['save'], context);
}

// ── Log tail (streaming) ──────────────────────────────────────────────────────
// Returns a ChildProcess — caller pipes stdout to WebSocket.

function tailLogs(nameOrId, lines = 50, context = {}) {
  return shell.runStreaming('pm2', ['logs', safeName(nameOrId), '--lines', String(lines)], context);
}

module.exports = { list, start, stop, restart, remove, save, tailLogs, safeName };
