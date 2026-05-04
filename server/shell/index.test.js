const shell = require('./index');

describe('shell whitelist', () => {
  test('rejects unlisted command', () => {
    expect(() => shell.run('rm', ['-rf', '/'])).toThrow('not whitelisted');
  });

  test('rejects disallowed arg for whitelisted command', () => {
    expect(() => shell.run('df', ['--output=source,avail'])).toThrow('Argument not allowed');
  });

  test('accepts valid df command', async () => {
    const result = await shell.run('df', ['-k', '/']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\//);
  });

  test('accepts uptime with no args', async () => {
    const result = await shell.run('uptime', []);
    expect(result.code).toBe(0);
  });
});
