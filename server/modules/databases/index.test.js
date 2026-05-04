const { sanitise } = require('./index');

describe('sanitise', () => {
  test('accepts valid identifiers', () => {
    expect(() => sanitise('my_database', 'database name')).not.toThrow();
    expect(() => sanitise('db123', 'database name')).not.toThrow();
    expect(() => sanitise('ABC_123', 'database name')).not.toThrow();
  });

  test('rejects identifiers with hyphens', () => {
    expect(() => sanitise('my-db', 'database name')).toThrow('Invalid database name');
  });

  test('rejects identifiers with spaces', () => {
    expect(() => sanitise('my db', 'database name')).toThrow('Invalid database name');
  });

  test('rejects SQL injection attempts', () => {
    expect(() => sanitise("db'; DROP TABLE users; --", 'database name')).toThrow('Invalid database name');
    expect(() => sanitise('db`injected', 'database name')).toThrow('Invalid database name');
  });

  test('rejects empty string', () => {
    expect(() => sanitise('', 'database name')).toThrow('Invalid database name');
  });

  test('rejects identifiers longer than 48 chars', () => {
    expect(() => sanitise('a'.repeat(49), 'database name')).toThrow('Invalid database name');
  });
});
