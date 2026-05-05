# Zpanel

A cPanel-inspired web hosting control panel built as a **learning project** using Node.js, Express, and SQLite. Each phase introduces real-world hosting infrastructure concepts alongside the security patterns needed to implement them safely.

---

## Table of Contents

- [What You Will Learn](#what-you-will-learn)
- [Architecture Overview](#architecture-overview)
- [Phase 1 — Foundations](#phase-1--foundations)
- [Phase 2 — Domains, DNS, and SSL](#phase-2--domains-dns-and-ssl)
- [Phase 3 — Email, Databases, FTP, and Cron](#phase-3--email-databases-ftp-and-cron)
- [Phase 4 — App Deployment, PM2, Isolation, and Git Deploy](#phase-4--app-deployment-pm2-isolation-and-git-deploy)
- [Security Patterns Reference](#security-patterns-reference)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Running Tests](#running-tests)

---

## What You Will Learn

| Topic | Where |
|---|---|
| JWT access + refresh token rotation | `server/auth/` |
| bcrypt password hashing | `server/auth/index.js` |
| Safe shell execution (no `exec`, command whitelist) | `server/shell/index.js` |
| Path traversal prevention | `server/modules/files/`, `apps/`, `deploy/` |
| SQLite with better-sqlite3 (WAL mode) | `server/db.js` |
| WebSocket push (live stats + log streaming) | `server/index.js` |
| Server-Sent Events for long-running tasks | `server/modules/apps/routes.js` |
| Nginx vhost config generation | `server/modules/domains/` |
| BIND9 zone file authoring | `server/modules/dns/` |
| Let's Encrypt / certbot integration | `server/modules/ssl/` |
| Postfix + Dovecot mailbox provisioning | `server/modules/email/` |
| MySQL provisioning with identifier sanitisation | `server/modules/databases/` |
| Cron expression validation (recursive parser) | `server/modules/cron/` |
| PM2 process management from Node.js | `server/modules/processes/` |
| Linux user provisioning + disk quotas | `server/modules/isolation/` |
| Git deploy webhooks + HMAC timing-safe verification | `server/modules/deploy/` |
| WordPress / Ghost one-click installers | `server/modules/apps/` |
| Long-lived API keys (hash-only storage) | `server/auth/apiKeys.js` |
| Admin user management + resource ownership | `server/modules/users/`, `server/middleware/` |
| Paginated audit log with filters | `server/modules/audit/` |
| TOTP 2FA — pure HMAC-SHA1, RFC 6238, no library | `server/auth/totp.js` |
| Backup codes (SHA-256 hash, one-time use) | `server/auth/totp.js` |
| File + MySQL database backups with retention | `server/modules/backups/` |
| Email notifications via nodemailer (SMTP) | `server/modules/notifications/` |

---

## Architecture Overview

```
┌──────────────────────────────────────────────┐
│                 Browser (SPA)                │
│  client/index.html + client/src/app.js       │
│  • Vanilla JS, no build step                 │
│  • Communicates via REST API + WebSocket     │
└──────────────────┬───────────────────────────┘
                   │ HTTP / WebSocket
┌──────────────────▼───────────────────────────┐
│          Express HTTP server                 │
│  server/index.js                             │
│  • /api/* routes → module handlers           │
│  • /ws/stats   → live CPU/memory/disk push   │
│  • /ws/logs    → PM2 log tail streaming      │
│  • Static file serving for the SPA           │
└──────────────────┬───────────────────────────┘
                   │
     ┌─────────────┴──────────────┐
     │                            │
┌────▼─────┐              ┌───────▼───────┐
│  SQLite  │              │  Shell layer  │
│  db.js   │              │  shell/       │
│  (WAL)   │              │  (whitelist)  │
└──────────┘              └───────────────┘
```

**Key design decisions:**

- **No ORM** — `better-sqlite3` is used directly. You see every SQL statement, learning how prepared statements prevent SQL injection.
- **No shell strings** — every system command goes through a whitelist in `server/shell/index.js`. Arguments are validated individually; `spawn(bin, args, { shell: false })` is always used.
- **Stateless auth** — JWTs + rotating opaque refresh tokens (stored in SQLite). No server-side sessions.
- **No bundler** — the frontend is a single HTML file + a single JS file. You can read and modify it without a build pipeline.

---

## Phase 1 — Foundations

**Goal:** A working login panel with live server stats.

### What it builds
- User accounts with bcrypt-hashed passwords
- JWT access tokens (15-minute lifetime) and rotating refresh tokens (7-day, HttpOnly cookie)
- Role-based middleware (`requireAuth`, `requireAdmin`)
- Rate limiting on the `/api/auth/login` endpoint (prevent brute-force)
- File manager: browse, upload, download, rename, delete files within a sandboxed root
- Live system stats (CPU, memory, disk, uptime) streamed to the browser over WebSocket every 2 seconds

### Key lessons

**bcrypt password hashing**
```js
// Never store plain passwords — bcrypt adds a random salt automatically.
// Cost factor 12 means ~250ms per hash on modern hardware, making brute-force impractical.
const hash = await bcrypt.hash(plainPassword, 12);
const ok   = await bcrypt.compare(candidatePassword, hash);
```

**JWT + refresh token rotation**
```
POST /api/auth/login
  → issues accessToken (short-lived, in response body)
  → issues refreshToken (long-lived, stored in DB, sent as HttpOnly cookie)

POST /api/auth/refresh
  → verifies refreshToken from cookie
  → issues new accessToken + rotates refreshToken (old one deleted from DB)
  → if refreshToken is reused after rotation, all tokens for that user are revoked
```
This pattern means a stolen access token expires quickly, and a stolen refresh token is detected on reuse.

**Path traversal prevention in the file manager**
```js
function safePath(userPath) {
  // Strip leading / so absolute paths become relative to FILE_ROOT
  const relative = userPath.replace(/^\/+/, '');
  const resolved = path.resolve(FILE_ROOT, relative);
  if (!resolved.startsWith(FILE_ROOT + path.sep) && resolved !== FILE_ROOT) {
    throw new Error('Path outside allowed root');
  }
  return resolved;
}
```
`../../etc/passwd` resolves inside FILE_ROOT and stays safe. The function does not reject absolute paths — it neutralises them.

**Safe shell execution**
```js
// ✗ Never do this — user input goes directly into the shell
exec(`df ${userInput}`, callback);

// ✓ Whitelist the command, validate every argument individually, use spawn
const { stdout } = await shell.run('df', ['-k', '/']);
```

**Reading system stats without external tools**
```js
// /proc/stat, /proc/meminfo, /proc/uptime are virtual files on Linux.
// They are zero-cost to read — no subprocess needed.
const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
```

---

## Phase 2 — Domains, DNS, and SSL

**Goal:** Manage Nginx virtual hosts, BIND9 DNS zones, and Let's Encrypt certificates.

### What it builds
- Create / delete Nginx virtual host configs (`sites-available` → `sites-enabled` symlink)
- Validate config with `nginx -t` before reloading — never break the live server
- BIND9 zone file generation with proper SOA, serial number (YYYYMMDDNN), and record validation
- certbot integration for ACME HTTP-01 certificate issuance
- Daily SSL renewal scheduler using `setInterval`
- Certificate expiry tracking (parsed from `openssl x509 -enddate`)

### Key lessons

**Nginx config generation is just string templating**
```js
function buildVhostConfig({ domain, docRoot, php }) {
  return `server {
    listen 80;
    server_name ${domain};
    root ${docRoot};
    index index.php index.html;
    ${php ? 'location ~ \\.php$ { fastcgi_pass unix:/run/php/php8.2-fpm.sock; }' : ''}
}`;
}
```
Always write to `sites-available`, run `nginx -t`, then create the `sites-enabled` symlink. If the test fails, delete the file and return an error — never leave a broken config in place.

**BIND9 zone file format**
```
$ORIGIN example.com.       ; note the trailing dot — it means "fully qualified"
$TTL 3600
@   IN SOA  ns1.example.com. admin.example.com. (
            2024010101 ; serial: YYYYMMDDNN — increment on every change
            3600       ; refresh
            900        ; retry
            604800     ; expire
            300 )      ; minimum TTL
@   IN  NS   ns1.example.com.
@   IN  A    203.0.113.1
www IN  CNAME @
```
The serial number format lets operators know when a zone was last changed at a glance. Bump it on every update.

**certbot is called via the whitelist**
```js
await shell.run('certbot', [
  '--nginx', '-d', domain,
  '--non-interactive', '--agree-tos',
  `--email=${email}`,
  '--redirect',
]);
```
No shell interpolation. The domain and email are validated by the whitelist's per-argument RegExp patterns before being passed to certbot.

---

## Phase 3 — Email, Databases, FTP, and Cron

**Goal:** Provision per-domain email, MySQL databases, FTP accounts, and scheduled jobs.

### What it builds
- Virtual mailbox provisioning (Postfix `virtual_mailbox_maps`, Dovecot `passwd-file`)
- SPF / DKIM / DMARC DNS record helpers
- MySQL database and user provisioning with the `mysql2` driver
- vsftpd per-user config files with chroot jail validation
- Cron job management with expression validation and crontab sync

### Key lessons

**MySQL identifier sanitisation**
MySQL prepared statements protect VALUES but not identifiers (database/table/column names). You must sanitise them separately:
```js
const DB_NAME_RE = /^[a-zA-Z0-9_]{1,64}$/;

function sanitiseIdentifier(name) {
  if (!DB_NAME_RE.test(name)) throw new Error('Invalid identifier');
  return `\`${name}\``;   // backtick-quote after validation
}

// Safe: name is validated, then quoted
await connection.query(`CREATE DATABASE ${sanitiseIdentifier(dbName)}`);
```

**Cron expression validation**
A cron expression has five fields: `minute hour day-of-month month day-of-week`. Each field can be `*`, `*/n` (step), `n-m` (range), or `n,m,p` (list).
```js
// Recursive field validator with explicit numeric bounds
function validateField(value, { name, min, max }) {
  if (value === '*') return;
  if (value.startsWith('*/')) {
    const n = parseInt(value.slice(2), 10);
    if (isNaN(n) || n < 1) throw new Error(`Invalid step in ${name}`);
    return;
  }
  if (value.includes(',')) {
    value.split(',').forEach(part => validateField(part, { name, min, max }));
    return;
  }
  if (value.includes('-')) {
    const [lo, hi] = value.split('-').map(Number);
    if (lo < min || hi > max || lo > hi) throw new Error(`Invalid range in ${name}`);
    return;
  }
  const n = parseInt(value, 10);
  if (isNaN(n) || n < min || n > max) throw new Error(`Invalid ${name} value: ${value}`);
}
```

**Crontab sync strategy**
Rather than owning the entire crontab, Zpanel tags its managed lines:
```
# BEGIN zpanel-managed
30 4 * * * /usr/bin/certbot renew
# END zpanel-managed
```
Lines outside the tags are preserved — the user can still add their own cron jobs manually.

**Dovecot passwd-file format**
```
user@example.com:{SHA512-CRYPT}$6$rounds=...$...hash...:::::
```
Dovecot reads this file directly for authentication. `openssl passwd -6` generates SHA-512 crypt hashes compatible with this format.

---

## Phase 4 — App Deployment, PM2, Isolation, and Git Deploy

**Goal:** One-click app installers, process management, per-user Linux isolation, and automated git deployments.

### What it builds
- WordPress and Ghost one-click installers with SSE progress streaming
- PM2 process manager integration (list, start, stop, restart, live log tail)
- Linux system user provisioning with disk quotas (per-panel-user isolation)
- Git deploy webhooks: push to a branch → pull → build → PM2 restart
- HMAC webhook signature verification (GitHub and GitLab compatible)
- Deploy history stored in SQLite

### Key lessons

**Server-Sent Events for long-running tasks**
HTTP requests have no built-in way to stream partial progress. SSE is the simplest solution for one-way server→browser streaming:
```js
// Server
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.flushHeaders();

const send = msg => res.write(`data: ${JSON.stringify({ log: msg })}\n\n`);

await installWordPress({ ... }, context, send);
res.write('data: {"done":true}\n\n');
res.end();
```
```js
// Browser
const es = new EventSource('/api/apps/install-stream?...');
es.onmessage = e => {
  const { log, done } = JSON.parse(e.data);
  if (done) { es.close(); return; }
  logEl.textContent += log + '\n';
};
```

**PM2 log streaming via WebSocket**
PM2's `logs` subcommand streams output continuously. Zpanel bridges this to a WebSocket:
```js
// server/index.js (simplified)
wssLogs.on('connection', (ws, req) => {
  const name = url.searchParams.get('name');
  const proc = pm2Procs.tailLogs(name, 50);  // returns a ChildProcess

  proc.stdout.on('data', chunk =>
    ws.send(JSON.stringify({ line: chunk.toString() }))
  );
  ws.on('close', () => proc.kill());
});
```
The ChildProcess is killed when the WebSocket closes, preventing orphaned `pm2 logs` processes.

**WordPress wp-config.php generation**
```js
// Cryptographically random WordPress salts — never use static salts
const salt = () => crypto.randomBytes(32).toString('base64').slice(0, 64);

const config = `define('AUTH_KEY', '${salt()}');
define('SECURE_AUTH_KEY', '${salt()}');
// ... 6 more salts
`;
```

**HMAC webhook signature verification with timing-safe comparison**
```js
function verifySignature(rawBody, secret, signatureHeader) {
  if (signatureHeader.startsWith('sha256=')) {
    // GitHub sends X-Hub-Signature-256: sha256=<hex>
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    // IMPORTANT: use timingSafeEqual, not ===
    // String equality short-circuits on the first mismatched byte,
    // leaking timing information that can be used to forge signatures.
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  }
  // GitLab sends X-Gitlab-Token: <plaintext secret>
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(secret));
}
```

**Per-user Linux isolation**
Each panel user gets a dedicated Linux system user, preventing one user's processes from reading another's files:
```js
// Panel username → Linux username
function deriveSystemUser(panelUsername) {
  const safe = panelUsername.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  return `zp_${safe}`;  // zp_ prefix avoids collisions with real system users
}

// Create the user with no login shell (nologin) for security
await shell.run('useradd', ['-m', '-s', '/usr/sbin/nologin', sysUser]);

// Set disk quota: 2 GB soft and hard limit
await shell.run('setquota', ['-u', sysUser, '2097152', '2097152', '0', '0', '/']);
```

---

## Security Patterns Reference

### 1. Command Whitelist (`server/shell/index.js`)

Every system call goes through this pattern. There are no `exec()` calls with user input anywhere in the codebase.

```js
const COMMAND_WHITELIST = {
  nginx: { bin: 'nginx', argPatterns: ['-t', '-s', 'reload'] },
  git:   { bin: 'git',   argPatterns: ['pull', 'fetch', '-C', /^\/[a-zA-Z0-9/_.-]+$/] },
  // ...
};

function run(command, args) {
  const entry = COMMAND_WHITELIST[command];
  if (!entry) throw new Error(`Command not whitelisted: ${command}`);

  for (const arg of args) {
    const ok = entry.argPatterns.some(p =>
      p instanceof RegExp ? p.test(arg) : p === arg
    );
    if (!ok) throw new Error(`Argument not allowed for ${command}: ${arg}`);
  }

  // shell: false means args are NEVER interpreted by /bin/sh
  return spawn(entry.bin, args, { shell: false });
}
```

### 2. Path Traversal Prevention

Multiple `safe*` functions enforce allowed base directories at different layers:

| Function | Module | Prevents |
|---|---|---|
| `safePath` | `files` | Reading `/etc/passwd` via the file manager |
| `safeInstallDir` | `apps` | Installing apps outside `/var/www` |
| `safeChrootDir` | `ftp` | FTP chroot escapes |
| `safeDocRoot` | `domains` | Nginx docroot pointing to system dirs |

### 3. Timing-Safe Comparisons

Any secret comparison (webhook tokens, HMAC signatures) uses `crypto.timingSafeEqual`:
```js
// Constant-time regardless of how many bytes match
crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
```

### 4. SQL Injection Prevention

- **Values** → always use prepared statement placeholders (`?`)
- **Identifiers** → validate with a strict regex, then backtick-quote

```js
// Values: prepared statement
db.prepare('SELECT * FROM users WHERE username = ?').get(username);

// Identifiers: validate + quote
const DB_NAME_RE = /^[a-zA-Z0-9_]{1,64}$/;
if (!DB_NAME_RE.test(dbName)) throw new Error('Invalid identifier');
await conn.query(`CREATE DATABASE \`${dbName}\``);
```

### 5. Authentication Flow

```
Browser                          Server
  │                                │
  ├─POST /api/auth/login──────────►│
  │                                ├─ bcrypt.compare(password, hash)
  │◄──accessToken (body)───────────┤
  │◄──refreshToken (HttpOnly cookie)┤
  │                                │
  ├─GET /api/stats ────────────────►│  Bearer: accessToken (15m)
  │◄──200 OK───────────────────────┤
  │                                │
  │ (access token expires)         │
  ├─POST /api/auth/refresh─────────►│  cookie: refreshToken
  │                                ├─ look up in DB, delete old, issue new
  │◄──new accessToken (body)────────┤
  │◄──new refreshToken (cookie)─────┤
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- (Optional for full functionality) nginx, bind9, certbot, mysql-server, vsftpd, pm2

### Installation

```bash
git clone <repo-url>
cd Zpanel
npm install

cp .env.example .env
# Edit .env — at minimum set JWT_SECRET and JWT_REFRESH_SECRET to long random strings

npm start
# Open http://localhost:3000
# Default credentials: admin / changeme
# Change the password immediately in production
```

For development with auto-restart:
```bash
npm run dev
```

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `JWT_SECRET` | *(required)* | Signs access tokens — use a long random string |
| `JWT_REFRESH_SECRET` | *(required)* | Signs refresh tokens — use a different long random string |
| `JWT_EXPIRES_IN` | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token lifetime |
| `DB_PATH` | `./db/zpanel.db` | SQLite database file location |
| `FILE_ROOT` | `/var/www` | Root directory for the file manager |
| `MAX_UPLOAD_MB` | `50` | Maximum file upload size |
| `NGINX_AVAILABLE` | `/etc/nginx/sites-available` | Nginx sites-available directory |
| `ZONE_DIR` | `/etc/bind/zones` | BIND9 zone files directory |
| `SERVER_IP` | `127.0.0.1` | Default A record for new zones |
| `CERTBOT_EMAIL` | *(required for SSL)* | Email for Let's Encrypt notifications |
| `HOME_BASE` | `/home/zpanel-users` | Base directory for isolated user homes |
| `MYSQL_ROOT_PASS` | *(required for databases)* | MySQL root password |

---

## Project Structure

```
Zpanel/
├── client/
│   ├── index.html          # Single-page app shell (all panel HTML)
│   └── src/
│       ├── app.js          # All frontend logic (~1400 lines of vanilla JS)
│       └── style.css       # Dark theme CSS variables + component styles
├── server/
│   ├── index.js            # Express app, WebSocket servers, startup
│   ├── db.js               # SQLite setup, schema, migrations
│   ├── auth/
│   │   ├── index.js        # createUser, verifyPassword, JWT, requireAuth
│   │   └── routes.js       # POST /login, /logout, /refresh, GET /me
│   ├── shell/
│   │   ├── index.js        # Command whitelist, run(), runStreaming()
│   │   └── index.test.js   # Whitelist unit tests
│   └── modules/
│       ├── stats/          # /proc parsing, WebSocket push
│       ├── files/          # File manager, safePath, multer upload
│       ├── domains/        # Nginx vhost management
│       ├── dns/            # BIND9 zone file generation + validation
│       ├── ssl/            # certbot, expiry tracking, renewal scheduler
│       ├── email/          # Postfix/Dovecot provisioning, DKIM
│       ├── databases/      # MySQL provisioning
│       ├── ftp/            # vsftpd per-user config
│       ├── cron/           # Cron expression validation, crontab sync
│       ├── apps/           # WordPress/Ghost/Static installers, SSE
│       ├── processes/      # PM2 wrapper, safeName, log tail
│       ├── isolation/      # Linux user provisioning, disk quotas
│       └── deploy/         # Webhook CRUD, HMAC verify, git pull pipeline
├── db/
│   └── zpanel.db           # Created automatically on first run
├── scripts/                # Setup/maintenance scripts
├── .env.example            # All environment variables documented
└── package.json
```

---

## Running Tests

```bash
npm test
```

Tests use Jest and cover:

| File | What is tested |
|---|---|
| `server/shell/index.test.js` | Command whitelist — rejects unlisted commands, validates arguments |
| `server/modules/apps/index.test.js` | `safeInstallDir` — path traversal prevention for app installs |
| `server/modules/deploy/index.test.js` | `verifySignature` (GitHub + GitLab HMAC), `validateHookParams` input validation |
| `server/modules/isolation/index.test.js` | `deriveSystemUser` — username sanitisation and transformation |
| `server/modules/processes/index.test.js` | `safeName` — PM2 process name validation, shell injection prevention |

All tests run in-process (no real shell commands, no MySQL, no nginx required).

---

## Roadmap

| Phase | Status | Topics |
|---|---|---|
| 1 — Foundations | ✅ Complete | Auth, file manager, live stats |
| 2 — Domains / DNS / SSL | ✅ Complete | Nginx, BIND9, certbot |
| 3 — Email / Databases / FTP / Cron | ✅ Complete | Postfix, Dovecot, MySQL, vsftpd |
| 4 — App Deploy / PM2 / Isolation | ✅ Complete | WordPress, Ghost, PM2, Linux users, git webhooks |
| 5 — Polish / Multi-tenancy | ✅ Complete | User management, API keys, audit log UI, ownership middleware |
| 6 — 2FA / Backups / Notifications | ✅ Complete | TOTP 2FA (pure HMAC-SHA1), file + DB backups, email alerts |

---

## License

MIT — build on it, learn from it, break it, fix it.
