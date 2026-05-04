const os   = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `zpanel-test-cron-${Date.now()}.db`);

const cron = require('./index');

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* ignore */ }
});

describe('validateExpression', () => {
  test('accepts standard expressions', () => {
    expect(() => cron.validateExpression('* * * * *')).not.toThrow();
    expect(() => cron.validateExpression('0 2 * * *')).not.toThrow();
    expect(() => cron.validateExpression('30 4 1,15 * 5')).not.toThrow();
    expect(() => cron.validateExpression('*/5 * * * *')).not.toThrow();
    expect(() => cron.validateExpression('0 22 * * 1-5')).not.toThrow();
  });

  test('rejects wrong field count', () => {
    expect(() => cron.validateExpression('* * * *')).toThrow('5 fields');
    expect(() => cron.validateExpression('* * * * * *')).toThrow('5 fields');
  });

  test('rejects out-of-range minute', () => {
    expect(() => cron.validateExpression('60 * * * *')).toThrow('minute');
  });

  test('rejects out-of-range hour', () => {
    expect(() => cron.validateExpression('* 24 * * *')).toThrow('hour');
  });
});

describe('validateCommand', () => {
  test('accepts safe commands', () => {
    expect(() => cron.validateCommand('/usr/bin/php /var/www/site/cron.php')).not.toThrow();
    expect(() => cron.validateCommand('/path/to/script.sh')).not.toThrow();
  });

  test('rejects shell metacharacters', () => {
    expect(() => cron.validateCommand('rm -rf / ; echo pwned')).toThrow('disallowed');
    expect(() => cron.validateCommand('cmd && bad')).toThrow('disallowed');
    expect(() => cron.validateCommand('$(evil)')).toThrow('disallowed');
    expect(() => cron.validateCommand('cmd | cat /etc/passwd')).toThrow('disallowed');
  });

  test('rejects empty command', () => {
    expect(() => cron.validateCommand('')).toThrow('disallowed');
  });
});

describe('buildExpression', () => {
  test('builds expression from parts', () => {
    expect(cron.buildExpression({ minute: '0', hour: '3', dom: '*', month: '*', dow: '0' }))
      .toBe('0 3 * * 0');
  });

  test('uses * for omitted fields', () => {
    expect(cron.buildExpression({})).toBe('* * * * *');
  });
});

describe('ftp validateFtpUser', () => {
  const { validateFtpUser } = require('../ftp/index');

  test('accepts valid usernames', () => {
    expect(() => validateFtpUser('myuser')).not.toThrow();
    expect(() => validateFtpUser('user.name')).not.toThrow();
    expect(() => validateFtpUser('user-123')).not.toThrow();
  });

  test('rejects too short', () => {
    expect(() => validateFtpUser('ab')).toThrow();
  });

  test('rejects disallowed characters', () => {
    expect(() => validateFtpUser('user name')).toThrow();
    expect(() => validateFtpUser('user@name')).toThrow();
    expect(() => validateFtpUser('../etc')).toThrow();
  });
});
