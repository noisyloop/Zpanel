const os   = require('os');
const path = require('path');
const fs   = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpanel-owner-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET         = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const db           = require('../db');
const auth         = require('../auth');
const requireOwner = require('./requireOwner');

// Seed: two users, one domain owned by user1
let user1Id, user2Id, domainId;
beforeAll(() => {
  const u1 = auth.createUser('owner1', 'password123', 'user');
  const u2 = auth.createUser('owner2', 'password123', 'user');
  user1Id  = u1.lastInsertRowid;
  user2Id  = u2.lastInsertRowid;

  const row = db.prepare(
    "INSERT INTO domains (user_id, domain, doc_root) VALUES (?, ?, ?)"
  ).run(user1Id, 'owner-test.com', '/var/www/owner-test.com');
  domainId = row.lastInsertRowid;
});

function makeReq(userId, role, paramId) {
  return { user: { sub: userId, role }, params: { id: String(paramId) } };
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = (code) => { res._status = code; return res; };
  res.json   = (body)  => { res._body  = body; return res; };
  return res;
}

describe('requireOwner middleware', () => {
  const mw = requireOwner('domains');

  test('allows the resource owner through', () => {
    const req  = makeReq(user1Id, 'user', domainId);
    const res  = makeRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
  });

  test('blocks a non-owner with 403', () => {
    const req  = makeReq(user2Id, 'user', domainId);
    const res  = makeRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  test('allows admin regardless of ownership', () => {
    const req  = makeReq(user2Id, 'admin', domainId);
    const res  = makeRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('returns 404 for non-existent resource id', () => {
    const req  = makeReq(user1Id, 'user', 999999);
    const res  = makeRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(404);
  });

  test('returns 400 for non-numeric id', () => {
    const req  = makeReq(user1Id, 'user', 'abc');
    const res  = makeRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });

  test('throws at middleware creation for invalid table name', () => {
    expect(() => requireOwner('bad; DROP TABLE users--')).toThrow('invalid table name');
  });
});
