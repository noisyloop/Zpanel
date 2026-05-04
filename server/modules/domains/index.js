const db    = require('../../db');
const vhost = require('./vhost');
const path  = require('path');

function defaultDocRoot(username, domain) {
  return path.join(vhost.VHOST_ROOT, username, domain, 'public_html');
}

function create(userId, username, domain, opts = {}) {
  vhost.safeDomain(domain);
  const docRoot = opts.docRoot || defaultDocRoot(username, domain);
  vhost.safeDocRoot(docRoot);

  const row = db.prepare(
    `INSERT INTO domains (user_id, domain, doc_root, is_subdomain, parent_domain)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, domain, docRoot, opts.isSubdomain ? 1 : 0, opts.parentDomain || null);

  return db.prepare('SELECT * FROM domains WHERE id = ?').get(row.lastInsertRowid);
}

function list(userId) {
  return db.prepare('SELECT * FROM domains WHERE user_id = ? ORDER BY domain').all(userId);
}

function listAll() {
  return db.prepare('SELECT * FROM domains ORDER BY domain').all();
}

function get(id) {
  return db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
}

function getByDomain(domain) {
  return db.prepare('SELECT * FROM domains WHERE domain = ?').get(domain);
}

function remove(id) {
  db.prepare('DELETE FROM domains WHERE id = ?').run(id);
}

module.exports = { create, list, listAll, get, getByDomain, remove, defaultDocRoot };
