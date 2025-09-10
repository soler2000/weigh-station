const panel     = document.getElementById('panel');
const weightEl  = document.getElementById('weight');
const sel       = document.getElementById('variant');
const serial    = document.getElementById('serial');
const form      = document.getElementById('form');
const passEl    = document.getElementById('passCount');
const failEl    = document.getElementById('failCount');

async function loadVariants() {
  const res = await fetch('/api/variants');
  const vs = await res.json();
  sel.innerHTML = vs.map(v => `<option value="${v.id}" data-min="${v.min_g}" data-max="${v.max_g}">
      ${v.name} [${v.min_g}-${v.max_g} g]
  </option>`).join('');
}

async function refreshStats() {
  const variant_id = sel.value || '';
  const url = variant_id ? `/api/stats?variant_id=${variant_id}` : '/api/stats';
  const res = await fetch(url);
  if (!res.ok) return;
  const s = await res.json();
  passEl.textContent = s.pass ?? 0;
  failEl.textContent = s.fail ?? 0;
}

function updateColor(g) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return panel.className = 'neutral';
  const min = parseFloat(opt.dataset.min), max = parseFloat(opt.dataset.max);
  panel.className = (g >= min && g <= max) ? 'green' : 'red';
}

function connectWS() {
  const protocol = (location.protocol === 'https:') ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws/weight`);
  ws.onmessage = (e) => {
    const { g } = JSON.parse(e.data);
    weightEl.textContent = g.toFixed(1);
    updateColor(g);
  };
  ws.onclose = () => setTimeout(connectWS, 1000); // simple reconnect
}

sel.addEventListener('change', () => {
  refreshStats();
  serial.focus();
});

form.addEventListener('submit', async (e) => {
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
    if (res.status === 409) {
      alert('This serial was already used. Please scan a new one.');
    } else if (res.status === 400) {
      alert('Serial cannot be blank.');
    } else if (res.status === 404) {
      alert('Variant not found.');
    } else {
      alert('Save failed.');
    }
  }
});

window.addEventListener('load', async () => {
  await loadVariants();
  await refreshStats();
  connectWS();
  serial.focus();
});