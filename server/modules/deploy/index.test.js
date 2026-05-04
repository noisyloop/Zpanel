const crypto = require('crypto');
const { verifySignature, validateHookParams } = require('./index');

// ── verifySignature ───────────────────────────────────────────────────────────

describe('verifySignature', () => {
  const secret  = 'super-secret-key';
  const payload = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));

  function githubSig(body, key) {
    return 'sha256=' + crypto.createHmac('sha256', key).update(body).digest('hex');
  }

  test('accepts valid GitHub sha256 signature', () => {
    const sig = githubSig(payload, secret);
    expect(verifySignature(payload, secret, sig)).toBe(true);
  });

  test('rejects GitHub signature with wrong secret', () => {
    const sig = githubSig(payload, 'wrong-secret');
    expect(verifySignature(payload, secret, sig)).toBe(false);
  });

  test('rejects GitHub signature with tampered body', () => {
    const sig = githubSig(Buffer.from('original'), secret);
    expect(verifySignature(Buffer.from('tampered'), secret, sig)).toBe(false);
  });

  test('accepts valid GitLab plain token', () => {
    expect(verifySignature(payload, secret, secret)).toBe(true);
  });

  test('rejects invalid GitLab plain token', () => {
    expect(verifySignature(payload, secret, 'wrong-token')).toBe(false);
  });

  test('returns false when signatureHeader is missing', () => {
    expect(verifySignature(payload, secret, null)).toBe(false);
    expect(verifySignature(payload, secret, undefined)).toBe(false);
    expect(verifySignature(payload, secret, '')).toBe(false);
  });
});

// ── validateHookParams ────────────────────────────────────────────────────────

describe('validateHookParams', () => {
  const valid = { deployDir: '/var/www/myapp', branch: 'main' };

  test('accepts valid params', () => {
    expect(() => validateHookParams(valid)).not.toThrow();
  });

  test('accepts params with optional buildCmd and pm2Name', () => {
    expect(() => validateHookParams({
      ...valid,
      buildCmd: 'npm install --prefix /var/www/myapp',
      pm2Name:  'my-app',
    })).not.toThrow();
  });

  test('rejects deploy_dir with shell injection attempt', () => {
    expect(() => validateHookParams({ ...valid, deployDir: '/var/www/$(rm -rf /)' })).toThrow('Invalid deploy_dir');
  });

  test('rejects deploy_dir that is relative', () => {
    expect(() => validateHookParams({ ...valid, deployDir: 'relative/path' })).toThrow('Invalid deploy_dir');
  });

  test('rejects invalid branch name', () => {
    expect(() => validateHookParams({ ...valid, branch: 'bad branch!' })).toThrow('Invalid branch');
  });

  test('rejects build_cmd with shell metacharacters', () => {
    expect(() => validateHookParams({ ...valid, buildCmd: 'npm install && rm -rf /' })).toThrow('Invalid build_cmd');
  });

  test('rejects pm2_name with spaces', () => {
    expect(() => validateHookParams({ ...valid, pm2Name: 'bad name here' })).toThrow('Invalid pm2_name');
  });
});
