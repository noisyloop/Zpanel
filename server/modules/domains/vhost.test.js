const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Point to temp dirs before requiring module
const tmpAvailable = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-available-'));
const tmpEnabled   = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-enabled-'));
const tmpVhostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vhostroot-'));

process.env.NGINX_AVAILABLE = tmpAvailable;
process.env.NGINX_ENABLED   = tmpEnabled;
process.env.VHOST_ROOT      = tmpVhostRoot;

const vhost = require('./vhost');

afterAll(() => {
  fs.rmSync(tmpAvailable, { recursive: true, force: true });
  fs.rmSync(tmpEnabled,   { recursive: true, force: true });
  fs.rmSync(tmpVhostRoot, { recursive: true, force: true });
});

describe('safeDomain', () => {
  test('accepts valid domain', () => {
    expect(() => vhost.safeDomain('example.com')).not.toThrow();
    expect(() => vhost.safeDomain('sub.example.com')).not.toThrow();
    expect(() => vhost.safeDomain('*.example.com')).not.toThrow();
  });

  test('rejects invalid domain', () => {
    expect(() => vhost.safeDomain('not a domain')).toThrow('Invalid domain');
    expect(() => vhost.safeDomain('../etc/passwd')).toThrow('Invalid domain');
    expect(() => vhost.safeDomain('')).toThrow('Invalid domain');
  });
});

describe('safeDocRoot', () => {
  test('accepts path inside VHOST_ROOT', () => {
    const p = path.join(tmpVhostRoot, 'user/example.com/public_html');
    expect(() => vhost.safeDocRoot(p)).not.toThrow();
  });

  test('rejects path outside VHOST_ROOT', () => {
    expect(() => vhost.safeDocRoot('/etc/nginx/conf.d')).toThrow('outside allowed vhost root');
    expect(() => vhost.safeDocRoot('/tmp')).toThrow('outside allowed vhost root');
  });
});

describe('buildVhostConfig', () => {
  test('contains server_name and root', () => {
    const docRoot = path.join(tmpVhostRoot, 'user/test.com/public_html');
    const config  = vhost.buildVhostConfig('test.com', docRoot);
    expect(config).toContain('server_name test.com');
    expect(config).toContain(`root ${docRoot}`);
    expect(config).toContain('listen 80');
  });

  test('includes PHP fastcgi block when phpFpm provided', () => {
    const docRoot = path.join(tmpVhostRoot, 'user/test.com/public_html');
    const config  = vhost.buildVhostConfig('test.com', docRoot, {
      phpFpm: 'unix:/run/php/php8.2-fpm.sock',
    });
    expect(config).toContain('fastcgi_pass');
    expect(config).toContain('php8.2-fpm');
  });

  test('adds server_aliases when provided', () => {
    const docRoot = path.join(tmpVhostRoot, 'u/d/public_html');
    const config  = vhost.buildVhostConfig('example.com', docRoot, {
      serverAliases: ['www.example.com'],
    });
    expect(config).toContain('www.example.com');
  });
});

describe('readVhostFile', () => {
  test('returns null for non-existent config', () => {
    expect(vhost.readVhostFile('nonexistent.example.com')).toBeNull();
  });

  test('reads file written by updateVhostFile', () => {
    const docRoot = path.join(tmpVhostRoot, 'u/wrtest.com/public_html');
    const content = vhost.buildVhostConfig('wrtest.com', docRoot);
    // Manually write the file to bypass deployVhost (no nginx in CI)
    fs.writeFileSync(path.join(tmpAvailable, 'wrtest.com.conf'), content);
    expect(vhost.readVhostFile('wrtest.com')).toContain('server_name wrtest.com');
  });
});
