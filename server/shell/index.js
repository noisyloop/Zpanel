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

  // Phase 3 — Email / Databases / FTP / Cron
  postfix:    { bin: 'postfix',     argPatterns: ['reload', 'start', 'stop', 'status', 'flush', 'check'] },
  postmap:    { bin: 'postmap',     argPatterns: [/^hash:\/etc\/postfix\/[a-zA-Z0-9_/-]+$/] },
  newaliases: { bin: 'newaliases',  argPatterns: [] },
  doveadm:    { bin: 'doveadm',     argPatterns: ['reload', 'stop',
                                                   /^user$/i, /^quota$/i, /^get$/i, /^set$/i,
                                                   /^-u$/, /^[a-zA-Z0-9._@+-]+$/, 'recalc'] },
  'opendkim-genkey': { bin: 'opendkim-genkey',
                       argPatterns: [/^-s$/, /^[a-zA-Z0-9_-]+$/, /^-d$/, /^[a-zA-Z0-9._-]+$/, '-r', '-b', '2048'] },
  vsftpd:     { bin: 'vsftpd',      argPatterns: [/^\/etc\/vsftpd\/[a-zA-Z0-9_.-]+\.conf$/] },
  crontab:    { bin: 'crontab',     argPatterns: ['-l', '-r', /^-u$/, /^[a-zA-Z0-9_-]+$/, /^\/tmp\/[a-zA-Z0-9_./-]+$/] },

  // Phase 4 — App installer / PM2 / isolation / git deploy
  wget:        { bin: 'wget',       argPatterns: ['-q', '-O', /^\/[a-zA-Z0-9/_.-]+$/, /^https?:\/\/[a-zA-Z0-9._/%-]+$/] },
  tar:         { bin: 'tar',        argPatterns: [/^-?[xzf]+$/, /^--strip-components=\d+$/, /^-C$/, /^\/[a-zA-Z0-9/_.-]+$/] },
  unzip:       { bin: 'unzip',      argPatterns: ['-q', '-o', /^\/[a-zA-Z0-9/_.-]+$/, /^-d$/] },
  chmod:       { bin: 'chmod',      argPatterns: ['-R', /^[0-7]{3,4}$/, /^\/[a-zA-Z0-9/_.-]+$/] },
  chown:       { bin: 'chown',      argPatterns: ['-R', /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/, /^\/[a-zA-Z0-9/_.-]+$/] },
  useradd:     { bin: 'useradd',    argPatterns: ['-m', '-s', '-d', '-g', '/bin/bash', '/usr/sbin/nologin',
                                                  /^[a-zA-Z0-9_-]{1,32}$/, /^\/[a-zA-Z0-9/_.-]+$/] },
  userdel:     { bin: 'userdel',    argPatterns: ['-r', /^[a-zA-Z0-9_-]{1,32}$/] },
  setquota:    { bin: 'setquota',   argPatterns: ['-u', /^[a-zA-Z0-9_-]+$/, /^\d+$/, /^\/$/] },
  repquota:    { bin: 'repquota',   argPatterns: ['-u', '-a', /^\/$/] },
  npm:         { bin: 'npm',        argPatterns: ['install', '--prefix', /^\/[a-zA-Z0-9/_.-]+$/, '--production', '--omit=dev'] },
  composer:    { bin: 'composer',   argPatterns: ['install', '--no-dev', '--optimize-autoloader',
                                                  '--working-dir', /^\/[a-zA-Z0-9/_.-]+$/] },
  pm2:         { bin: 'pm2',        argPatterns: ['start', 'stop', 'restart', 'delete', 'save', 'startup',
                                                  'list', 'jlist', 'logs', '--lines',
                                                  /^\d+$/, /^[a-zA-Z0-9_.-]+$/, '--no-daemon',
                                                  '--name', /^[a-zA-Z0-9_.-]{1,64}$/,
                                                  '--cwd', /^\/[a-zA-Z0-9/_.-]+$/] },
  git:         { bin: 'git',        argPatterns: ['-C', 'pull', 'fetch', 'checkout', 'rev-parse', 'log',
                                                  '--oneline', '-1', 'HEAD', 'origin',
                                                  /^\/[a-zA-Z0-9/_.-]+$/, /^[a-zA-Z0-9_./\-]+$/] },

  // Phase 6 — Backups
  mysqldump:   { bin: 'mysqldump',  argPatterns: [
                   /^--host=[a-zA-Z0-9._-]+$/, /^--port=\d+$/,
                   /^--user=[a-zA-Z0-9_-]+$/, /^--password=.*$/,
                   '--no-tablespaces', '--single-transaction', '--quick', '--routines',
                   '--result-file', /^\/[a-zA-Z0-9/_.-]+$/, /^[a-zA-Z0-9_]{1,64}$/ ] },
  mysql:       { bin: 'mysql',      argPatterns: [
                   /^--host=[a-zA-Z0-9._-]+$/, /^--port=\d+$/,
                   /^--user=[a-zA-Z0-9_-]+$/, /^--password=.*/,
                   /^--database=[a-zA-Z0-9_]{1,64}$/, '-e',
                   /^[a-zA-Z0-9 _*()',";=<>!.-]+$/ ] },
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
