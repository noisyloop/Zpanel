const fs    = require('fs');
const path  = require('path');
const bcrypt = require('bcrypt');
const db    = require('../../db');
const shell = require('../../shell');

const VIRTUAL_MAILBOX_BASE = process.env.VIRTUAL_MAILBOX_BASE || '/var/mail/vhosts';
const POSTFIX_DIR          = process.env.POSTFIX_DIR          || '/etc/postfix';
const DKIM_DIR             = process.env.DKIM_DIR             || '/etc/opendkim/keys';

const SALT_ROUNDS = 10;

// ── Input validation ──────────────────────────────────────────────────────────

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const LOCAL_RE = /^[a-zA-Z0-9._%+\-]+$/;

function validateAddress(address) {
  if (!EMAIL_RE.test(address)) throw new Error(`Invalid email address: ${address}`);
  return address.toLowerCase();
}

function localPart(address) { return address.split('@')[0]; }
function domainPart(address) { return address.split('@')[1]; }

// ── Mailbox CRUD ──────────────────────────────────────────────────────────────

async function createMailbox(userId, domainId, address, plainPassword, quotaMb = 500, context = {}) {
  address = validateAddress(address);
  const hash = await bcrypt.hash(plainPassword, SALT_ROUNDS);

  const row = db.prepare(
    `INSERT INTO mailboxes (user_id, domain_id, address, password, quota_mb)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, domainId, address, hash, quotaMb);

  // Create maildir on disk
  const maildir = path.join(VIRTUAL_MAILBOX_BASE, domainPart(address), localPart(address));
  fs.mkdirSync(path.join(maildir, 'new'), { recursive: true });
  fs.mkdirSync(path.join(maildir, 'cur'), { recursive: true });
  fs.mkdirSync(path.join(maildir, 'tmp'), { recursive: true });

  await rebuildPostfixMaps(context);
  return db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(row.lastInsertRowid);
}

async function deleteMailbox(id, context = {}) {
  const box = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
  if (!box) throw new Error('Mailbox not found');

  db.prepare('DELETE FROM mailboxes WHERE id = ?').run(id);

  const maildir = path.join(VIRTUAL_MAILBOX_BASE, domainPart(box.address), localPart(box.address));
  try { fs.rmSync(maildir, { recursive: true, force: true }); } catch { /* best-effort */ }

  await rebuildPostfixMaps(context);
  return box;
}

function listMailboxes(userId) {
  return db.prepare(
    `SELECT m.*, d.domain FROM mailboxes m
     JOIN domains d ON d.id = m.domain_id
     WHERE m.user_id = ? ORDER BY m.address`
  ).all(userId);
}

function listAllMailboxes() {
  return db.prepare(
    `SELECT m.*, d.domain FROM mailboxes m
     JOIN domains d ON d.id = m.domain_id ORDER BY m.address`
  ).all();
}

// ── Alias CRUD ────────────────────────────────────────────────────────────────

function createAlias(domainId, source, destination) {
  source      = validateAddress(source);
  destination = validateAddress(destination);
  const row = db.prepare(
    'INSERT INTO email_aliases (domain_id, source, destination) VALUES (?, ?, ?)'
  ).run(domainId, source, destination);
  rebuildPostfixMaps().catch(() => {});
  return db.prepare('SELECT * FROM email_aliases WHERE id = ?').get(row.lastInsertRowid);
}

function deleteAlias(id) {
  db.prepare('DELETE FROM email_aliases WHERE id = ?').run(id);
  rebuildPostfixMaps().catch(() => {});
}

function listAliases(domainId) {
  return db.prepare(
    'SELECT * FROM email_aliases WHERE domain_id = ? ORDER BY source'
  ).all(domainId);
}

// ── Postfix map generation ────────────────────────────────────────────────────

/**
 * Rebuild /etc/postfix/virtual_mailbox_maps and virtual_alias_maps,
 * then call postmap to hash them so Postfix can read them.
 */
async function rebuildPostfixMaps(context = {}) {
  // virtual_mailbox_maps: address -> domain/local/
  const mailboxes = db.prepare('SELECT address FROM mailboxes').all();
  const vmLines   = mailboxes.map(m =>
    `${m.address}    ${domainPart(m.address)}/${localPart(m.address)}/`
  ).join('\n');

  // virtual_alias_maps: source -> destination
  const aliases   = db.prepare('SELECT source, destination FROM email_aliases').all();
  const vaLines   = aliases.map(a => `${a.source}    ${a.destination}`).join('\n');

  // Unique virtual domains
  const vdomains  = [...new Set(mailboxes.map(m => domainPart(m.address)))];
  const vdLines   = vdomains.join('\n');

  writePostfixFile('virtual_mailbox_maps',   vmLines);
  writePostfixFile('virtual_alias_maps',     vaLines);
  writePostfixFile('virtual_mailbox_domains', vdLines);

  // postmap to hash — best-effort, Postfix may not be installed in dev
  for (const f of ['virtual_mailbox_maps', 'virtual_alias_maps', 'virtual_mailbox_domains']) {
    try {
      await shell.run('postmap', [`hash:${POSTFIX_DIR}/${f}`], context);
    } catch { /* postfix not installed */ }
  }
}

function writePostfixFile(name, content) {
  try {
    fs.mkdirSync(POSTFIX_DIR, { recursive: true });
    fs.writeFileSync(path.join(POSTFIX_DIR, name), content + '\n', { mode: 0o644 });
  } catch { /* dev environment without /etc/postfix */ }
}

// ── Postfix main.cf snippet ───────────────────────────────────────────────────

/**
 * Return the block that should be appended to /etc/postfix/main.cf
 * for virtual mailbox hosting. Shown to the admin in the UI.
 */
function buildMainCfSnippet(hostname) {
  return `# Zpanel virtual mailbox configuration
myhostname = ${hostname || 'mail.example.com'}
virtual_mailbox_domains = hash:${POSTFIX_DIR}/virtual_mailbox_domains
virtual_mailbox_base    = ${VIRTUAL_MAILBOX_BASE}
virtual_mailbox_maps    = hash:${POSTFIX_DIR}/virtual_mailbox_maps
virtual_alias_maps      = hash:${POSTFIX_DIR}/virtual_alias_maps
virtual_uid_maps        = static:5000
virtual_gid_maps        = static:5000
virtual_mailbox_limit   = 0
`;
}

// ── Dovecot passwd-file line ──────────────────────────────────────────────────

/**
 * Build a line for /etc/dovecot/users (passwd-file format).
 * The password stored in DB is already bcrypt — Dovecot needs it prefixed.
 */
function buildDovecotUserLine(mailbox) {
  return `${mailbox.address}:{BLF-CRYPT}${mailbox.password}::::::userdb_quota_rule=*:storage=${mailbox.quota_mb}M`;
}

async function rebuildDovecotPasswd(context = {}) {
  const mailboxes = db.prepare('SELECT * FROM mailboxes').all();
  const lines     = mailboxes.map(buildDovecotUserLine).join('\n');
  try {
    fs.mkdirSync('/etc/dovecot', { recursive: true });
    fs.writeFileSync('/etc/dovecot/zpanel-users', lines + '\n', { mode: 0o640 });
    await shell.run('doveadm', ['reload'], context);
  } catch { /* not installed in dev */ }
}

// ── DKIM key generation ───────────────────────────────────────────────────────

async function generateDkimKey(domain, selector = 'mail', context = {}) {
  const keyDir = path.join(DKIM_DIR, domain);
  fs.mkdirSync(keyDir, { recursive: true });

  await shell.run('opendkim-genkey', ['-s', selector, '-d', domain, '-r', '-b', '2048'], context);

  // opendkim-genkey writes to CWD — move to keyDir
  for (const ext of ['private', 'txt']) {
    const src  = path.join(process.cwd(), `${selector}.${ext}`);
    const dest = path.join(keyDir, `${selector}.${ext}`);
    try { fs.renameSync(src, dest); } catch { /* already there */ }
  }

  // Read the public key TXT record value
  const txtFile = path.join(keyDir, `${selector}.txt`);
  const txtContent = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8') : null;
  return { keyDir, selector, txtContent };
}

// ── Recommended DNS records for email ────────────────────────────────────────

function buildEmailDnsRecords(domain, serverIp, dkimPublicKey, selector = 'mail') {
  return [
    { type: 'MX',  name: '@',                         value: `mail.${domain}`, ttl: 3600, priority: 10 },
    { type: 'A',   name: 'mail',                      value: serverIp,         ttl: 3600 },
    { type: 'TXT', name: '@',                         value: `v=spf1 mx a ip4:${serverIp} ~all`, ttl: 3600 },
    { type: 'TXT', name: `${selector}._domainkey`,   value: dkimPublicKey || `v=DKIM1; k=rsa; p=<your-public-key>`, ttl: 3600 },
    { type: 'TXT', name: '_dmarc',                   value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}; pct=100`, ttl: 3600 },
  ];
}

module.exports = {
  createMailbox, deleteMailbox, listMailboxes, listAllMailboxes,
  createAlias, deleteAlias, listAliases,
  rebuildPostfixMaps, rebuildDovecotPasswd,
  buildMainCfSnippet, generateDkimKey, buildEmailDnsRecords,
  validateAddress, VIRTUAL_MAILBOX_BASE,
};
