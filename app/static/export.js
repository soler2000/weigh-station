const form = document.getElementById('exportForm');
const variantSelect = document.getElementById('variant');
const operatorSelect = document.getElementById('operator');
const fromInput = document.getElementById('from');
const toInput = document.getElementById('to');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('resetBtn');
const showBtn = document.getElementById('showBtn');
const resultsSection = document.getElementById('resultsSection');
const resultsTableWrapper = document.getElementById('resultsTableWrapper');
const resultsBody = document.getElementById('resultsBody');
const resultsEmpty = document.getElementById('resultsEmpty');
const resultsSummary = document.getElementById('resultsSummary');

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.style.color = isError ? '#f87171' : 'var(--app-fg-muted)';
}

function appendOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

async function loadVariants() {
  if (!variantSelect) return;
  try {
    const res = await fetch('/api/variants', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load variants');
    const variants = await res.json();
    variantSelect.innerHTML = '';
    appendOption(variantSelect, '', 'All variants');
    for (const v of variants) {
      const name = v.name || `Variant ${v.id}`;
      const range = `${v.min_g} – ${v.max_g} ${v.unit || 'g'}`;
      appendOption(variantSelect, String(v.id), `${name} [${range}]`);
    }
  } catch (err) {
    console.error(err);
    setStatus('Unable to load variants.', true);
  }
}

async function loadOperators() {
  if (!operatorSelect) return;
  try {
    const res = await fetch('/api/operators', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load operators');
    const operators = await res.json();
    operatorSelect.innerHTML = '';
    appendOption(operatorSelect, '', 'All operators');
    for (const name of operators) {
      appendOption(operatorSelect, name, name);
    }
  } catch (err) {
    console.error(err);
    setStatus('Unable to load operators.', true);
  }
}

function buildQueryParams() {
  const params = new URLSearchParams();
  const variant = variantSelect?.value;
  if (variant) params.set('variant', variant);

  const operator = operatorSelect?.value;
  if (operator) params.set('operator', operator);

  const from = fromInput?.value;
  if (from) params.set('from', from);

  const to = toInput?.value;
  if (to) params.set('to', to);

  return params;
}

function buildUrl(basePath) {
  const params = buildQueryParams();
  const qs = params.toString();
  return basePath + (qs ? `?${qs}` : '');
}

function clearResults() {
  if (resultsBody) {
    resultsBody.innerHTML = '';
  }
  if (resultsSummary) {
    resultsSummary.textContent = '';
  }
  if (resultsEmpty) {
    resultsEmpty.hidden = true;
  }
  if (resultsTableWrapper) {
    resultsTableWrapper.hidden = true;
  }
  if (resultsSection) {
    resultsSection.hidden = true;
  }
}

function formatTimestamp(value) {
  if (!value) return '';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString();
}

function formatNetWeight(value) {
  if (typeof value !== 'number') return '';
  return value.toFixed(2);
}

function renderResults(payload) {
  if (!resultsSection || !resultsBody || !resultsSummary || !resultsEmpty || !resultsTableWrapper) {
    return;
  }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const hasMore = Boolean(payload?.has_more);
  resultsSection.hidden = false;
  resultsBody.innerHTML = '';

  if (items.length === 0) {
    resultsSummary.textContent = 'No records to display.';
    resultsTableWrapper.hidden = true;
    resultsEmpty.hidden = false;
    return;
  }

  resultsEmpty.hidden = true;
  resultsTableWrapper.hidden = false;
  const summaryParts = [`Showing ${items.length} record${items.length === 1 ? '' : 's'}.`];
  if (hasMore) {
    summaryParts.push('Refine your filters to see older records.');
  }
  resultsSummary.textContent = summaryParts.join(' ');

  for (const evt of items) {
    const row = document.createElement('tr');
    row.dataset.id = String(evt.id);

    const cells = [
      formatTimestamp(evt.ts),
      evt.variant_name ? `${evt.variant_name} (#${evt.variant_id})` : `Variant ${evt.variant_id}`,
      evt.serial || '—',
      evt.operator || '—',
      formatNetWeight(evt.net_g),
      evt.in_range ? 'Pass' : 'Fail',
    ];

    for (const text of cells) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.appendChild(cell);
    }

    const actionsCell = document.createElement('td');
    actionsCell.className = 'results-actions';
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger secondary btn-small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.setAttribute('aria-label', `Delete record ${evt.serial || evt.id}`);
    attachDeleteHandler(deleteBtn, evt.id);
    actionsCell.appendChild(deleteBtn);
    row.appendChild(actionsCell);

    resultsBody.appendChild(row);
  }
}

async function loadRecords() {
  const url = buildUrl('/api/export/events');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('Failed to load records');
  }
  const payload = await res.json();
  renderResults(payload);
  return payload;
}

function attachDeleteHandler(button, id) {
  button.addEventListener('click', async () => {
    if (!window.confirm('Delete this record? This action cannot be undone.')) {
      return;
    }
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Deleting…';
    try {
      const res = await fetch(`/api/export/events/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error('Failed to delete record');
      }
      await loadRecords();
      setStatus('Record deleted.');
    } catch (err) {
      console.error(err);
      setStatus('Unable to delete record.', true);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = buildUrl('/export.csv');
  setStatus('Preparing download…');
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => setStatus(''), 2000);
});

resetBtn?.addEventListener('click', () => {
  if (variantSelect) variantSelect.value = '';
  if (operatorSelect) operatorSelect.value = '';
  if (fromInput) fromInput.value = '';
  if (toInput) toInput.value = '';
  setStatus('Filters reset.');
  setTimeout(() => setStatus(''), 2000);
  clearResults();
});

showBtn?.addEventListener('click', async () => {
  if (!showBtn) return;
  const originalText = showBtn.textContent;
  showBtn.disabled = true;
  showBtn.textContent = 'Loading…';
  setStatus('Loading records…');
  try {
    const payload = await loadRecords();
    if (!payload || payload.count === 0) {
      setStatus('No records match the selected filters.');
    } else {
      let message = `Showing ${payload.count} record${payload.count === 1 ? '' : 's'}.`;
      if (payload.has_more) {
        message += ' Refine your filters to load additional results.';
      }
      setStatus(message);
    }
  } catch (err) {
    console.error(err);
    setStatus('Unable to load records.', true);
  } finally {
    showBtn.disabled = false;
    showBtn.textContent = originalText;
  }
});

window.addEventListener('load', () => {
  loadVariants();
  loadOperators();
});
