/* Zpanel — Phase 1 frontend */

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
  if (name === 'files') loadDir(currentPath);
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
