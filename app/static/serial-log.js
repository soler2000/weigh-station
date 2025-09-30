const tbody = document.getElementById('log-body');
const limitSelect = document.getElementById('limit');
const autoToggle = document.getElementById('auto');
const refreshBtn = document.getElementById('refresh');
const statusEl = document.getElementById('status');

let autoTimer = null;
let previousKeys = new Set();

function formatStable(value) {
  if (value === true) return 'stable';
  if (value === false) return 'unstable';
  return '—';
}

function formatGrams(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return value.toFixed(3);
}

function formatRawCounts(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Math.round(value).toString();
}

function render(lines) {
  const frag = document.createDocumentFragment();
  const nextKeys = new Set();

  for (const line of lines) {
    const key = `${line.ts ?? ''}|${line.raw ?? ''}|${line.event ?? ''}`;
    nextKeys.add(key);

    const tr = document.createElement('tr');
    if (!previousKeys.has(key)) {
      tr.classList.add('new');
      setTimeout(() => tr.classList.remove('new'), 1800);
    }

    const cells = [
      line.ts ?? '—',
      line.raw ?? '',
      formatGrams(line.grams),
      formatRawCounts(line.raw_counts),
      formatStable(line.stable_hint),
      line.event ? line.event : (line.parsed ? '' : 'Ignored (no numeric value)'),
    ];

    cells.forEach((value, idx) => {
      const td = document.createElement('td');
      if (idx === 1) td.classList.add('raw-text');
      if (idx >= 2 && idx <= 4) td.classList.add('small');
      const text = value === undefined || value === null || value === '' ? '—' : String(value);
      td.textContent = text;
      tr.appendChild(td);
    });

    frag.appendChild(tr);
  }

  tbody.innerHTML = '';
  tbody.appendChild(frag);
  previousKeys = nextKeys;
}

async function refresh(showLoading = true) {
  const limit = Number(limitSelect?.value || 100) || 100;
  if (showLoading) statusEl.textContent = 'Refreshing…';
  try {
    const res = await fetch(`/api/scale/serial-log?limit=${encodeURIComponent(limit)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    render(lines);
    const now = new Date();
    statusEl.textContent = `Updated ${now.toLocaleTimeString()} • showing ${lines.length} frame${lines.length === 1 ? '' : 's'}`;
  } catch (err) {
    statusEl.textContent = `Failed to load log (${err.message || err})`;
  }
}

function updateAutoTimer() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (autoToggle?.checked) {
    autoTimer = setInterval(() => refresh(false), 1000);
  }
}

limitSelect?.addEventListener('change', () => refresh());
autoToggle?.addEventListener('change', () => updateAutoTimer());
refreshBtn?.addEventListener('click', () => refresh());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  } else {
    updateAutoTimer();
    refresh(false);
  }
});

window.addEventListener('load', () => {
  refresh();
  updateAutoTimer();
});
