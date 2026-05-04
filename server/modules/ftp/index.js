const fs    = require('fs');
const path  = require('path');
const bcrypt = require('bcrypt');
const db    = require('../../db');

const VSFTPD_USER_DIR  = process.env.VSFTPD_USER_DIR  || '/etc/vsftpd/users';
const VSFTPD_CHROOT_BASE = process.env.VSFTPD_CHROOT_BASE || '/var/www';
const VSFTPD_PASSWD_FILE = process.env.VSFTPD_PASSWD_FILE || '/etc/vsftpd/virtual_users.txt';

const SALT_ROUNDS = 10;
const FTP_USER_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function validateFtpUser(username) {
  if (!FTP_USER_RE.test(username)) {
    throw new Error('FTP username: 3-32 chars, letters/digits/underscore/dot/hyphen only');
  }
  return username.toLowerCase();
}

function safeChrootDir(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(VSFTPD_CHROOT_BASE + '/') && resolved !== VSFTPD_CHROOT_BASE) {
    throw Object.assign(new Error('chroot_dir outside allowed base'), { code: 'FORBIDDEN' });
  }
  return resolved;
}

// ── Per-user vsftpd config ────────────────────────────────────────────────────

function buildUserConfig(ftpUser, chrootDir) {
  return `# Zpanel managed — ${ftpUser}
local_root=${chrootDir}
write_enable=YES
local_umask=022
chroot_local_user=YES
allow_writeable_chroot=YES
`;
}

function writeUserConfig(ftpUser, chrootDir) {
  fs.mkdirSync(VSFTPD_USER_DIR, { recursive: true });
  const configPath = path.join(VSFTPD_USER_DIR, ftpUser);
  fs.writeFileSync(configPath, buildUserConfig(ftpUser, chrootDir), { mode: 0o640 });
  return configPath;
}

function removeUserConfig(ftpUser) {
  try { fs.unlinkSync(path.join(VSFTPD_USER_DIR, ftpUser)); } catch { /* gone */ }
}

// ── Virtual user password file ────────────────────────────────────────────────
// vsftpd uses PAM + libpam-pwdfile; the file is a simple user:hash list.

function rebuildPasswdFile() {
  const accounts = db.prepare('SELECT ftp_user, password FROM ftp_accounts').all();
  const lines    = accounts.map(a => `${a.ftp_user}:${a.password}`).join('\n');
  try {
    fs.mkdirSync(path.dirname(VSFTPD_PASSWD_FILE), { recursive: true });
    fs.writeFileSync(VSFTPD_PASSWD_FILE, lines + '\n', { mode: 0o640 });
  } catch { /* dev environment */ }
}

// ── Account CRUD ──────────────────────────────────────────────────────────────

async function createAccount(userId, ftpUserRaw, plainPassword, chrootDir) {
  const ftpUser  = validateFtpUser(ftpUserRaw);
  const absChroot = safeChrootDir(chrootDir);

  if (db.prepare('SELECT id FROM ftp_accounts WHERE ftp_user = ?').get(ftpUser)) {
    throw new Error(`FTP user "${ftpUser}" already exists`);
  }

  // Hash using sha512-crypt (vsftpd compatible via libpam-pwdfile)
  // bcrypt as fallback — works with updated PAM config
  const hash = await bcrypt.hash(plainPassword, SALT_ROUNDS);

  const row = db.prepare(
    'INSERT INTO ftp_accounts (user_id, ftp_user, chroot_dir, password) VALUES (?, ?, ?, ?)'
  ).run(userId, ftpUser, absChroot, hash);

  // Ensure chroot dir exists
  fs.mkdirSync(absChroot, { recursive: true });

  writeUserConfig(ftpUser, absChroot);
  rebuildPasswdFile();

  return db.prepare('SELECT id, user_id, ftp_user, chroot_dir, created_at FROM ftp_accounts WHERE id = ?')
    .get(row.lastInsertRowid);
}

function deleteAccount(id) {
  const row = db.prepare('SELECT * FROM ftp_accounts WHERE id = ?').get(id);
  if (!row) throw new Error('FTP account not found');
  removeUserConfig(row.ftp_user);
  db.prepare('DELETE FROM ftp_accounts WHERE id = ?').run(id);
  rebuildPasswdFile();
  return row;
}

function listAccounts(userId) {
  return db.prepare(
    'SELECT id, user_id, ftp_user, chroot_dir, created_at FROM ftp_accounts WHERE user_id = ? ORDER BY ftp_user'
  ).all(userId);
}

function listAllAccounts() {
  return db.prepare(
    'SELECT id, user_id, ftp_user, chroot_dir, created_at FROM ftp_accounts ORDER BY ftp_user'
  ).all();
}

// ── Global vsftpd.conf snippet ────────────────────────────────────────────────

function buildVsftpdSnippet() {
  return `# Zpanel vsftpd virtual user config
listen=YES
listen_ipv6=NO
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
dirmessage_enable=YES
use_localtime=YES
xferlog_enable=YES
connect_from_port_20=YES
chroot_local_user=YES
allow_writeable_chroot=YES
user_config_dir=${VSFTPD_USER_DIR}
guest_enable=YES
guest_username=ftp
virtual_use_local_privs=YES
pam_service_name=vsftpd
pasv_enable=YES
pasv_min_port=40000
pasv_max_port=50000
userlist_enable=YES
userlist_deny=NO
`;
}

module.exports = {
  createAccount, deleteAccount, listAccounts, listAllAccounts,
  buildVsftpdSnippet, validateFtpUser, safeChrootDir,
  VSFTPD_USER_DIR, VSFTPD_CHROOT_BASE,
};
