const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
require('dotenv').config();

const FILE_ROOT = path.resolve(process.env.FILE_ROOT || '/var/www');

/**
 * Resolve a user-supplied path and verify it stays inside FILE_ROOT.
 * Throws if the resolved path escapes the root (path traversal attempt).
 */
function safePath(userPath) {
  const resolved = path.resolve(FILE_ROOT, userPath.replace(/^\/+/, ''));
  if (!resolved.startsWith(FILE_ROOT + path.sep) && resolved !== FILE_ROOT) {
    throw Object.assign(new Error('Path outside allowed root'), { code: 'FORBIDDEN' });
  }
  return resolved;
}

// ── Directory listing ─────────────────────────────────────────────────────────

function listDir(userPath) {
  const abs = safePath(userPath);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  return entries.map(e => {
    const fullPath = path.join(abs, e.name);
    let stat;
    try { stat = fs.statSync(fullPath); } catch { stat = null; }
    return {
      name:     e.name,
      type:     e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file',
      size:     stat?.size ?? 0,
      mode:     stat ? (stat.mode & 0o777).toString(8).padStart(3, '0') : '???',
      modified: stat?.mtime?.toISOString() ?? null,
    };
  });
}

// ── Read file as stream ───────────────────────────────────────────────────────

function readStream(userPath) {
  const abs = safePath(userPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
  return { stream: fs.createReadStream(abs), stat, name: path.basename(abs) };
}

// ── Rename ────────────────────────────────────────────────────────────────────

function rename(fromPath, toPath) {
  const absFrom = safePath(fromPath);
  const absTo   = safePath(toPath);
  fs.renameSync(absFrom, absTo);
}

// ── Delete ────────────────────────────────────────────────────────────────────

function remove(userPath) {
  const abs = safePath(userPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    fs.rmSync(abs, { recursive: true, force: true });
  } else {
    fs.unlinkSync(abs);
  }
}

// ── Create directory ──────────────────────────────────────────────────────────

function mkdir(userPath) {
  const abs = safePath(userPath);
  fs.mkdirSync(abs, { recursive: true });
}

// ── Save uploaded file ────────────────────────────────────────────────────────
// multer writes to a temp path; this moves it to the destination dir.

function saveUpload(tempPath, destDir, originalName) {
  const absDir  = safePath(destDir);
  // Strip any directory components from the original filename
  const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(absDir, safeName);
  fs.mkdirSync(absDir, { recursive: true });
  fs.renameSync(tempPath, destPath);
  return destPath;
}

module.exports = { safePath, listDir, readStream, rename, remove, mkdir, saveUpload, FILE_ROOT };
