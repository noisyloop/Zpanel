const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Override FILE_ROOT to a temp dir for tests
process.env.FILE_ROOT = os.tmpdir();

const files = require('./index');

describe('safePath', () => {
  test('allows path inside root', () => {
    const result = files.safePath('subdir/file.txt');
    expect(result.startsWith(os.tmpdir())).toBe(true);
  });

  test('blocks path traversal with ..', () => {
    expect(() => files.safePath('../../etc/passwd')).toThrow('outside allowed root');
  });

  test('strips leading slash and stays inside root', () => {
    // Leading slash is stripped — /etc/passwd becomes FILE_ROOT/etc/passwd, which is safe
    const result = files.safePath('/etc/passwd');
    expect(result.startsWith(os.tmpdir())).toBe(true);
    expect(result).toContain('etc/passwd');
  });
});

describe('listDir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpanel-test-'));
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'hi');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    // Override FILE_ROOT to tmpDir
    process.env.FILE_ROOT = tmpDir;
    jest.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.FILE_ROOT = os.tmpdir();
    jest.resetModules();
  });

  test('lists files and dirs', () => {
    const f = require('./index');
    const entries = f.listDir('/');
    const names = entries.map(e => e.name);
    expect(names).toContain('hello.txt');
    expect(names).toContain('subdir');
  });

  test('returns correct types', () => {
    const f = require('./index');
    const entries = f.listDir('/');
    const file = entries.find(e => e.name === 'hello.txt');
    const dir  = entries.find(e => e.name === 'subdir');
    expect(file.type).toBe('file');
    expect(dir.type).toBe('dir');
  });
});
