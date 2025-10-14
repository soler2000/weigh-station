const variantTbody = document.querySelector('#variants tbody');
let colourTbody = null;
let colourSummaryTbody = null;
let colourSummaryEmpty = null;

function ensureColourElements() {
  if (!colourTbody) {
    colourTbody = document.querySelector('#colours tbody');
  }
  if (!colourSummaryTbody) {
    colourSummaryTbody = document.querySelector('#colourChoices tbody');
  }
  if (!colourSummaryEmpty) {
    colourSummaryEmpty = document.getElementById('colourSummaryEmpty');
  }
}

async function loadVariantTable() {
  const vs = await (await fetch('/api/variants')).json();
  variantTbody.innerHTML = vs.map(v => variantRowHtml(v)).join('');
  bindVariantRowHandlers();
}

function variantRowHtml(v) {
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

function bindVariantRowHandlers() {
  variantTbody.querySelectorAll('.save').forEach(btn => btn.onclick = async (e) => {
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
  variantTbody.querySelectorAll('.del').forEach(btn => btn.onclick = async (e) => {
    const tr = e.target.closest('tr');
    const id = tr.dataset.id;
    if (!confirm('Delete this variant?')) return;
    const res = await fetch(`/api/variants/${id}`, { method: 'DELETE' });
    if (res.ok) tr.remove(); else alert('Delete failed');
  });
}

async function loadColourTable() {
  ensureColourElements();
  if (!colourTbody) return;
  try {
    const url = `/api/colours?ts=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      console.error('Failed to load colours', res.status);
      colourTbody.innerHTML = '';
      if (colourSummaryTbody) colourSummaryTbody.innerHTML = '';
      if (colourSummaryEmpty) colourSummaryEmpty.hidden = false;
      alert('Unable to load colours. Please refresh and try again.');
      return;
    }
    let rows = await res.json();
    if (rows && Array.isArray(rows.items)) rows = rows.items;
    const list = Array.isArray(rows) ? rows : [];
    colourTbody.innerHTML = list.map(r => colourRowHtml(r)).join('');
    bindColourRowHandlers();
    if (colourSummaryTbody) {
      colourSummaryTbody.innerHTML = list.map(r => colourSummaryRowHtml(r)).join('');
    }
    if (colourSummaryEmpty) {
      colourSummaryEmpty.hidden = list.length > 0;
    }
  } catch (err) {
    console.error('Error loading colours', err);
    colourTbody.innerHTML = '';
    if (colourSummaryTbody) colourSummaryTbody.innerHTML = '';
    if (colourSummaryEmpty) colourSummaryEmpty.hidden = false;
    alert('Unable to load colours. Please check the connection and retry.');
  }
}

function colourRowHtml(row) {
  return `<tr data-id="${row.id}">
    <td>${row.id}</td>
    <td><input class="name" value="${escapeHtml(row.name)}"></td>
    <td>
      <button class="save">Save</button>
      <button class="del">Delete</button>
    </td>
  </tr>`;
}

function colourSummaryRowHtml(row) {
  return `<tr><td>${escapeHtml(row.name)}</td></tr>`;
}

function bindColourRowHandlers() {
  ensureColourElements();
  if (!colourTbody) return;
  colourTbody.querySelectorAll('.save').forEach(btn => btn.onclick = async (e) => {
    const tr = e.target.closest('tr');
    const id = tr.dataset.id;
    const name = tr.querySelector('.name').value.trim();
    if (!name) { alert('Enter a colour name.'); return; }
    const res = await fetch(`/api/colours/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (res.ok) {
      await loadColourTable();
    } else {
      alert('Save failed');
    }
  });
  colourTbody.querySelectorAll('.del').forEach(btn => btn.onclick = async (e) => {
    const tr = e.target.closest('tr');
    const id = tr.dataset.id;
    if (!confirm('Delete this colour?')) return;
    const res = await fetch(`/api/colours/${id}`, { method: 'DELETE' });
    if (res.ok) {
      await loadColourTable();
    } else {
      alert('Delete failed');
    }
  });
}

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

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
    loadVariantTable();
  } else alert('Add failed');
};

document.getElementById('c-add').onclick = async () => {
  const name = document.getElementById('c-name').value.trim();
  if (!name) return alert('Enter a colour name');
  const res = await fetch('/api/colours', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (res.ok) {
    document.getElementById('c-name').value = '';
    await loadColourTable();
  } else if (res.status === 409) {
    alert('Colour already exists.');
  } else {
    alert('Add failed');
  }
};

document.getElementById('btn-del-events').onclick = async () => {
  const token = prompt('Type DELETE to remove ALL weigh logs');
  if (token !== 'DELETE') return;
  const res = await fetch('/api/admin/delete-events?confirm=DELETE', { method: 'POST' });
  alert(res.ok ? 'All weigh logs deleted.' : 'Delete failed.');
};

document.getElementById('btn-factory-reset').onclick = async () => {
  const token = prompt('Type RESET to factory reset (logs + variants). This cannot be undone.');
  if (token !== 'RESET') return;
  const res = await fetch('/api/admin/factory-reset?confirm=RESET', { method: 'POST' });
  if (res.ok) {
    alert('Factory reset complete. Variants reseeded.');
    loadVariantTable();
    loadColourTable();
  } else {
    alert('Factory reset failed.');
  }
};

window.addEventListener('load', () => {
  ensureColourElements();
  loadVariantTable();
  loadColourTable();
});
