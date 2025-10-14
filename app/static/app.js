const panel     = document.getElementById('panel');
const weightEl  = document.getElementById('weight');
const sel       = document.getElementById('variant');
const serial    = document.getElementById('serial');
const form      = document.getElementById('form');
const passEl    = document.getElementById('passCount');
const failEl    = document.getElementById('failCount');

let ws = null;
let pollTimer = null;
const tzOffsetMinutes = new Date().getTimezoneOffset();

async function loadVariants() {
  const res = await fetch('/api/variants', { cache: 'no-store' });
  const vs = await res.json();
  sel.innerHTML = vs.map(v => `<option value="${v.id}" data-min="${v.min_g}" data-max="${v.max_g}">
      ${v.name} [${v.min_g}-${v.max_g} g]
  </option>`).join('');
}

async function refreshStats() {
  const params = new URLSearchParams();
  const variant_id = sel.value || '';
  if (variant_id) params.set('variant_id', variant_id);
  params.set('tz_offset', String(tzOffsetMinutes));
  const qs = params.toString();
  const res = await fetch(`/api/stats${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
  if (!res.ok) return;
  const s = await res.json();
  if (passEl) passEl.textContent = s.pass ?? 0;
  if (failEl) failEl.textContent = s.fail ?? 0;
}

function updateColor(g) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt) { panel.className = 'neutral'; return; }
  const min = parseFloat(opt.dataset.min), max = parseFloat(opt.dataset.max);
  if (Math.abs(g) < 5) {
    panel.className = 'neutral';
    return;
  }
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
  const params = new URLSearchParams({ variant_id, serial: s });
  const submit = (qs) => fetch(`/api/weigh/commit?${qs}`, { method: 'POST' });
  const attempt = await submit(params.toString());
  if (attempt.status === 409) {
    let detail = null;
    try { detail = await attempt.json(); } catch {}
    const message = (detail && typeof detail === 'object')
      ? (detail.detail?.message || detail.message || detail.detail)
      : null;
    const promptMsg = message
      ? `${message} Update the existing record with the new values?`
      : 'Duplicate serial detected. Update the existing record with the new values?';
    if (confirm(promptMsg)) {
      params.set('overwrite', 'true');
      const overwriteRes = await submit(params.toString());
      if (!overwriteRes.ok) { alert('Save failed.'); return; }
      serial.value = '';
      serial.focus();
      refreshStats();
    } else {
      alert('Save cancelled — existing record not updated.');
      serial.focus();
    }
    return;
  }
  if (attempt.ok) {
    serial.value = '';
    serial.focus();
    refreshStats();
  } else if (attempt.status === 400) {
    alert('Serial cannot be blank.');
    serial.focus();
  } else if (attempt.status === 404) {
    alert('Variant not found.');
  } else {
    alert('Save failed.');
  }
});

window.addEventListener('load', async () => {
  await loadVariants();
  await refreshStats();
  connectWS();
  setInterval(refreshStats, 3000);
  serial?.focus();
});
