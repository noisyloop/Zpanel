const { spawn } = require('child_process');
const { appendFileSync, mkdirSync } = require('fs');
const path = require('path');

// Whitelist: command -> allowed argument patterns
// Each entry is [executablePath, allowedArgPatterns[]]
// allowedArgPatterns are exact strings or RegExp. Unlisted commands are rejected.
const COMMAND_WHITELIST = {
  df:         { bin: 'df',         argPatterns: [/^-[hk]?$/, /^\/$/, /^\/[a-z0-9/_-]+$/i] },
  free:       { bin: 'free',       argPatterns: [/^-[mb]$/] },
  uptime:     { bin: 'uptime',     argPatterns: [] },
  hostname:   { bin: 'hostname',   argPatterns: [] },
  uname:      { bin: 'uname',      argPatterns: [/^-[a-z]$/] },
  id:         { bin: 'id',         argPatterns: [] },

  // Phase 2 — Nginx / DNS / SSL
  nginx:       { bin: 'nginx',      argPatterns: ['-t', '-s', 'reload', 'stop', 'quit'] },
  systemctl:   { bin: 'systemctl',  argPatterns: ['reload', 'restart', 'status', 'nginx', 'bind9', 'named'] },
  certbot:     { bin: 'certbot',    argPatterns: ['--nginx', 'renew', '--non-interactive', '--agree-tos',
                                                   /^-d$/, /^[a-zA-Z0-9*._-]+\.[a-zA-Z]{2,}$/,
                                                   /^--email=[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,
                                                   '--expand', '--redirect', '--dry-run'] },
  'named-checkzone': { bin: 'named-checkzone', argPatterns: [/^[a-zA-Z0-9._-]+\.$/, /^\/[a-zA-Z0-9/_.-]+$/] },
};

const LOG_DIR = path.join(__dirname, '../logs');
mkdirSync(LOG_DIR, { recursive: true });
const AUDIT_LOG = path.join(LOG_DIR, 'shell-audit.log');

function auditLog(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
  try { appendFileSync(AUDIT_LOG, line); } catch { /* non-fatal */ }
}

function validateArgs(command, args) {
  const entry = COMMAND_WHITELIST[command];
  if (!entry) throw new Error(`Command not whitelisted: ${command}`);

  for (const arg of args) {
    const ok = entry.argPatterns.some(p =>
      p instanceof RegExp ? p.test(arg) : p === arg
    );
    if (!ok) throw new Error(`Argument not allowed for ${command}: ${arg}`);
  }
  return entry.bin;
}

/**
 * Run a whitelisted command with explicit arg array.
 * Returns a Promise that resolves to { stdout, stderr, code }.
 * Also emits events if caller needs streaming (see runStreaming).
 */
function run(command, args = [], context = {}) {
  const bin = validateArgs(command, args);

  auditLog({ command, args, user: context.user || 'system', ip: context.ip || null });

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { shell: false });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => {
      auditLog({ command, args, error: err.message, user: context.user || 'system' });
      reject(err);
    });

    proc.on('close', code => {
      auditLog({ command, args, code, user: context.user || 'system' });
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Streaming variant — returns the ChildProcess so the caller can
 * pipe stdout/stderr to a WebSocket or SSE stream.
 */
function runStreaming(command, args = [], context = {}) {
  const bin = validateArgs(command, args);
  auditLog({ command, args, streaming: true, user: context.user || 'system', ip: context.ip || null });
  return spawn(bin, args, { shell: false });
}

module.exports = { run, runStreaming, COMMAND_WHITELIST };
