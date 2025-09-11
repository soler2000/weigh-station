const panel     = document.getElementById('panel');
const weightEl  = document.getElementById('weight');
const sel       = document.getElementById('variant');
const serial    = document.getElementById('serial');
const form      = document.getElementById('form');
const passEl    = document.getElementById('passCount');
const failEl    = document.getElementById('failCount');

let ws = null;
let pollTimer = null;

async function loadVariants() {
  const res = await fetch('/api/variants', { cache: 'no-store' });
  const vs = await res.json();
  sel.innerHTML = vs.map(v => `<option value="${v.id}" data-min="${v.min_g}" data-max="${v.max_g}">
      ${v.name} [${v.min_g}-${v.max_g} g]
  </option>`).join('');
}

async function refreshStats() {
  const variant_id = sel.value || '';
  const url = variant_id ? `/api/stats?variant_id=${variant_id}` : '/api/stats';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return;
  const s = await res.json();
  if (passEl) passEl.textContent = s.pass ?? 0;
  if (failEl) failEl.textContent = s.fail ?? 0;
}

function updateColor(g) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt) { panel.className = 'neutral'; return; }
  const min = parseFloat(opt.dataset.min), max = parseFloat(opt.dataset.max);
  panel.className = (g >= min && g <= max) ? 'green' : 'red';
}

function handleReading(data) {
  const g = Number(data.g ?? data.G ?? 0);
  weightEl.textContent = g.toFixed(1);
  updateColor(g);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/debug/latest', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        handleReading(data);
      }
    } catch {}
  }, 300);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function connectWS() {
  try {
    const protocol = (location.protocol === 'https:') ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}/ws/weight`);
    ws.onopen    = () => { stopPolling(); };
    ws.onmessage = (e) => handleReading(JSON.parse(e.data));
    ws.onerror   = () => { try { ws.close(); } catch {}; startPolling(); };
    ws.onclose   = () => { startPolling(); setTimeout(connectWS, 1000); };
  } catch {
    startPolling();
    setTimeout(connectWS, 2000);
  }
}

sel?.addEventListener('change', () => { refreshStats(); serial?.focus(); });

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const variant_id = sel.value;
  const s = serial.value.trim();
  if (!s) { alert('Serial cannot be blank.'); serial.focus(); return; }
  const res = await fetch(`/api/weigh/commit?variant_id=${encodeURIComponent(variant_id)}&serial=${encodeURIComponent(s)}`, { method: 'POST' });
  if (res.ok) {
    serial.value = '';
    serial.focus();
    refreshStats();
  } else {
    if (res.status === 409) alert('This serial was already used. Please scan a new one.');
    else if (res.status === 400) alert('Serial cannot be blank.');
    else if (res.status === 404) alert('Variant not found.');
    else alert('Save failed.');
  }
});

window.addEventListener('load', async () => {
  await loadVariants();
  await refreshStats();
  connectWS();
  setInterval(refreshStats, 3000);
  serial?.focus();
});
