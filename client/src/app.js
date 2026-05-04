/* Zpanel — Phase 1 + 2 frontend */

// ── State ─────────────────────────────────────────────────────────────────────

let accessToken  = localStorage.getItem('zpanel_token') || null;
let currentUser  = null;   // { id, username, role }
let wsConn       = null;
let cpuHistory   = new Array(30).fill(0);
let ramHistory   = new Array(30).fill(0);

// ── Helpers ───────────────────────────────────────────────────────────────────

function qs(sel, root = document) { return root.querySelector(sel); }
function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }

async function api(method, path, body, isFormData = false) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
  };
  if (body && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body; // FormData — browser sets content-type
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    // Try token refresh
    const refreshed = await tryRefresh();
    if (refreshed) return api(method, path, body, isFormData);
    logout();
    throw new Error('Session expired');
  }
  return res;
}

async function tryRefresh() {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST' });
    if (!res.ok) return false;
    const data = await res.json();
    accessToken = data.accessToken;
    localStorage.setItem('zpanel_token', accessToken);
    return true;
  } catch {
    return false;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function logout() {
  if (accessToken) {
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => {});
  }
  accessToken = null;
  localStorage.removeItem('zpanel_token');
  disconnectWs();
  show(qs('#login-screen'));
  hide(qs('#dashboard'));
}

qs('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = qs('#login-username').value.trim();
  const password = qs('#login-password').value;
  const errEl    = qs('#login-error');
  errEl.textContent = '';

  try {
    const res  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Login failed';
      return;
    }
    accessToken = data.accessToken;
    localStorage.setItem('zpanel_token', accessToken);
    currentUser = data.user;
    qs('#nav-username').textContent = data.user.username;
    enterDashboard();
  } catch {
    errEl.textContent = 'Network error';
  }
});

qs('#logout-btn').addEventListener('click', logout);

// ── Dashboard ─────────────────────────────────────────────────────────────────

function enterDashboard() {
  hide(qs('#login-screen'));
  show(qs('#dashboard'));
  applyRoleUI();
  switchPanel('stats');
  connectWs();
}

function applyRoleUI() {
  const isAdmin = currentUser?.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin);
  });
}

// ── Panel switching ───────────────────────────────────────────────────────────

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    switchPanel(btn.dataset.panel);
  });
});

function switchPanel(name) {
  document.querySelectorAll('.panel').forEach(p => hide(p));
  show(qs(`#panel-${name}`));
  if (name === 'files')     loadDir(currentPath);
  if (name === 'domains')   loadDomains();
  if (name === 'dns')       loadDnsPanel();
  if (name === 'ssl')       loadSslPanel();
  if (name === 'email')     loadEmailPanel();
  if (name === 'databases') loadDatabasesPanel();
  if (name === 'ftp')       loadFtpPanel();
  if (name === 'cron')      loadCronPanel();
  if (name === 'apps')      loadAppsPanel();
  if (name === 'processes') loadProcessesPanel();
  if (name === 'deploy')    loadDeployPanel();
  if (name === 'profile')   loadProfilePanel();
  if (name === 'users')     loadUsersPanel();
  if (name === 'audit')     loadAuditPanel();
}

// ── WebSocket stats ───────────────────────────────────────────────────────────

function connectWs() {
  if (wsConn) wsConn.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url   = `${proto}://${location.host}/ws/stats?token=${encodeURIComponent(accessToken)}`;
  wsConn = new WebSocket(url);

  wsConn.onopen    = () => { qs('#ws-status').textContent = 'Live — updating every 2s'; };
  wsConn.onclose   = () => { qs('#ws-status').textContent = 'Disconnected'; };
  wsConn.onerror   = () => { qs('#ws-status').textContent = 'WebSocket error'; };
  wsConn.onmessage = e  => {
    try { renderStats(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  };
}

function disconnectWs() {
  if (wsConn) { wsConn.close(); wsConn = null; }
}

// ── Stats rendering ───────────────────────────────────────────────────────────

function renderStats(s) {
  const cpu  = s.cpu.percentUsed;
  const ram  = s.memory.percentUsed;
  const disk = s.disk.percentUsed;

  qs('#cpu-val').textContent  = `${cpu}%`;
  qs('#ram-val').textContent  = `${s.memory.usedMB} / ${s.memory.totalMB} MB`;
  qs('#disk-val').textContent = `${s.disk.usedGB} / ${s.disk.totalGB} GB`;
  qs('#uptime-val').textContent = s.uptime.human;

  setBar('#cpu-bar',  cpu);
  setBar('#ram-bar',  ram);
  setBar('#disk-bar', disk);

  cpuHistory.push(cpu);  cpuHistory.shift();
  ramHistory.push(ram);  ramHistory.shift();

  drawSparkline('cpu-chart', cpuHistory, '#4f8ef7');
  drawSparkline('ram-chart', ramHistory, '#6fe09e');
}

function setBar(sel, pct) {
  qs(sel).style.width = Math.min(100, Math.max(0, pct)) + '%';
  qs(sel).style.background = pct > 85 ? '#e05252' : pct > 65 ? '#f0a033' : '#4f8ef7';
}

function drawSparkline(canvasId, data, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const W    = canvas.width;
  const H    = canvas.height;
  const max  = Math.max(...data, 1);
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - (v / max) * H * 0.9;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}

// ── File Manager ──────────────────────────────────────────────────────────────

let currentPath = '/';

async function loadDir(p) {
  currentPath = p;
  qs('#fm-path').textContent = p;
  qs('#fm-error').textContent = '';
  const tbody = qs('#fm-tbody');
  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';

  try {
    const res  = await api('GET', `/api/files?path=${encodeURIComponent(p)}`);
    const data = await res.json();
    if (!res.ok) {
      qs('#fm-error').textContent = data.error;
      tbody.innerHTML = '';
      return;
    }
    tbody.innerHTML = '';
    data.entries
      .sort((a, b) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1) ||
                       a.name.localeCompare(b.name))
      .forEach(e => tbody.appendChild(buildRow(e, p)));
  } catch (err) {
    qs('#fm-error').textContent = err.message;
    tbody.innerHTML = '';
  }
}

function buildRow(entry, parentPath) {
  const tr  = document.createElement('tr');
  const fullPath = parentPath.replace(/\/$/, '') + '/' + entry.name;

  const nameCell = document.createElement('td');
  if (entry.type === 'dir') {
    const btn = document.createElement('button');
    btn.className   = 'fm-name-btn';
    btn.textContent = '📁 ' + entry.name;
    btn.onclick     = () => loadDir(fullPath);
    nameCell.appendChild(btn);
  } else {
    nameCell.textContent = '📄 ' + entry.name;
  }

  const sizeCell = document.createElement('td');
  sizeCell.textContent = entry.type === 'dir' ? '—' : humanSize(entry.size);

  const actions = document.createElement('td');

  if (entry.type !== 'dir') {
    const dlBtn    = document.createElement('button');
    dlBtn.className   = 'fm-action';
    dlBtn.textContent = 'Download';
    dlBtn.onclick     = () => {
      window.location.href = `/api/files/download?path=${encodeURIComponent(fullPath)}`;
    };
    actions.appendChild(dlBtn);
  }

  const renBtn    = document.createElement('button');
  renBtn.className   = 'fm-action';
  renBtn.textContent = 'Rename';
  renBtn.onclick     = async () => {
    const newName = prompt('New name:', entry.name);
    if (!newName || newName === entry.name) return;
    const newPath = parentPath.replace(/\/$/, '') + '/' + newName;
    const res = await api('POST', '/api/files/rename', { from: fullPath, to: newPath });
    if (res.ok) loadDir(parentPath);
    else { const d = await res.json(); qs('#fm-error').textContent = d.error; }
  };

  const delBtn    = document.createElement('button');
  delBtn.className   = 'fm-action del';
  delBtn.textContent = 'Delete';
  delBtn.onclick     = async () => {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    const res = await api('DELETE', `/api/files?path=${encodeURIComponent(fullPath)}`);
    if (res.ok) loadDir(parentPath);
    else { const d = await res.json(); qs('#fm-error').textContent = d.error; }
  };

  actions.appendChild(renBtn);
  actions.appendChild(delBtn);

  tr.innerHTML = '';
  tr.appendChild(nameCell);
  ['type', 'mode', 'modified'].forEach(k => {
    const td = document.createElement('td');
    td.textContent = entry[k] ?? '—';
    tr.appendChild(td);
  });
  tr.insertBefore(sizeCell, tr.children[1]);
  tr.appendChild(actions);
  return tr;
}

function humanSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024 ** 2)  return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3)  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

qs('#fm-up-btn').addEventListener('click', () => {
  const parent = currentPath.replace(/\/[^/]+$/, '') || '/';
  loadDir(parent);
});

qs('#fm-mkdir-btn').addEventListener('click', async () => {
  const name = prompt('Folder name:');
  if (!name) return;
  const newPath = currentPath.replace(/\/$/, '') + '/' + name;
  const res = await api('POST', `/api/files/mkdir?path=${encodeURIComponent(newPath)}`);
  if (res.ok) loadDir(currentPath);
  else { const d = await res.json(); qs('#fm-error').textContent = d.error; }
});

qs('#fm-upload-input').addEventListener('change', async e => {
  const fileList = Array.from(e.target.files);
  for (const file of fileList) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api('POST', `/api/files/upload?dir=${encodeURIComponent(currentPath)}`, fd, true);
    if (!res.ok) { const d = await res.json(); qs('#fm-error').textContent = d.error; }
  }
  e.target.value = '';
  loadDir(currentPath);
});

// ── Domains ───────────────────────────────────────────────────────────────────

let allDomains = [];
let subParentId = null;

async function loadDomains() {
  qs('#domains-error').textContent = '';
  const res  = await api('GET', '/api/domains');
  const data = await res.json();
  if (!res.ok) { qs('#domains-error').textContent = data.error; return; }
  allDomains = data;
  renderDomains(data);
  refreshDomainSelects(data);
}

function renderDomains(rows) {
  const tbody = qs('#domains-tbody');
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No domains yet.</td></tr>';
    return;
  }
  rows.forEach(d => {
    const tr  = document.createElement('tr');
    const type = d.is_subdomain ? '<span class="badge badge-pending">Subdomain</span>'
                                : '<span class="badge badge-active">Domain</span>';
    tr.innerHTML = `
      <td>${d.domain}</td>
      <td>${type}</td>
      <td style="font-family:monospace;font-size:12px">${d.doc_root}</td>
      <td>${d.created_at?.slice(0,10) ?? '—'}</td>
      <td>
        <button class="action-btn" onclick="showSubdomainForm(${d.id},'${d.domain}')">+ Sub</button>
        <button class="action-btn" onclick="switchToDns(${d.id})">DNS</button>
        <button class="action-btn" onclick="switchToSsl(${d.id})">SSL</button>
        <button class="action-btn danger" onclick="deleteDomain(${d.id},'${d.domain}')">Delete</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

function refreshDomainSelects(rows) {
  ['dns-domain-select', 'ssl-domain-select'].forEach(id => {
    const sel = qs(`#${id}`);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select domain…</option>';
    rows.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.domain;
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  });
}

qs('#domain-add-btn').addEventListener('click', () => {
  show(qs('#domain-form'));
  hide(qs('#subdomain-form'));
  qs('#domain-input').focus();
});

qs('#domain-cancel-btn').addEventListener('click', () => hide(qs('#domain-form')));

qs('#domain-submit-btn').addEventListener('click', async () => {
  const domain  = qs('#domain-input').value.trim();
  const docRoot = qs('#domain-docroot').value.trim() || undefined;
  qs('#domain-form-error').textContent = '';
  if (!domain) { qs('#domain-form-error').textContent = 'Domain is required'; return; }

  const res  = await api('POST', '/api/domains', { domain, docRoot });
  const data = await res.json();
  if (!res.ok) { qs('#domain-form-error').textContent = data.error; return; }

  hide(qs('#domain-form'));
  qs('#domain-input').value = '';
  qs('#domain-docroot').value = '';
  loadDomains();
  if (data.vhostWarning) {
    qs('#domains-error').textContent = `Note: ${data.vhostWarning}`;
  }
});

function showSubdomainForm(parentId, parentDomain) {
  subParentId = parentId;
  qs('#sub-parent-label').textContent = parentDomain;
  show(qs('#subdomain-form'));
  hide(qs('#domain-form'));
  qs('#sub-input').focus();
}

qs('#sub-cancel-btn').addEventListener('click', () => { hide(qs('#subdomain-form')); subParentId = null; });

qs('#sub-submit-btn').addEventListener('click', async () => {
  const subdomain = qs('#sub-input').value.trim();
  const wildcard  = qs('#sub-wildcard').checked;
  qs('#sub-form-error').textContent = '';
  if (!subdomain && !wildcard) { qs('#sub-form-error').textContent = 'Subdomain name required'; return; }

  const res  = await api('POST', `/api/domains/${subParentId}/subdomains`, { subdomain, wildcard });
  const data = await res.json();
  if (!res.ok) { qs('#sub-form-error').textContent = data.error; return; }

  hide(qs('#subdomain-form'));
  qs('#sub-input').value = '';
  qs('#sub-wildcard').checked = false;
  subParentId = null;
  loadDomains();
});

async function deleteDomain(id, domain) {
  if (!confirm(`Delete "${domain}" and its vhost/DNS zone?`)) return;
  const res = await api('DELETE', `/api/domains/${id}`);
  if (res.ok) loadDomains();
  else { const d = await res.json(); qs('#domains-error').textContent = d.error; }
}

function switchToDns(domainId) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-panel="dns"]').classList.add('active');
  switchPanel('dns');
  qs('#dns-domain-select').value = domainId;
  loadDnsRecords(domainId);
}

function switchToSsl(domainId) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-panel="ssl"]').classList.add('active');
  switchPanel('ssl');
  qs('#ssl-domain-select').value = domainId;
  loadSslCerts();
}

// ── DNS Manager ───────────────────────────────────────────────────────────────

let activeDnsdomainId = null;

async function loadDnsPanel() {
  if (!allDomains.length) {
    const res = await api('GET', '/api/domains');
    allDomains = await res.json();
    refreshDomainSelects(allDomains);
  }
  qs('#dns-error').textContent = '';
  qs('#dns-tbody').innerHTML = '';
  qs('#dns-zone-raw').textContent = '';
}

qs('#dns-domain-select').addEventListener('change', e => {
  activeDnsdomainId = e.target.value || null;
  if (activeDnsdomainId) loadDnsRecords(activeDnsdomainId);
});

async function loadDnsRecords(domainId) {
  activeDnsdomainId = domainId;
  qs('#dns-error').textContent = '';
  const res  = await api('GET', `/api/domains/${domainId}/dns`);
  const data = await res.json();
  if (!res.ok) { qs('#dns-error').textContent = data.error; return; }
  renderDnsRecords(data.records);
  qs('#dns-zone-raw').textContent = data.zone || '(zone file not written yet)';
}

function renderDnsRecords(records) {
  const tbody = qs('#dns-tbody');
  tbody.innerHTML = '';
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">No records yet.</td></tr>';
    return;
  }
  records.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="badge badge-active">${r.type}</span></td>
      <td>${r.name}</td>
      <td style="font-family:monospace;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis">${r.value}</td>
      <td>${r.ttl}</td>
      <td>${r.priority ?? '—'}</td>
      <td>
        <button class="action-btn danger" onclick="deleteDnsRecord(${r.id})">Delete</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

qs('#dns-add-btn').addEventListener('click', () => {
  if (!activeDnsdomainId) { qs('#dns-error').textContent = 'Select a domain first'; return; }
  show(qs('#dns-form'));
  qs('#dns-name-input').focus();
});

qs('#dns-cancel-btn').addEventListener('click', () => hide(qs('#dns-form')));

qs('#dns-submit-btn').addEventListener('click', async () => {
  const type  = qs('#dns-type-select').value;
  const name  = qs('#dns-name-input').value.trim();
  const value = qs('#dns-value-input').value.trim();
  const ttl   = parseInt(qs('#dns-ttl-input').value, 10) || 3600;
  const prio  = qs('#dns-prio-input').value ? parseInt(qs('#dns-prio-input').value, 10) : null;
  qs('#dns-form-error').textContent = '';

  if (!name || !value) { qs('#dns-form-error').textContent = 'Name and value required'; return; }

  const res  = await api('POST', `/api/domains/${activeDnsdomainId}/dns`,
    { type, name, value, ttl, priority: prio });
  const data = await res.json();
  if (!res.ok) { qs('#dns-form-error').textContent = data.error; return; }

  hide(qs('#dns-form'));
  ['#dns-name-input','#dns-value-input','#dns-prio-input'].forEach(s => { qs(s).value = ''; });
  loadDnsRecords(activeDnsdomainId);
});

async function deleteDnsRecord(id) {
  if (!confirm('Delete this DNS record?')) return;
  const res = await api('DELETE', `/api/domains/${activeDnsdomainId}/dns/${id}`);
  if (res.ok) loadDnsRecords(activeDnsdomainId);
  else { const d = await res.json(); qs('#dns-error').textContent = d.error; }
}

// ── SSL Certificates ──────────────────────────────────────────────────────────

async function loadSslPanel() {
  if (!allDomains.length) {
    const res = await api('GET', '/api/domains');
    allDomains = await res.json();
    refreshDomainSelects(allDomains);
  }
  loadSslCerts();
}

async function loadSslCerts() {
  qs('#ssl-error').textContent = '';
  qs('#ssl-message').textContent = '';
  const res  = await api('GET', '/api/ssl/all');
  const data = await res.json();
  if (!res.ok) { qs('#ssl-error').textContent = data.error; return; }
  renderSslCerts(data);
}

function renderSslCerts(certs) {
  const tbody = qs('#ssl-tbody');
  tbody.innerHTML = '';
  if (!certs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">No certificates yet.</td></tr>';
    return;
  }
  certs.forEach(c => {
    const daysLeft = c.expires_at
      ? Math.ceil((new Date(c.expires_at) - Date.now()) / 86400000)
      : null;
    const daysStr = daysLeft !== null
      ? (daysLeft < 14 ? `<span style="color:var(--danger)">${daysLeft}d</span>` : `${daysLeft}d`)
      : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.domain}</td>
      <td><span class="badge badge-${c.status}">${c.status}</span></td>
      <td>${c.issued_at?.slice(0,10) ?? '—'}</td>
      <td>${c.expires_at?.slice(0,10) ?? '—'}</td>
      <td>${daysStr}</td>
      <td>
        <button class="action-btn" onclick="renewCertForDomain('${c.domain}')">Renew</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

qs('#ssl-issue-btn').addEventListener('click', async () => {
  const domainId = qs('#ssl-domain-select').value;
  if (!domainId) { qs('#ssl-error').textContent = 'Select a domain first'; return; }
  const email = prompt('Email for Let\'s Encrypt notifications:');
  if (!email) return;

  qs('#ssl-message').textContent = 'Issuing certificate… this may take a minute.';
  qs('#ssl-error').textContent = '';
  const res  = await api('POST', `/api/domains/${domainId}/ssl`, { email });
  const data = await res.json();
  if (!res.ok) {
    qs('#ssl-error').textContent = data.error;
    qs('#ssl-message').textContent = '';
    return;
  }
  qs('#ssl-message').textContent = `Certificate issued! Expires: ${data.expiresAt?.slice(0,10)}`;
  loadSslCerts();
});

qs('#ssl-renew-btn').addEventListener('click', async () => {
  const domainId = qs('#ssl-domain-select').value;
  if (!domainId) { qs('#ssl-error').textContent = 'Select a domain first'; return; }
  const domain = allDomains.find(d => String(d.id) === String(domainId))?.domain;
  if (domain) renewCertForDomain(domain);
});

async function renewCertForDomain(domain) {
  const domainRow = allDomains.find(d => d.domain === domain);
  if (!domainRow) return;
  qs('#ssl-message').textContent = `Renewing ${domain}…`;
  qs('#ssl-error').textContent = '';
  const res  = await api('POST', `/api/domains/${domainRow.id}/ssl/renew`);
  const data = await res.json();
  qs('#ssl-message').textContent = data.code === 0
    ? `Renewed ${domain} successfully.` : `Renewal attempted (check certbot logs).`;
  loadSslCerts();
}

// ── Panel tab switching (shared) ──────────────────────────────────────────────

function initTabs(panelId) {
  const panel = qs(`#panel-${panelId}`);
  panel.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      panel.querySelectorAll('.tab-panel').forEach(p => hide(p));
      btn.classList.add('active');
      show(qs(`#${panelId}-tab-${btn.dataset.tab}`));
    });
  });
}

// ── Email ─────────────────────────────────────────────────────────────────────

initTabs('email');

function refreshEmailDomainSelects(domains) {
  ['mb-domain-select', 'alias-domain-select', 'dkim-domain-select'].forEach(id => {
    const sel = qs(`#${id}`);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select domain…</option>';
    domains.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.domain;
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  });
}

async function loadEmailPanel() {
  if (!allDomains.length) {
    const res = await api('GET', '/api/domains');
    allDomains = await res.json();
  }
  refreshEmailDomainSelects(allDomains);
  loadMailboxes();
}

async function loadMailboxes() {
  qs('#email-error').textContent = '';
  const res  = await api('GET', '/api/email/mailboxes');
  const data = await res.json();
  if (!res.ok) { qs('#email-error').textContent = data.error; return; }
  const tbody = qs('#mb-tbody');
  tbody.innerHTML = '';
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No mailboxes yet.</td></tr>';
    return;
  }
  data.forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${m.address}</td>
      <td>${m.domain}</td>
      <td>${m.quota_mb} MB</td>
      <td>${m.created_at?.slice(0,10) ?? '—'}</td>
      <td><button class="action-btn danger" onclick="deleteMailbox(${m.id})">Delete</button></td>`;
    tbody.appendChild(tr);
  });
}

qs('#mb-add-btn').addEventListener('click', () => { show(qs('#mb-form')); qs('#mb-local').focus(); });
qs('#mb-cancel-btn').addEventListener('click', () => hide(qs('#mb-form')));

qs('#mb-submit-btn').addEventListener('click', async () => {
  const domainId  = qs('#mb-domain-select').value;
  const local     = qs('#mb-local').value.trim();
  const password  = qs('#mb-password').value;
  const quotaMb   = parseInt(qs('#mb-quota').value, 10) || 500;
  qs('#mb-form-error').textContent = '';

  if (!domainId || !local || !password) {
    qs('#mb-form-error').textContent = 'Domain, username, and password required'; return;
  }
  const domain  = allDomains.find(d => String(d.id) === domainId);
  const address = `${local}@${domain?.domain}`;

  const res  = await api('POST', '/api/email/mailboxes', { domainId, address, password, quotaMb });
  const data = await res.json();
  if (!res.ok) { qs('#mb-form-error').textContent = data.error; return; }
  hide(qs('#mb-form'));
  qs('#mb-local').value = ''; qs('#mb-password').value = '';
  loadMailboxes();
});

async function deleteMailbox(id) {
  if (!confirm('Delete this mailbox and all its mail?')) return;
  const res = await api('DELETE', `/api/email/mailboxes/${id}`);
  if (res.ok) loadMailboxes();
  else { const d = await res.json(); qs('#email-error').textContent = d.error; }
}

// Aliases
qs('#alias-domain-select').addEventListener('change', e => {
  if (e.target.value) loadAliases(e.target.value);
});

async function loadAliases(domainId) {
  const res  = await api('GET', `/api/email/aliases?domainId=${domainId}`);
  const data = await res.json();
  if (!res.ok) { qs('#email-error').textContent = data.error; return; }
  const tbody = qs('#alias-tbody');
  tbody.innerHTML = '';
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted)">No aliases.</td></tr>';
    return;
  }
  data.forEach(a => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${a.source}</td><td>${a.destination}</td>
      <td><button class="action-btn danger" onclick="deleteAlias(${a.id})">Delete</button></td>`;
    tbody.appendChild(tr);
  });
}

qs('#alias-add-btn').addEventListener('click', () => {
  if (!qs('#alias-domain-select').value) { qs('#email-error').textContent = 'Select a domain first'; return; }
  show(qs('#alias-form')); qs('#alias-source').focus();
});
qs('#alias-cancel-btn').addEventListener('click', () => hide(qs('#alias-form')));

qs('#alias-submit-btn').addEventListener('click', async () => {
  const domainId    = qs('#alias-domain-select').value;
  const source      = qs('#alias-source').value.trim();
  const destination = qs('#alias-dest').value.trim();
  qs('#alias-form-error').textContent = '';
  if (!source || !destination) { qs('#alias-form-error').textContent = 'Source and destination required'; return; }
  const res  = await api('POST', '/api/email/aliases', { domainId, source, destination });
  const data = await res.json();
  if (!res.ok) { qs('#alias-form-error').textContent = data.error; return; }
  hide(qs('#alias-form'));
  qs('#alias-source').value = ''; qs('#alias-dest').value = '';
  loadAliases(domainId);
});

async function deleteAlias(id) {
  if (!confirm('Delete this alias?')) return;
  const res = await api('DELETE', `/api/email/aliases/${id}`);
  if (res.ok) loadAliases(qs('#alias-domain-select').value);
  else { const d = await res.json(); qs('#email-error').textContent = d.error; }
}

// DKIM
qs('#dkim-gen-btn').addEventListener('click', async () => {
  const domainId = qs('#dkim-domain-select').value;
  if (!domainId) { qs('#dkim-error').textContent = 'Select a domain first'; return; }
  qs('#dkim-error').textContent = '';
  const res  = await api('POST', '/api/email/dkim', { domainId, selector: 'mail' });
  const data = await res.json();
  if (!res.ok) { qs('#dkim-error').textContent = data.error; return; }
  const pre = qs('#dkim-output');
  pre.style.display = 'block';
  pre.textContent = [
    '=== DKIM key generated ===',
    data.txtContent || '(key file written to ' + data.keyDir + ')',
    '',
    '=== Suggested DNS records ===',
    ...(data.suggestedDnsRecords || []).map(r =>
      `${r.name.padEnd(28)} ${r.ttl} IN ${r.type.padEnd(6)} ${r.priority != null ? r.priority + ' ' : ''}${r.value}`
    ),
  ].join('\n');
});

qs('#email-config-btn').addEventListener('click', async () => {
  const domainId = qs('#dkim-domain-select').value;
  if (!domainId) { qs('#dkim-error').textContent = 'Select a domain first'; return; }
  const res  = await api('GET', `/api/email/config/${domainId}`);
  const data = await res.json();
  if (!res.ok) { qs('#dkim-error').textContent = data.error; return; }
  const pre = qs('#dkim-output');
  pre.style.display = 'block';
  pre.textContent = '=== /etc/postfix/main.cf additions ===\n\n' + data.mainCfSnippet +
    '\n=== Suggested DNS records ===\n' +
    (data.suggestedDnsRecords || []).map(r =>
      `${r.name.padEnd(28)} ${r.ttl} IN ${r.type.padEnd(6)} ${r.priority != null ? r.priority + ' ' : ''}${r.value}`
    ).join('\n');
});

// ── Databases ─────────────────────────────────────────────────────────────────

let activeDatabaseId = null;

async function loadDatabasesPanel() {
  qs('#db-error').textContent = '';
  const res  = await api('GET', '/api/databases');
  const data = await res.json();
  if (!res.ok) { qs('#db-error').textContent = data.error; return; }
  renderDatabases(data);
}

function renderDatabases(rows) {
  const tbody = qs('#db-tbody');
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No databases yet.</td></tr>';
    return;
  }
  rows.forEach(d => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${d.db_name}</td><td>${d.db_user}</td><td>${d.db_host}</td>
      <td>${d.created_at?.slice(0,10) ?? '—'}</td>
      <td>
        <button class="action-btn" onclick="openQueryPanel(${d.id},'${d.db_name}')">Query</button>
        <button class="action-btn danger" onclick="dropDatabase(${d.id},'${d.db_name}')">Drop</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

qs('#db-add-btn').addEventListener('click', () => { show(qs('#db-form')); qs('#db-name-input').focus(); });
qs('#db-cancel-btn').addEventListener('click', () => hide(qs('#db-form')));

qs('#db-submit-btn').addEventListener('click', async () => {
  const dbName     = qs('#db-name-input').value.trim();
  const dbUser     = qs('#db-user-input').value.trim();
  const dbPassword = qs('#db-pass-input').value;
  qs('#db-form-error').textContent = '';
  if (!dbName || !dbUser || !dbPassword) {
    qs('#db-form-error').textContent = 'All fields required'; return;
  }
  const res  = await api('POST', '/api/databases', { dbName, dbUser, dbPassword });
  const data = await res.json();
  if (!res.ok) { qs('#db-form-error').textContent = data.error; return; }
  hide(qs('#db-form'));
  ['#db-name-input','#db-user-input','#db-pass-input'].forEach(s => { qs(s).value = ''; });
  loadDatabasesPanel();
});

async function dropDatabase(id, name) {
  if (!confirm(`Drop database "${name}" and its user? This cannot be undone.`)) return;
  const res = await api('DELETE', `/api/databases/${id}`);
  if (res.ok) loadDatabasesPanel();
  else { const d = await res.json(); qs('#db-error').textContent = d.error; }
}

function openQueryPanel(id, name) {
  activeDatabaseId = id;
  qs('#db-query-name').textContent = name;
  qs('#db-query-input').value = '';
  qs('#db-query-result').innerHTML = '';
  show(qs('#db-query-panel'));
}

qs('#db-query-close-btn').addEventListener('click', () => {
  hide(qs('#db-query-panel'));
  activeDatabaseId = null;
});

qs('#db-query-run-btn').addEventListener('click', async () => {
  const query = qs('#db-query-input').value.trim();
  if (!query || !activeDatabaseId) return;
  const res  = await api('POST', `/api/databases/${activeDatabaseId}/query`, { query });
  const data = await res.json();
  const result = qs('#db-query-result');
  if (!res.ok) { result.innerHTML = `<p class="error">${data.error}</p>`; return; }
  if (!data.columns?.length) { result.innerHTML = '<p style="color:var(--muted)">No results.</p>'; return; }
  const hdrs  = data.columns.map(c => `<th>${c}</th>`).join('');
  const body  = data.rows.map(row =>
    `<tr>${data.columns.map(c => `<td>${row[c] ?? 'NULL'}</td>`).join('')}</tr>`
  ).join('');
  result.innerHTML = `<table class="query-table"><thead><tr>${hdrs}</tr></thead><tbody>${body}</tbody></table>
    <p style="color:var(--muted);font-size:12px;margin-top:6px">${data.rows.length} row(s) returned</p>`;
});

// ── FTP ───────────────────────────────────────────────────────────────────────

async function loadFtpPanel() {
  qs('#ftp-error').textContent = '';
  const res  = await api('GET', '/api/ftp');
  const data = await res.json();
  if (!res.ok) { qs('#ftp-error').textContent = data.error; return; }
  const tbody = qs('#ftp-tbody');
  tbody.innerHTML = '';
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No FTP accounts yet.</td></tr>';
    return;
  }
  data.forEach(a => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${a.ftp_user}</td>
      <td style="font-family:monospace;font-size:12px">${a.chroot_dir}</td>
      <td>${a.created_at?.slice(0,10) ?? '—'}</td>
      <td><button class="action-btn danger" onclick="deleteFtp(${a.id},'${a.ftp_user}')">Delete</button></td>`;
    tbody.appendChild(tr);
  });
}

qs('#ftp-add-btn').addEventListener('click', () => { show(qs('#ftp-form')); qs('#ftp-user-input').focus(); });
qs('#ftp-cancel-btn').addEventListener('click', () => hide(qs('#ftp-form')));

qs('#ftp-submit-btn').addEventListener('click', async () => {
  const ftpUser   = qs('#ftp-user-input').value.trim();
  const password  = qs('#ftp-pass-input').value;
  const chrootDir = qs('#ftp-chroot-input').value.trim();
  qs('#ftp-form-error').textContent = '';
  if (!ftpUser || !password || !chrootDir) {
    qs('#ftp-form-error').textContent = 'All fields required'; return;
  }
  const res  = await api('POST', '/api/ftp', { ftpUser, password, chrootDir });
  const data = await res.json();
  if (!res.ok) { qs('#ftp-form-error').textContent = data.error; return; }
  hide(qs('#ftp-form'));
  ['#ftp-user-input','#ftp-pass-input','#ftp-chroot-input'].forEach(s => { qs(s).value = ''; });
  loadFtpPanel();
});

async function deleteFtp(id, user) {
  if (!confirm(`Delete FTP account "${user}"?`)) return;
  const res = await api('DELETE', `/api/ftp/${id}`);
  if (res.ok) loadFtpPanel();
  else { const d = await res.json(); qs('#ftp-error').textContent = d.error; }
}

qs('#ftp-config-btn').addEventListener('click', async () => {
  const pre = qs('#ftp-config-output');
  if (pre.style.display !== 'none') { pre.style.display = 'none'; return; }
  const res  = await api('GET', '/api/ftp/config');
  const data = await res.json();
  pre.textContent = data.config;
  pre.style.display = 'block';
});

// ── Cron Jobs ─────────────────────────────────────────────────────────────────

async function loadCronPanel() {
  qs('#cron-error').textContent = '';
  const res  = await api('GET', '/api/cron');
  const data = await res.json();
  if (!res.ok) { qs('#cron-error').textContent = data.error; return; }
  const tbody = qs('#cron-tbody');
  tbody.innerHTML = '';
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No cron jobs yet.</td></tr>';
    return;
  }
  data.forEach(j => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-family:monospace">${j.expression}</td>
      <td style="font-family:monospace;font-size:12px">${j.command}</td>
      <td>${j.system_user}</td>
      <td><button class="action-btn danger" onclick="deleteCronJob(${j.id})">Delete</button></td>`;
    tbody.appendChild(tr);
  });
}

qs('#cron-add-btn').addEventListener('click', () => { show(qs('#cron-form')); updateCronPreview(); });
qs('#cron-cancel-btn').addEventListener('click', () => hide(qs('#cron-form')));

function updateCronPreview() {
  const expr = [
    qs('#cron-min').value || '*',
    qs('#cron-hour').value || '*',
    qs('#cron-dom').value || '*',
    qs('#cron-month').value || '*',
    qs('#cron-dow').value || '*',
  ].join(' ');
  qs('#cron-expr-preview').textContent = expr;
}

['#cron-min','#cron-hour','#cron-dom','#cron-month','#cron-dow'].forEach(sel => {
  qs(sel).addEventListener('input', updateCronPreview);
});

qs('#cron-submit-btn').addEventListener('click', async () => {
  const systemUser = qs('#cron-sysuser').value.trim();
  const expression = qs('#cron-expr-preview').textContent.trim();
  const command    = qs('#cron-cmd').value.trim();
  qs('#cron-form-error').textContent = '';
  if (!systemUser || !command) {
    qs('#cron-form-error').textContent = 'System user and command required'; return;
  }
  const res  = await api('POST', '/api/cron', { systemUser, expression, command });
  const data = await res.json();
  if (!res.ok) { qs('#cron-form-error').textContent = data.error; return; }
  hide(qs('#cron-form'));
  ['#cron-sysuser','#cron-cmd'].forEach(s => { qs(s).value = ''; });
  ['#cron-min','#cron-hour','#cron-dom','#cron-month','#cron-dow'].forEach(s => { qs(s).value = '*'; });
  loadCronPanel();
});

async function deleteCronJob(id) {
  if (!confirm('Delete this cron job?')) return;
  const res = await api('DELETE', `/api/cron/${id}`);
  if (res.ok) loadCronPanel();
  else { const d = await res.json(); qs('#cron-error').textContent = d.error; }
}

// ── App Installer ─────────────────────────────────────────────────────────────

initTabs('apps');

function refreshAppDomainSelects(domains) {
  ['wp-domain-select','ghost-domain-select','static-domain-select'].forEach(id => {
    const sel = qs(`#${id}`);
    sel.innerHTML = '<option value="">Select domain (optional)…</option>';
    domains.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id; opt.textContent = d.domain;
      sel.appendChild(opt);
    });
  });
}

async function loadAppsPanel() {
  if (!allDomains.length) {
    const res = await api('GET', '/api/domains');
    allDomains = await res.json();
  }
  refreshAppDomainSelects(allDomains);
  loadInstalledApps();
}

async function loadInstalledApps() {
  const res  = await api('GET', '/api/apps');
  const data = await res.json();
  if (!res.ok) { qs('#apps-error').textContent = data.error; return; }
  const tbody = qs('#apps-tbody');
  tbody.innerHTML = '';
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">No apps installed yet.</td></tr>';
    return;
  }
  data.forEach(a => {
    const statusClass = a.status === 'active' ? 'badge-active' : a.status === 'failed' ? 'badge-failed' : 'badge-pending';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="badge badge-active">${a.app_type}</span></td>
      <td style="font-family:monospace;font-size:12px">${a.install_dir}</td>
      <td>${a.db_name || '—'}</td>
      <td>${a.pm2_name || '—'}</td>
      <td><span class="badge ${statusClass}">${a.status}</span></td>
      <td><button class="action-btn danger" onclick="uninstallApp(${a.id},'${a.app_type}')">Uninstall</button></td>`;
    tbody.appendChild(tr);
  });
}

function streamInstall(url, body, logEl, btnEl) {
  logEl.style.display = 'block';
  logEl.textContent   = '';
  btnEl.disabled      = true;

  return fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body:    JSON.stringify(body),
  }).then(res => {
    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) { btnEl.disabled = false; loadInstalledApps(); return; }
        const text = dec.decode(value);
        text.split('\n').filter(l => l.startsWith('data:')).forEach(line => {
          try {
            const d = JSON.parse(line.slice(5));
            if (d.log)   { logEl.textContent += d.log + '\n'; logEl.scrollTop = logEl.scrollHeight; }
            if (d.error) { logEl.textContent += '✗ ' + d.error + '\n'; }
            if (d.done)  { logEl.textContent += '✓ Complete\n'; }
          } catch { /* partial chunk */ }
        });
        return pump();
      });
    }
    return pump();
  }).catch(err => {
    logEl.textContent += '✗ ' + err.message;
    btnEl.disabled = false;
  });
}

qs('#wp-install-btn').addEventListener('click', () => {
  streamInstall('/api/apps/wordpress', {
    domainId:    qs('#wp-domain-select').value || null,
    installDir:  qs('#wp-install-dir').value.trim(),
    dbName:      qs('#wp-db-name').value.trim(),
    dbUser:      qs('#wp-db-user').value.trim(),
    dbPassword:  qs('#wp-db-pass').value,
    siteUrl:     qs('#wp-site-url').value.trim(),
    adminEmail:  qs('#wp-admin-email').value.trim(),
  }, qs('#wp-log'), qs('#wp-install-btn'));
});

qs('#ghost-install-btn').addEventListener('click', () => {
  streamInstall('/api/apps/ghost', {
    domainId:   qs('#ghost-domain-select').value || null,
    installDir: qs('#ghost-install-dir').value.trim(),
    siteUrl:    qs('#ghost-site-url').value.trim(),
    pm2Name:    qs('#ghost-pm2-name').value.trim() || undefined,
  }, qs('#ghost-log'), qs('#ghost-install-btn'));
});

qs('#static-install-btn').addEventListener('click', () => {
  streamInstall('/api/apps/static', {
    domainId:    qs('#static-domain-select').value || null,
    installDir:  qs('#static-install-dir').value.trim(),
    archivePath: qs('#static-archive-path').value.trim(),
  }, qs('#static-log'), qs('#static-install-btn'));
});

async function uninstallApp(id, type) {
  if (!confirm(`Uninstall this ${type} app? Files and database will be deleted.`)) return;
  const logEl = document.createElement('pre');
  logEl.className = 'zone-pre';
  qs('#apps-error').after(logEl);

  const res = await fetch(`/api/apps/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  const pump   = () => reader.read().then(({ done, value }) => {
    if (done) { loadInstalledApps(); return; }
    dec.decode(value).split('\n').filter(l => l.startsWith('data:')).forEach(line => {
      try { const d = JSON.parse(line.slice(5)); if (d.log) logEl.textContent += d.log + '\n'; } catch { /* ignore */ }
    });
    return pump();
  });
  pump();
}

// ── Processes ─────────────────────────────────────────────────────────────────

let logWs = null;

async function loadProcessesPanel() {
  await refreshProcessList();
}

async function refreshProcessList() {
  qs('#proc-error').textContent = '';
  const res  = await api('GET', '/api/processes');
  const data = await res.json();
  if (!res.ok) { qs('#proc-error').textContent = data.error; return; }
  renderProcesses(Array.isArray(data) ? data : []);
}

function renderProcesses(procs) {
  const tbody = qs('#proc-tbody');
  tbody.innerHTML = '';
  if (!procs.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted)">No PM2 processes running.</td></tr>';
    return;
  }
  procs.forEach(p => {
    const dotClass = p.status === 'online' ? 'dot-online'
                   : p.status === 'stopped' ? 'dot-stopped'
                   : p.status === 'errored' ? 'dot-errored' : 'dot-unknown';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td>${p.name}</td>
      <td><span class="proc-status"><span class="proc-dot ${dotClass}"></span>${p.status}</span></td>
      <td>${p.cpu}%</td>
      <td>${p.memMb} MB</td>
      <td>${p.restarts}</td>
      <td>
        <button class="action-btn" onclick="procAction('restart','${p.name}')">Restart</button>
        <button class="action-btn" onclick="procAction('stop','${p.name}')">Stop</button>
        <button class="action-btn" onclick="openProcLogs('${p.name}')">Logs</button>
        <button class="action-btn danger" onclick="procAction('delete','${p.name}')">Delete</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

async function procAction(action, name) {
  const methodMap = { restart: 'POST', stop: 'POST', delete: 'DELETE' };
  const pathMap   = { restart: `/api/processes/${name}/restart`, stop: `/api/processes/${name}/stop`, delete: `/api/processes/${name}` };
  await api(methodMap[action], pathMap[action]);
  await refreshProcessList();
}

function openProcLogs(name) {
  qs('#proc-log-name').textContent = name;
  qs('#proc-log-output').textContent = '';
  show(qs('#proc-log-panel'));

  if (logWs) { try { logWs.close(); } catch { /* ignore */ } }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  logWs = new WebSocket(`${proto}://${location.host}/ws/logs?token=${encodeURIComponent(accessToken)}&name=${encodeURIComponent(name)}`);
  logWs.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.line) {
        const pre = qs('#proc-log-output');
        pre.textContent += d.line;
        pre.scrollTop = pre.scrollHeight;
      }
    } catch { /* ignore */ }
  };
}

qs('#proc-log-close-btn').addEventListener('click', () => {
  hide(qs('#proc-log-panel'));
  if (logWs) { logWs.close(); logWs = null; }
});

qs('#proc-refresh-btn').addEventListener('click', refreshProcessList);
qs('#proc-save-btn').addEventListener('click', async () => {
  await api('POST', '/api/processes/save');
  qs('#proc-error').textContent = 'Process list saved.';
});

// ── Git Deploy ────────────────────────────────────────────────────────────────

let activeHookId = null;

async function loadDeployPanel() {
  qs('#deploy-error').textContent = '';
  const res  = await api('GET', '/api/deploy');
  const data = await res.json();
  if (!res.ok) { qs('#deploy-error').textContent = data.error; return; }
  renderDeployHooks(data);
}

function renderDeployHooks(hooks) {
  const tbody = qs('#deploy-tbody');
  tbody.innerHTML = '';
  if (!hooks.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">No deploy hooks yet.</td></tr>';
    return;
  }
  hooks.forEach(h => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${h.name}</td>
      <td style="font-family:monospace;font-size:12px">${h.deploy_dir}</td>
      <td>${h.branch}</td>
      <td style="font-family:monospace;font-size:12px">${h.build_cmd || '—'}</td>
      <td>${h.pm2_name || '—'}</td>
      <td>
        <button class="action-btn" onclick="showDeployHistory(${h.id},'${h.name}')">History</button>
        <button class="action-btn danger" onclick="deleteDeployHook(${h.id})">Delete</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

qs('#deploy-add-btn').addEventListener('click', () => { show(qs('#deploy-form')); qs('#deploy-name').focus(); });
qs('#deploy-cancel-btn').addEventListener('click', () => hide(qs('#deploy-form')));

qs('#deploy-submit-btn').addEventListener('click', async () => {
  const name      = qs('#deploy-name').value.trim();
  const deployDir = qs('#deploy-dir').value.trim();
  const branch    = qs('#deploy-branch').value.trim() || 'main';
  const buildCmd  = qs('#deploy-build-cmd').value.trim() || undefined;
  const pm2Name   = qs('#deploy-pm2-name').value.trim() || undefined;
  qs('#deploy-form-error').textContent = '';
  if (!name || !deployDir) { qs('#deploy-form-error').textContent = 'Name and directory required'; return; }

  const res  = await api('POST', '/api/deploy', { name, deployDir, branch, buildCmd, pm2Name });
  const data = await res.json();
  if (!res.ok) { qs('#deploy-form-error').textContent = data.error; return; }
  hide(qs('#deploy-form'));
  ['#deploy-name','#deploy-dir','#deploy-build-cmd','#deploy-pm2-name'].forEach(s => { qs(s).value = ''; });
  qs('#deploy-branch').value = 'main';
  loadDeployPanel();
});

async function deleteDeployHook(id) {
  if (!confirm('Delete this deploy hook?')) return;
  const res = await api('DELETE', `/api/deploy/${id}`);
  if (res.ok) loadDeployPanel();
  else { const d = await res.json(); qs('#deploy-error').textContent = d.error; }
}

async function showDeployHistory(hookId, name) {
  activeHookId = hookId;
  qs('#deploy-history-name').textContent = name;
  qs('#deploy-webhook-url').textContent =
    `Webhook URL: ${location.origin}/api/deploy/webhook/${hookId}`;
  show(qs('#deploy-history-panel'));

  const res  = await api('GET', `/api/deploy/${hookId}/history`);
  const data = await res.json();
  if (!res.ok) { qs('#deploy-error').textContent = data.error; return; }
  const tbody = qs('#deploy-history-tbody');
  tbody.innerHTML = '';
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No deploys yet.</td></tr>';
    return;
  }
  data.forEach(d => {
    const statusClass = d.status === 'success' ? 'badge-active' : d.status === 'failed' ? 'badge-failed' : 'badge-pending';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="badge ${statusClass}">${d.status}</span></td>
      <td style="font-family:monospace">${d.commit_sha?.slice(0,8) || '—'}</td>
      <td>${d.commit_msg?.slice(0,60) || '—'}</td>
      <td>${d.started_at?.slice(0,16) || '—'}</td>
      <td><details><summary style="cursor:pointer;color:var(--muted)">view</summary><pre style="font-size:11px;white-space:pre-wrap">${d.output || ''}</pre></details></td>`;
    tbody.appendChild(tr);
  });
}

qs('#deploy-history-close-btn').addEventListener('click', () => {
  hide(qs('#deploy-history-panel'));
  activeHookId = null;
});

// ── Profile panel ─────────────────────────────────────────────────────────────

qs('#nav-profile-btn').addEventListener('click', () => {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  switchPanel('profile');
});

async function loadProfilePanel() {
  qs('#profile-pw-error').textContent = '';
  qs('#profile-pw-msg').textContent   = '';
  loadApiKeys();
}

qs('#profile-pw-btn').addEventListener('click', async () => {
  const curr    = qs('#profile-pw-current').value;
  const next    = qs('#profile-pw-new').value;
  const confirm = qs('#profile-pw-confirm').value;
  qs('#profile-pw-error').textContent = '';
  qs('#profile-pw-msg').textContent   = '';

  if (!curr || !next || !confirm) { qs('#profile-pw-error').textContent = 'All fields required'; return; }
  if (next !== confirm)           { qs('#profile-pw-error').textContent = 'Passwords do not match'; return; }
  if (next.length < 8)            { qs('#profile-pw-error').textContent = 'Password must be at least 8 characters'; return; }

  // Verify current password by attempting a login with it
  const verRes = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser.username, password: curr }),
  });
  if (!verRes.ok) { qs('#profile-pw-error').textContent = 'Current password is incorrect'; return; }

  const res  = await api('PATCH', `/api/users/${currentUser.id}/password`, { password: next });
  const data = await res.json();
  if (!res.ok) { qs('#profile-pw-error').textContent = data.error; return; }

  qs('#profile-pw-current').value = '';
  qs('#profile-pw-new').value     = '';
  qs('#profile-pw-confirm').value = '';
  qs('#profile-pw-msg').textContent = 'Password updated.';
});

async function loadApiKeys() {
  const res  = await api('GET', '/api/auth/keys');
  const data = await res.json();
  if (!res.ok) { qs('#apikeys-error').textContent = data.error; return; }

  const tbody = qs('#apikeys-tbody');
  tbody.innerHTML = '';
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No API keys yet.</td></tr>';
    return;
  }
  data.forEach(k => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${k.name}</td>
      <td style="font-family:monospace">${k.prefix}…</td>
      <td>${k.last_used?.slice(0, 16) || 'Never'}</td>
      <td><button class="action-btn danger" onclick="revokeApiKey(${k.id})">Revoke</button></td>`;
    tbody.appendChild(tr);
  });
}

qs('#apikey-generate-btn').addEventListener('click', async () => {
  const name = qs('#apikey-name-input').value.trim();
  qs('#apikeys-error').textContent = '';
  if (!name) { qs('#apikeys-error').textContent = 'Key name required'; return; }

  const res  = await api('POST', '/api/auth/keys', { name });
  const data = await res.json();
  if (!res.ok) { qs('#apikeys-error').textContent = data.error; return; }

  qs('#apikey-name-input').value = '';
  qs('#apikey-plaintext').textContent = data.plaintext;
  show(qs('#apikey-reveal'));
  loadApiKeys();
});

qs('#apikey-copy-btn').addEventListener('click', () => {
  const text = qs('#apikey-plaintext').textContent;
  navigator.clipboard.writeText(text).then(() => {
    qs('#apikey-copy-btn').textContent = 'Copied!';
    setTimeout(() => { qs('#apikey-copy-btn').textContent = 'Copy'; }, 2000);
  });
});

async function revokeApiKey(id) {
  if (!confirm('Revoke this API key?')) return;
  const res = await api('DELETE', `/api/auth/keys/${id}`);
  if (res.ok) { hide(qs('#apikey-reveal')); loadApiKeys(); }
  else { const d = await res.json(); qs('#apikeys-error').textContent = d.error; }
}

// ── Users panel (admin) ────────────────────────────────────────────────────────

let resetTargetId = null;

async function loadUsersPanel() {
  qs('#users-error').textContent = '';
  hide(qs('#user-form'));
  hide(qs('#user-reset-form'));

  const res  = await api('GET', '/api/users');
  const data = await res.json();
  if (!res.ok) { qs('#users-error').textContent = data.error; return; }

  const tbody = qs('#users-tbody');
  tbody.innerHTML = '';
  data.forEach(u => {
    const isSelf = u.id === currentUser?.id;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${u.username}${isSelf ? ' <span style="color:var(--muted);font-size:11px">(you)</span>' : ''}</td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-active' : 'badge-pending'}">${u.role}</span></td>
      <td>${u.domains}</td>
      <td>${u.databases}</td>
      <td>${u.mailboxes}</td>
      <td>${u.created_at?.slice(0, 10) || '—'}</td>
      <td>${u.last_login?.slice(0, 16) || 'Never'}</td>
      <td>
        <button class="action-btn" onclick="openUserReset(${u.id},'${u.username}')">Reset PW</button>
        ${!isSelf ? `<button class="action-btn danger" onclick="deleteUser(${u.id})">Delete</button>` : ''}
      </td>`;
    tbody.appendChild(tr);
  });
}

qs('#user-add-btn').addEventListener('click', () => {
  show(qs('#user-form'));
  qs('#user-username-input').focus();
});
qs('#user-cancel-btn').addEventListener('click', () => hide(qs('#user-form')));

qs('#user-submit-btn').addEventListener('click', async () => {
  const username = qs('#user-username-input').value.trim();
  const password = qs('#user-password-input').value;
  const role     = qs('#user-role-select').value;
  qs('#user-form-error').textContent = '';
  if (!username || !password) { qs('#user-form-error').textContent = 'Username and password required'; return; }

  const res  = await api('POST', '/api/users', { username, password, role });
  const data = await res.json();
  if (!res.ok) { qs('#user-form-error').textContent = data.error; return; }

  qs('#user-username-input').value = '';
  qs('#user-password-input').value = '';
  hide(qs('#user-form'));
  loadUsersPanel();
});

function openUserReset(id, name) {
  resetTargetId = id;
  qs('#user-reset-name').textContent = name;
  qs('#user-reset-pw').value = '';
  qs('#user-reset-error').textContent = '';
  show(qs('#user-reset-form'));
  qs('#user-reset-pw').focus();
}

qs('#user-reset-cancel-btn').addEventListener('click', () => {
  hide(qs('#user-reset-form'));
  resetTargetId = null;
});

qs('#user-reset-submit-btn').addEventListener('click', async () => {
  const password = qs('#user-reset-pw').value;
  qs('#user-reset-error').textContent = '';
  if (!password) { qs('#user-reset-error').textContent = 'Password required'; return; }

  const res  = await api('PATCH', `/api/users/${resetTargetId}/password`, { password });
  const data = await res.json();
  if (!res.ok) { qs('#user-reset-error').textContent = data.error; return; }

  hide(qs('#user-reset-form'));
  resetTargetId = null;
});

async function deleteUser(id) {
  if (!confirm('Delete this user and all their data?')) return;
  const res = await api('DELETE', `/api/users/${id}`);
  if (res.ok) loadUsersPanel();
  else { const d = await res.json(); qs('#users-error').textContent = d.error; }
}

// ── Audit Log panel (admin) ────────────────────────────────────────────────────

let auditOffset = 0;
const AUDIT_LIMIT = 50;
let auditTotal = 0;

async function loadAuditPanel() {
  qs('#audit-error').textContent = '';
  // Populate action dropdown on first load
  const actRes  = await api('GET', '/api/audit/actions');
  const actions = actRes.ok ? await actRes.json() : [];
  const sel = qs('#audit-filter-action');
  if (sel.children.length === 1) { // only the "All actions" option
    actions.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      sel.appendChild(opt);
    });
  }
  auditOffset = 0;
  fetchAuditPage();
}

async function fetchAuditPage() {
  const username = qs('#audit-filter-user').value.trim();
  const action   = qs('#audit-filter-action').value;
  const params   = new URLSearchParams({ limit: AUDIT_LIMIT, offset: auditOffset });
  if (username) params.set('username', username);
  if (action)   params.set('action', action);

  const res  = await api('GET', `/api/audit?${params}`);
  const data = await res.json();
  if (!res.ok) { qs('#audit-error').textContent = data.error; return; }

  auditTotal = data.total;
  const tbody = qs('#audit-tbody');
  tbody.innerHTML = '';

  if (!data.rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">No entries found.</td></tr>';
  } else {
    data.rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="white-space:nowrap">${r.ts?.slice(0, 16) || '—'}</td>
        <td>${r.username || '—'}</td>
        <td><code style="font-size:11px">${r.action}</code></td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.target || ''}">${r.target || '—'}</td>
        <td style="font-family:monospace;font-size:11px">${r.ip || '—'}</td>
        <td>${r.result || '—'}</td>`;
      tbody.appendChild(tr);
    });
  }

  const page = Math.floor(auditOffset / AUDIT_LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(auditTotal / AUDIT_LIMIT));
  qs('#audit-page-info').textContent = `Page ${page} of ${pages} (${auditTotal} total)`;
  qs('#audit-prev-btn').disabled = auditOffset === 0;
  qs('#audit-next-btn').disabled = auditOffset + AUDIT_LIMIT >= auditTotal;
}

qs('#audit-search-btn').addEventListener('click', () => { auditOffset = 0; fetchAuditPage(); });
qs('#audit-prev-btn').addEventListener('click',  () => { auditOffset = Math.max(0, auditOffset - AUDIT_LIMIT); fetchAuditPage(); });
qs('#audit-next-btn').addEventListener('click',  () => { auditOffset += AUDIT_LIMIT; fetchAuditPage(); });

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
  if (!accessToken) return;
  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const refreshed = await tryRefresh();
      if (!refreshed) { accessToken = null; localStorage.removeItem('zpanel_token'); return; }
    }
    const me = await res.json();
    currentUser = me;
    qs('#nav-username').textContent = me.username;
    enterDashboard();
  } catch {
    accessToken = null;
    localStorage.removeItem('zpanel_token');
  }
})();
