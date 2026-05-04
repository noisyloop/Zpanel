const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const shell  = require('../../shell');
const db     = require('../../db');
const dbs    = require('../databases');

// Latest WordPress download URL (stable)
const WP_URL = 'https://wordpress.org/latest.tar.gz';

// ── Path safety ───────────────────────────────────────────────────────────────

const INSTALL_BASE = process.env.VHOST_ROOT || '/var/www';

function safeInstallDir(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(INSTALL_BASE + '/') && resolved !== INSTALL_BASE) {
    throw Object.assign(new Error('install_dir outside allowed base'), { code: 'FORBIDDEN' });
  }
  return resolved;
}

// ── Progress emitter helper ───────────────────────────────────────────────────
// Callers pass an `onLog` callback to receive step-by-step progress strings.

function log(onLog, msg) { if (onLog) onLog(msg); }

// ── WordPress installer ───────────────────────────────────────────────────────

async function installWordPress({ userId, domainId, installDir, dbName, dbUser, dbPassword, siteUrl, adminEmail }, context = {}, onLog) {
  const absDir = safeInstallDir(installDir);
  fs.mkdirSync(absDir, { recursive: true });

  log(onLog, 'Creating database…');
  await dbs.createDatabase(userId, dbName, dbUser, dbPassword);

  log(onLog, 'Downloading WordPress…');
  const archive = `/tmp/wp-${crypto.randomBytes(4).toString('hex')}.tar.gz`;
  const dl = await shell.run('wget', ['-q', '-O', archive, WP_URL], context);
  if (dl.code !== 0) throw new Error(`Download failed: ${dl.stderr}`);

  log(onLog, 'Extracting…');
  const ex = await shell.run('tar', ['-xzf', archive, '--strip-components=1', '-C', absDir], context);
  if (ex.code !== 0) throw new Error(`Extraction failed: ${ex.stderr}`);
  try { fs.unlinkSync(archive); } catch { /* temp file */ }

  log(onLog, 'Writing wp-config.php…');
  writeWpConfig(absDir, dbName, dbUser, dbPassword, siteUrl);

  log(onLog, 'Setting permissions…');
  await shell.run('chmod', ['-R', '755', absDir], context);
  await shell.run('chown', ['-R', `www-data:www-data`, absDir], context);

  const row = db.prepare(
    `INSERT INTO installed_apps (user_id, domain_id, app_type, app_version, install_dir, db_name, db_user, status)
     VALUES (?, ?, 'wordpress', 'latest', ?, ?, ?, 'active')`
  ).run(userId, domainId || null, absDir, dbName, dbUser);

  log(onLog, `Done. Visit ${siteUrl}/wp-admin to complete setup.`);
  return db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(row.lastInsertRowid);
}

function writeWpConfig(dir, dbName, dbUser, dbPass, siteUrl) {
  // Generate unique keys/salts
  const salt = () => crypto.randomBytes(32).toString('base64').slice(0, 64);
  const content = `<?php
define('DB_NAME',     '${dbName}');
define('DB_USER',     '${dbUser}');
define('DB_PASSWORD', '${dbPass}');
define('DB_HOST',     'localhost');
define('DB_CHARSET',  'utf8mb4');
define('DB_COLLATE',  '');

define('AUTH_KEY',         '${salt()}');
define('SECURE_AUTH_KEY',  '${salt()}');
define('LOGGED_IN_KEY',    '${salt()}');
define('NONCE_KEY',        '${salt()}');
define('AUTH_SALT',        '${salt()}');
define('SECURE_AUTH_SALT', '${salt()}');
define('LOGGED_IN_SALT',   '${salt()}');
define('NONCE_SALT',       '${salt()}');

$table_prefix = 'wp_';
define('WP_DEBUG', false);
define('WP_SITEURL', '${siteUrl}');
define('WP_HOME',    '${siteUrl}');

if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
`;
  fs.writeFileSync(path.join(dir, 'wp-config.php'), content, { mode: 0o640 });
}

// ── Ghost installer ───────────────────────────────────────────────────────────

async function installGhost({ userId, domainId, installDir, siteUrl, pm2Name }, context = {}, onLog) {
  const absDir = safeInstallDir(installDir);
  fs.mkdirSync(absDir, { recursive: true });

  log(onLog, 'Installing Ghost via npm…');
  const install = await shell.run('npm', ['install', '--prefix', absDir, 'ghost-cli', '--production'], context);
  if (install.code !== 0) throw new Error(`npm install failed: ${install.stderr}`);

  log(onLog, 'Writing Ghost config…');
  writeGhostConfig(absDir, siteUrl);

  const name = pm2Name || `ghost-${crypto.randomBytes(3).toString('hex')}`;

  log(onLog, `Starting with PM2 as "${name}"…`);
  const startArgs = ['start', path.join(absDir, 'node_modules/.bin/ghost'),
    '--name', name, '--cwd', absDir];
  const start = await shell.run('pm2', startArgs, context);
  if (start.code !== 0) throw new Error(`PM2 start failed: ${start.stderr}`);

  await shell.run('pm2', ['save'], context);

  const row = db.prepare(
    `INSERT INTO installed_apps (user_id, domain_id, app_type, app_version, install_dir, pm2_name, status)
     VALUES (?, ?, 'ghost', 'latest', ?, ?, 'active')`
  ).run(userId, domainId || null, absDir, name);

  log(onLog, `Ghost running as PM2 process "${name}".`);
  return db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(row.lastInsertRowid);
}

function writeGhostConfig(dir, siteUrl) {
  const cfg = {
    url: siteUrl,
    server:   { port: 2368, host: '127.0.0.1' },
    database: { client: 'sqlite3', connection: { filename: path.join(dir, 'content/data/ghost.db') } },
    mail:     { transport: 'Direct' },
    logging:  { transports: ['file', 'stdout'] },
    process:  'local',
    paths:    { contentPath: path.join(dir, 'content') },
  };
  fs.mkdirSync(path.join(dir, 'content/data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.production.json'), JSON.stringify(cfg, null, 2));
}

// ── Static site installer ─────────────────────────────────────────────────────

async function installStatic({ userId, domainId, installDir, archivePath }, context = {}, onLog) {
  const absDir  = safeInstallDir(installDir);
  const absZip  = path.resolve(archivePath);
  fs.mkdirSync(absDir, { recursive: true });

  log(onLog, 'Extracting archive…');
  const ex = await shell.run('unzip', ['-q', '-o', absZip, '-d', absDir], context);
  if (ex.code !== 0) throw new Error(`Unzip failed: ${ex.stderr}`);

  log(onLog, 'Setting permissions…');
  await shell.run('chmod', ['-R', '755', absDir], context);
  await shell.run('chown', ['-R', 'www-data:www-data', absDir], context);

  const row = db.prepare(
    `INSERT INTO installed_apps (user_id, domain_id, app_type, install_dir, status)
     VALUES (?, ?, 'static', ?, 'active')`
  ).run(userId, domainId || null, absDir);

  log(onLog, 'Static site deployed.');
  return db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(row.lastInsertRowid);
}

// ── Uninstaller ───────────────────────────────────────────────────────────────

async function uninstall(id, context = {}, onLog) {
  const app = db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(id);
  if (!app) throw new Error('App not found');

  log(onLog, `Uninstalling ${app.app_type} from ${app.install_dir}…`);

  // Stop PM2 process if present
  if (app.pm2_name) {
    try {
      await shell.run('pm2', ['delete', app.pm2_name], context);
      await shell.run('pm2', ['save'], context);
      log(onLog, `Stopped PM2 process "${app.pm2_name}".`);
    } catch { /* process may already be gone */ }
  }

  // Drop database if WordPress
  if (app.db_name) {
    try {
      const dbRow = db.prepare('SELECT id FROM databases WHERE db_name = ?').get(app.db_name);
      if (dbRow) { await dbs.dropDatabase(dbRow.id); log(onLog, 'Database dropped.'); }
    } catch (err) { log(onLog, `DB drop warning: ${err.message}`); }
  }

  // Remove files
  try {
    fs.rmSync(app.install_dir, { recursive: true, force: true });
    log(onLog, 'Files removed.');
  } catch (err) { log(onLog, `File removal warning: ${err.message}`); }

  db.prepare("UPDATE installed_apps SET status='removed' WHERE id=?").run(id);
  log(onLog, 'Done.');
  return app;
}

function listApps(userId) {
  return db.prepare('SELECT * FROM installed_apps WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function listAllApps() {
  return db.prepare('SELECT * FROM installed_apps ORDER BY created_at DESC').all();
}

module.exports = {
  installWordPress, installGhost, installStatic, uninstall,
  listApps, listAllApps, safeInstallDir,
};
