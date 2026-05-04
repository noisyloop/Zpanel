/* Zpanel — Phase 1 + 2 frontend */

// ── State ─────────────────────────────────────────────────────────────────────

let accessToken = localStorage.getItem('zpanel_token') || null;
let wsConn      = null;
let cpuHistory  = new Array(30).fill(0);
let ramHistory  = new Array(30).fill(0);

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
  switchPanel('stats');
  connectWs();
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
  if (name === 'files')   loadDir(currentPath);
  if (name === 'domains') loadDomains();
  if (name === 'dns')     loadDnsPanel();
  if (name === 'ssl')     loadSslPanel();
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
    qs('#nav-username').textContent = me.username;
    enterDashboard();
  } catch {
    accessToken = null;
    localStorage.removeItem('zpanel_token');
  }
})();
