const fs = require('fs');

// ── /proc/stat CPU parsing ────────────────────────────────────────────────────

let prevCpu = null;

function readCpuRaw() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  // cpu  user nice system idle iowait irq softirq steal guest guest_nice
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
  const idleTime  = idle + (iowait || 0);
  const totalTime = user + nice + system + idle + (iowait || 0) + (irq || 0) + (softirq || 0) + (steal || 0);
  return { idleTime, totalTime };
}

function getCpuPercent() {
  const curr = readCpuRaw();
  if (!prevCpu) {
    prevCpu = curr;
    return 0;
  }
  const deltaTotal = curr.totalTime - prevCpu.totalTime;
  const deltaIdle  = curr.idleTime  - prevCpu.idleTime;
  prevCpu = curr;
  if (deltaTotal === 0) return 0;
  return Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 100 * 10) / 10;
}

// ── /proc/meminfo RAM parsing ─────────────────────────────────────────────────

function getMemInfo() {
  const raw = fs.readFileSync('/proc/meminfo', 'utf8');
  const map = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) map[m[1]] = parseInt(m[2], 10); // kB
  }
  const total     = map['MemTotal']     || 0;
  const available = map['MemAvailable'] || 0;
  const used      = total - available;
  return {
    totalMB:     Math.round(total     / 1024),
    usedMB:      Math.round(used      / 1024),
    availableMB: Math.round(available / 1024),
    percentUsed: total ? Math.round((used / total) * 100 * 10) / 10 : 0,
  };
}

// ── Disk via df ───────────────────────────────────────────────────────────────

function getDiskInfo() {
  // Read /proc/mounts and use statfs-style approach via df output file
  // We use the shell module for df to keep all process spawning audited,
  // but for stats we do a direct read from /proc/mounts + statvfs-equivalent
  // using the df output synchronously via execFileSync.
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('df', ['-k', '/'], { encoding: 'utf8', shell: false });
    // Filesystem 1K-blocks Used Available Use% Mounted
    const lines = out.trim().split('\n');
    const parts = lines[1].trim().split(/\s+/);
    const totalKB = parseInt(parts[1], 10);
    const usedKB  = parseInt(parts[2], 10);
    const availKB = parseInt(parts[3], 10);
    return {
      totalGB:     Math.round(totalKB / 1024 / 1024 * 10) / 10,
      usedGB:      Math.round(usedKB  / 1024 / 1024 * 10) / 10,
      availableGB: Math.round(availKB / 1024 / 1024 * 10) / 10,
      percentUsed: parseInt(parts[4], 10),
    };
  } catch {
    return { totalGB: 0, usedGB: 0, availableGB: 0, percentUsed: 0 };
  }
}

// ── Uptime ────────────────────────────────────────────────────────────────────

function getUptime() {
  const raw = fs.readFileSync('/proc/uptime', 'utf8');
  const seconds = parseFloat(raw.split(' ')[0]);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600)  / 60);
  const s = Math.floor(seconds % 60);
  return { seconds: Math.floor(seconds), human: `${d}d ${h}h ${m}m ${s}s` };
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

function getSnapshot() {
  return {
    cpu:    { percentUsed: getCpuPercent() },
    memory: getMemInfo(),
    disk:   getDiskInfo(),
    uptime: getUptime(),
    ts:     Date.now(),
  };
}

module.exports = { getSnapshot, getCpuPercent, getMemInfo, getDiskInfo, getUptime };
