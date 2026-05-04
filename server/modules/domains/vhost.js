const fs   = require('fs');
const path = require('path');
const shell = require('../../shell');

const NGINX_AVAILABLE = process.env.NGINX_AVAILABLE || '/etc/nginx/sites-available';
const NGINX_ENABLED   = process.env.NGINX_ENABLED   || '/etc/nginx/sites-enabled';

// Allowed doc-root base — prevents writing vhosts for arbitrary paths
const VHOST_ROOT = process.env.VHOST_ROOT || '/var/www';

function safeDocRoot(docRoot) {
  const resolved = path.resolve(docRoot);
  if (!resolved.startsWith(VHOST_ROOT + '/') && resolved !== VHOST_ROOT) {
    throw Object.assign(new Error('doc_root outside allowed vhost root'), { code: 'FORBIDDEN' });
  }
  return resolved;
}

function safeDomain(domain) {
  // Wildcard subdomains (*.example.com) and normal FQDNs only
  if (!/^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(domain)) {
    throw new Error(`Invalid domain name: ${domain}`);
  }
  return domain;
}

/**
 * Generate the Nginx server block for a domain.
 * Produces HTTP-only config initially; SSL block is appended by the ssl module.
 */
function buildVhostConfig(domain, docRoot, opts = {}) {
  const { serverAliases = [], phpFpm = null } = opts;
  const aliasLine = serverAliases.length
    ? `    server_name ${domain} ${serverAliases.join(' ')};`
    : `    server_name ${domain};`;

  const phpBlock = phpFpm
    ? `
    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass ${phpFpm};
    }`
    : '';

  return `# Zpanel managed — do not edit manually
server {
    listen 80;
    listen [::]:80;
${aliasLine}

    root ${docRoot};
    index index.php index.html index.htm;

    access_log /var/log/nginx/${domain}.access.log;
    error_log  /var/log/nginx/${domain}.error.log;

    location / {
        try_files $uri $uri/ =404;
    }
${phpBlock}
    location ~ /\\.ht {
        deny all;
    }
}
`;
}

/**
 * Write vhost config, symlink it, validate with `nginx -t`, then reload.
 * Throws (and cleans up the file) if validation fails.
 */
async function deployVhost(domain, docRoot, opts = {}, context = {}) {
  safeDomain(domain);
  const absDocRoot = safeDocRoot(docRoot);

  fs.mkdirSync(absDocRoot, { recursive: true });

  const configPath = path.join(NGINX_AVAILABLE, `${domain}.conf`);
  const linkPath   = path.join(NGINX_ENABLED,   `${domain}.conf`);

  const config = buildVhostConfig(domain, absDocRoot, opts);
  fs.writeFileSync(configPath, config, { mode: 0o644 });

  // Symlink into sites-enabled
  try {
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    fs.symlinkSync(configPath, linkPath);
  } catch (err) {
    fs.unlinkSync(configPath);
    throw err;
  }

  // Validate config — if nginx -t fails, roll back
  const test = await shell.run('nginx', ['-t'], context);
  if (test.code !== 0) {
    fs.unlinkSync(linkPath);
    fs.unlinkSync(configPath);
    throw new Error(`nginx config validation failed:\n${test.stderr}`);
  }

  // Reload nginx
  await shell.run('systemctl', ['reload', 'nginx'], context);

  return configPath;
}

async function removeVhost(domain, context = {}) {
  safeDomain(domain);
  const configPath = path.join(NGINX_AVAILABLE, `${domain}.conf`);
  const linkPath   = path.join(NGINX_ENABLED,   `${domain}.conf`);

  for (const p of [linkPath, configPath]) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }

  const test = await shell.run('nginx', ['-t'], context);
  if (test.code !== 0) throw new Error(`nginx config invalid after removal:\n${test.stderr}`);
  await shell.run('systemctl', ['reload', 'nginx'], context);
}

/**
 * Rewrite an existing vhost config file in-place (e.g. after SSL is added).
 * Returns without reload — caller is responsible for calling reloadNginx().
 */
function updateVhostFile(domain, newContent) {
  safeDomain(domain);
  const configPath = path.join(NGINX_AVAILABLE, `${domain}.conf`);
  if (!fs.existsSync(configPath)) throw new Error(`Vhost config not found: ${domain}`);
  fs.writeFileSync(configPath, newContent, { mode: 0o644 });
}

function readVhostFile(domain) {
  safeDomain(domain);
  const configPath = path.join(NGINX_AVAILABLE, `${domain}.conf`);
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
}

async function reloadNginx(context = {}) {
  const test = await shell.run('nginx', ['-t'], context);
  if (test.code !== 0) throw new Error(`nginx -t failed:\n${test.stderr}`);
  await shell.run('systemctl', ['reload', 'nginx'], context);
}

module.exports = {
  deployVhost, removeVhost, updateVhostFile, readVhostFile,
  reloadNginx, buildVhostConfig, safeDomain, safeDocRoot,
  NGINX_AVAILABLE, NGINX_ENABLED, VHOST_ROOT,
};
