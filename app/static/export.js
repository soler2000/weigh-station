const form = document.getElementById('exportForm');
const variantSelect = document.getElementById('variant');
const operatorSelect = document.getElementById('operator');
const fromInput = document.getElementById('from');
const toInput = document.getElementById('to');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('resetBtn');

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

function buildUrl() {
  const params = new URLSearchParams();
  const variant = variantSelect?.value;
  if (variant) params.set('variant', variant);

  const operator = operatorSelect?.value;
  if (operator) params.set('operator', operator);

  const from = fromInput?.value;
  if (from) params.set('from', from);

  const to = toInput?.value;
  if (to) params.set('to', to);

  const qs = params.toString();
  return '/export.csv' + (qs ? `?${qs}` : '');
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = buildUrl();
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
});

window.addEventListener('load', () => {
  loadVariants();
  loadOperators();
});
