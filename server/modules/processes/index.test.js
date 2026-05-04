const { safeName } = require('./index');

describe('safeName', () => {
  test('accepts alphanumeric name', () => {
    expect(safeName('myapp')).toBe('myapp');
  });

  test('accepts name with dots, dashes, underscores', () => {
    expect(safeName('my-app_v2.0')).toBe('my-app_v2.0');
  });

  test('accepts numeric string (PM2 process id)', () => {
    expect(safeName('0')).toBe('0');
    expect(safeName('42')).toBe('42');
  });

  test('accepts number input (coerces to string)', () => {
    expect(safeName(3)).toBe('3');
  });

  test('rejects name with spaces', () => {
    expect(() => safeName('my app')).toThrow('Invalid PM2 process name/id');
  });

  test('rejects name with shell injection characters', () => {
    expect(() => safeName('app; rm -rf /')).toThrow('Invalid PM2 process name/id');
    expect(() => safeName('$(evil)')).toThrow('Invalid PM2 process name/id');
    expect(() => safeName('app`cmd`')).toThrow('Invalid PM2 process name/id');
  });

  test('rejects empty string', () => {
    expect(() => safeName('')).toThrow('Invalid PM2 process name/id');
  });

  test('rejects name longer than 64 characters', () => {
    expect(() => safeName('a'.repeat(65))).toThrow('Invalid PM2 process name/id');
  });

  test('accepts name of exactly 64 characters', () => {
    const name = 'a'.repeat(64);
    expect(safeName(name)).toBe(name);
  });
});
