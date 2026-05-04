const path = require('path');
const os   = require('os');
const fs   = require('fs');

// Point VHOST_ROOT at a temp dir so safeInstallDir works without root
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'zpanel-apps-'));
process.env.VHOST_ROOT = tmpBase;

const { safeInstallDir } = require('./index');

describe('safeInstallDir', () => {
  test('accepts a path inside VHOST_ROOT', () => {
    const result = safeInstallDir(path.join(tmpBase, 'example.com'));
    expect(result).toBe(path.join(tmpBase, 'example.com'));
  });

  test('accepts VHOST_ROOT itself', () => {
    const result = safeInstallDir(tmpBase);
    expect(result).toBe(tmpBase);
  });

  test('rejects path traversal outside VHOST_ROOT', () => {
    expect(() => safeInstallDir('/etc/passwd')).toThrow('install_dir outside allowed base');
  });

  test('rejects path that escapes via ..', () => {
    expect(() => safeInstallDir(path.join(tmpBase, '../escape'))).toThrow('install_dir outside allowed base');
  });

  test('returns resolved absolute path', () => {
    const result = safeInstallDir(path.join(tmpBase, 'site', '.', 'sub'));
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.startsWith(tmpBase)).toBe(true);
  });
});
