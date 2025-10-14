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
const resultsErrors = document.getElementById('resultsErrors');
const defaultEmptyMessage = (resultsEmpty && resultsEmpty.textContent)
  ? resultsEmpty.textContent
  : 'No records match the selected filters.';

function setStatus(message, isError) {
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
    for (let i = 0; i < variants.length; i += 1) {
      const v = variants[i];
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
    for (let i = 0; i < operators.length; i += 1) {
      const name = operators[i];
      appendOption(operatorSelect, name, name);
    }
  } catch (err) {
    console.error(err);
    setStatus('Unable to load operators.', true);
  }
}

function getFieldValue(element) {
  return element ? element.value : '';
}

function buildQueryParams() {
  const params = new URLSearchParams();
  const variant = getFieldValue(variantSelect);
  if (variant) params.set('variant', variant);

  const operator = getFieldValue(operatorSelect);
  if (operator) params.set('operator', operator);

  const from = getFieldValue(fromInput);
  if (from) params.set('from', from);

  const to = getFieldValue(toInput);
  if (to) params.set('to', to);

  return params;
}

function buildUrl(basePath) {
  const params = buildQueryParams();
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
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
    resultsEmpty.textContent = defaultEmptyMessage;
  }
  if (resultsTableWrapper) {
    resultsTableWrapper.hidden = true;
  }
  if (resultsErrors) {
    resultsErrors.hidden = true;
    resultsErrors.textContent = '';
  }
  if (resultsSection) {
    resultsSection.hidden = true;
  }
}

function focusResultsSection() {
  if (!resultsSection) return;
  requestAnimationFrame(() => {
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function showLoadingState() {
  if (!resultsSection) return;
  resultsSection.hidden = false;
  if (resultsSummary) {
    resultsSummary.textContent = 'Loading records…';
  }
  if (resultsErrors) {
    resultsErrors.hidden = true;
    resultsErrors.textContent = '';
  }
  if (resultsTableWrapper) {
    resultsTableWrapper.hidden = true;
  }
  if (resultsEmpty) {
    resultsEmpty.hidden = false;
    resultsEmpty.textContent = 'Loading…';
  }
  focusResultsSection();
}

function showErrorState(message) {
  if (!resultsSection) return;
  resultsSection.hidden = false;
  if (resultsSummary) {
    resultsSummary.textContent = '';
  }
  if (resultsTableWrapper) {
    resultsTableWrapper.hidden = true;
  }
  if (resultsEmpty) {
    resultsEmpty.hidden = false;
    resultsEmpty.textContent = 'Unable to load records.';
  }
  if (resultsErrors) {
    resultsErrors.textContent = message;
    resultsErrors.hidden = false;
  }
  focusResultsSection();
}

function formatTimestamp(value) {
  if (!value) return '';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString();
}

function formatNetWeight(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
    return numeric.toFixed(2);
  }
  return '';
}

function formatResult(evt) {
  if (!evt) return 'Unknown';
  const label = typeof evt.result_label === 'string' ? evt.result_label.trim() : '';
  if (label) return label;
  if (evt.in_range === true) return 'Pass';
  if (evt.in_range === false) return 'Fail';
  return 'Unknown';
}

function renderResults(payload) {
  if (!resultsSection || !resultsBody || !resultsSummary || !resultsEmpty || !resultsTableWrapper) {
    return;
  }
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  const hasMore = payload && Object.prototype.hasOwnProperty.call(payload, 'has_more')
    ? Boolean(payload.has_more)
    : false;
  const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];

  resultsSection.hidden = false;
  resultsEmpty.textContent = defaultEmptyMessage;
  resultsBody.innerHTML = '';

  if (items.length === 0) {
    const summary = errors.length
      ? 'No records could be displayed. Check the warnings below.'
      : 'No records to display.';
    resultsSummary.textContent = summary;
    resultsTableWrapper.hidden = true;
    resultsEmpty.hidden = false;
    if (resultsErrors) {
      if (errors.length) {
        const first = errors[0];
        const extra = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
        resultsErrors.textContent = `Warnings: ${first}${extra}`;
        resultsErrors.hidden = false;
        console.warn('Export preview warnings:', errors);
      } else {
        resultsErrors.hidden = true;
        resultsErrors.textContent = '';
      }
    }
    focusResultsSection();
    return;
  }

  resultsEmpty.hidden = true;
  resultsTableWrapper.hidden = false;
  const summaryParts = [`Showing ${items.length} record${items.length === 1 ? '' : 's'}.`];
  if (hasMore) {
    summaryParts.push('Refine your filters to see older records.');
  }
  if (errors.length) {
    summaryParts.push(`${errors.length} warning${errors.length === 1 ? '' : 's'} detected.`);
  }
  resultsSummary.textContent = summaryParts.join(' ');

  if (resultsErrors) {
    if (errors.length) {
      const first = errors[0];
      const extra = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
      resultsErrors.textContent = `Warnings: ${first}${extra}`;
      resultsErrors.hidden = false;
      console.warn('Export preview warnings:', errors);
    } else {
      resultsErrors.hidden = true;
      resultsErrors.textContent = '';
    }
  }

  for (let i = 0; i < items.length; i += 1) {
    const evt = items[i];
    const row = document.createElement('tr');
    row.dataset.id = String(evt.id);

    const variantLabel = (() => {
      const hasVariantId = evt.variant_id !== null && evt.variant_id !== undefined;
      if (evt.variant_name && hasVariantId) {
        return `${evt.variant_name} (#${evt.variant_id})`;
      }
      if (evt.variant_name) {
        return evt.variant_name;
      }
      if (hasVariantId) {
        return `Variant ${evt.variant_id}`;
      }
      return 'Unknown variant';
    })();

    const cells = [
      formatTimestamp(evt.ts),
      variantLabel,
      evt.serial || '—',
      evt.operator || '—',
      formatNetWeight(evt.net_g),
      formatResult(evt),
    ];

    for (let j = 0; j < cells.length; j += 1) {
      const cell = document.createElement('td');
      cell.textContent = cells[j];
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
  focusResultsSection();
}

async function loadRecords() {
  const url = buildUrl('/api/export/events');
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (err) {
      console.error('Failed to parse export preview response.', err, text);
      throw new Error('Received an invalid response from the server.');
    }
  }

  if (!res.ok) {
    let detail = '';
    if (payload && typeof payload === 'object') {
      if (Object.prototype.hasOwnProperty.call(payload, 'detail') && payload.detail) {
        if (Array.isArray(payload.detail)) {
          detail = payload.detail.map((entry) => {
            if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'msg')) {
              return entry.msg || '';
            }
            return String(entry);
          }).join('; ');
        } else {
          detail = String(payload.detail);
        }
      } else if (Array.isArray(payload.errors) && payload.errors.length) {
        detail = payload.errors.join('; ');
      }
    }
    if (!detail && text) {
      detail = text.trim().slice(0, 200);
    }
    const message = detail ? `Failed to load records: ${detail}` : `Failed to load records (HTTP ${res.status})`;
    throw new Error(message);
  }

  const safePayload = (payload && typeof payload === 'object')
    ? payload
    : { items: [], count: 0, has_more: false, errors: [] };
  renderResults(safePayload);
  return safePayload;
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

if (form) {
  form.addEventListener('submit', (event) => {
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
}

if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    if (variantSelect) variantSelect.value = '';
    if (operatorSelect) operatorSelect.value = '';
    if (fromInput) fromInput.value = '';
    if (toInput) toInput.value = '';
    setStatus('Filters reset.');
    setTimeout(() => setStatus(''), 2000);
    clearResults();
  });
}

if (showBtn) {
  showBtn.addEventListener('click', async () => {
    const originalText = showBtn.textContent;
    showBtn.disabled = true;
    showBtn.textContent = 'Loading…';
    setStatus('Loading records…');
    showLoadingState();
    try {
      const payload = await loadRecords();
      const hasErrors = payload && Array.isArray(payload.errors) && payload.errors.length > 0;
      if (!payload || payload.count === 0) {
        const warning = hasErrors
          ? 'No records matched the filters, but warnings were reported. Review the console for details.'
          : 'No records match the selected filters.';
        setStatus(warning, hasErrors);
      } else {
        let message = `Showing ${payload.count} record${payload.count === 1 ? '' : 's'}.`;
        if (payload.has_more) {
          message += ' Refine your filters to load additional results.';
        }
        if (hasErrors) {
          message += ` ${payload.errors.length} warning${payload.errors.length === 1 ? '' : 's'} logged.`;
          setStatus(message, true);
          console.warn('Export preview warnings:', payload.errors);
        } else {
          setStatus(message);
        }
      }
    } catch (err) {
      console.error(err);
      const message = (err instanceof Error && err.message) ? err.message : 'Unable to load records.';
      setStatus(message, true);
      showErrorState(message);
    } finally {
      showBtn.disabled = false;
      showBtn.textContent = originalText;
    }
  });
}

window.addEventListener('load', () => {
  loadVariants();
  loadOperators();
});
