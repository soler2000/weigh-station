const panel   = document.getElementById('panel');
const weightEl= document.getElementById('weight');
const sel     = document.getElementById('variant');
const serial  = document.getElementById('serial');
const form    = document.getElementById('form');

async function loadVariants() {
  const res = await fetch('/api/variants');
  const vs = await res.json();
  sel.innerHTML = vs.map(v => `<option value="${v.id}" data-min="${v.min_g}" data-max="${v.max_g}">
      ${v.name} [${v.min_g}-${v.max_g} g]
  </option>`).join('');
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const variant_id = sel.value;
  const s = serial.value.trim();
  if (!s) return;
  const res = await fetch(`/api/weigh/commit?variant_id=${encodeURIComponent(variant_id)}&serial=${encodeURIComponent(s)}`, { method: 'POST' });
  if (res.ok) {
    serial.value = '';
    serial.focus();
  } else {
    alert('Save failed');
  }
});

window.addEventListener('load', () => {
  loadVariants();
  connectWS();
  serial.focus();
});