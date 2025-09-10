const tbody = document.querySelector('#variants tbody');

async function loadTable() {
  const vs = await (await fetch('/api/variants')).json();
  tbody.innerHTML = vs.map(v => rowHtml(v)).join('');
  bindRowHandlers();
}

function rowHtml(v) {
  return `<tr data-id="${v.id}">
    <td>${v.id}</td>
    <td><input class="name" value="${escapeHtml(v.name)}"></td>
    <td><input class="min" type="number" step="0.1" value="${v.min_g}"></td>
    <td><input class="max" type="number" step="0.1" value="${v.max_g}"></td>
    <td>
      <button class="save">Save</button>
      <button class="del">Delete</button>
    </td>
  </tr>`;
}

function bindRowHandlers() {
  tbody.querySelectorAll('.save').forEach(btn => btn.onclick = async (e) => {
    const tr = e.target.closest('tr');
    const id = tr.dataset.id;
    const body = {
      name: tr.querySelector('.name').value,
      min_g: parseFloat(tr.querySelector('.min').value),
      max_g: parseFloat(tr.querySelector('.max').value),
      unit: "g",
      enabled: true
    };
    const res = await fetch(`/api/variants/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) alert('Save failed');
  });
  tbody.querySelectorAll('.del').forEach(btn => btn.onclick = async (e) => {
    const tr = e.target.closest('tr');
    const id = tr.dataset.id;
    if (!confirm('Delete this variant?')) return;
    const res = await fetch(`/api/variants/${id}`, { method: 'DELETE' });
    if (res.ok) tr.remove(); else alert('Delete failed');
  });
}

function escapeHtml(s){ return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

document.getElementById('v-add').onclick = async () => {
  const name = document.getElementById('v-name').value.trim();
  const min_g = parseFloat(document.getElementById('v-min').value);
  const max_g = parseFloat(document.getElementById('v-max').value);
  if (!name || isNaN(min_g) || isNaN(max_g)) return alert('Fill all fields');
  const res = await fetch('/api/variants', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, min_g, max_g, unit: 'g', enabled: true })
  });
  if (res.ok) {
    document.getElementById('v-name').value = '';
    document.getElementById('v-min').value = '';
    document.getElementById('v-max').value = '';
    loadTable();
  } else alert('Add failed');
};

document.getElementById('btn-tare').onclick = async () => {
  const res = await fetch('/api/calibrate/tare', { method:'POST' });
  document.getElementById('calib-msg').textContent = res.ok ? 'Tare saved.' : 'Tare failed.';
};
document.getElementById('btn-known').onclick = async () => {
  const k = parseFloat(document.getElementById('known').value);
  if (isNaN(k) || k<=0) return alert('Enter known mass in grams');
  const res = await fetch(`/api/calibrate/with-known?known_g=${encodeURIComponent(k)}`, { method:'POST' });
  document.getElementById('calib-msg').textContent = res.ok ? 'Scale factor saved.' : 'Calibration failed.';
};

window.addEventListener('load', loadTable);