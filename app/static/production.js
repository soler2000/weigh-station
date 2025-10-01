let variantSelect;
let intervalSelect;
let startInput;
let endInput;
let refreshBtn;
let totalEl;
let passEl;
let failEl;
let passRateEl;
let passRateSubEl;
let statusEl;
let bucketRows;
let bucketEmpty;
let bucketSummary;
let eventRows;
let eventsEmpty;
let eventsSummary;
let eventsNotice;

function setStatus(message, ok = true) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.style.color = ok ? 'var(--app-fg-muted)' : '#f87171';
}

function setLoading(isLoading) {
  if (!refreshBtn) return;
  refreshBtn.disabled = isLoading;
  refreshBtn.textContent = isLoading ? 'Loading…' : 'Refresh';
}

function formatNumber(value) {
  const num = Number(value) || 0;
  return num.toLocaleString();
}

function formatPercent(rate) {
  if (rate === null || rate === undefined || Number.isNaN(rate)) {
    return '—';
  }
  return `${(rate * 100).toFixed(1)}%`;
}

function todayIsoLocal() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function setDefaultRange() {
  const today = todayIsoLocal();
  if (startInput && !startInput.value) startInput.value = today;
  if (endInput && !endInput.value) endInput.value = today;
}

async function fetchVariants() {
  const endpoints = ['/api/production/variants', '/api/variants'];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Request failed: ${url}`);
      const payload = await res.json();
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.items)) return payload.items;
    } catch (err) {
      console.warn('Variant fetch failed', url, err);
    }
  }
  return [];
}

async function loadVariants() {
  if (!variantSelect) return;
  const current = variantSelect.value || 'all';
  try {
    const variants = await fetchVariants();
    const options = ['<option value="all">All Variants</option>'];
    for (const item of variants) {
      const id = item?.id ?? item?.value;
      if (id == null) continue;
      const label = (item?.name || item?.label || item?.display || `Variant ${id}`).toString();
      options.push(`<option value="${id}">${label}</option>`);
    }
    variantSelect.innerHTML = options.join('');
    if (variants.some(v => String(v?.id ?? v?.value) === current)) {
      variantSelect.value = current;
    } else {
      variantSelect.value = 'all';
    }
  } catch (err) {
    console.error(err);
    variantSelect.innerHTML = '<option value="all">All Variants</option>';
    variantSelect.value = 'all';
    setStatus('Failed to load variants.', false);
  }
}

function buildQuery() {
  const params = new URLSearchParams();
  if (intervalSelect) params.set('interval', intervalSelect.value);
  if (startInput?.value) params.set('start', startInput.value);
  if (endInput?.value) params.set('end', endInput.value);
  if (variantSelect?.value && variantSelect.value !== 'all') {
    params.set('variant_id', variantSelect.value);
  }
  return params.toString();
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderBuckets(buckets) {
  if (!bucketRows || !bucketEmpty || !bucketSummary) return;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    bucketRows.innerHTML = '';
    bucketEmpty.hidden = false;
    bucketSummary.textContent = '';
    return;
  }

  const rows = buckets.map(bucket => {
    const passRate = formatPercent(bucket.pass_rate);
    return `
      <tr>
        <td>${escapeHtml(bucket.label)}</td>
        <td>${formatNumber(bucket.total)}</td>
        <td>${formatNumber(bucket.pass)}</td>
        <td>${formatNumber(bucket.fail)}</td>
        <td>${passRate}</td>
      </tr>
    `;
  });

  bucketRows.innerHTML = rows.join('');
  bucketEmpty.hidden = true;
}

function renderEvents(events, truncated, limit) {
  if (!eventRows || !eventsEmpty || !eventsSummary || !eventsNotice) return;
  if (!Array.isArray(events) || events.length === 0) {
    eventRows.innerHTML = '';
    eventsEmpty.hidden = false;
    eventsSummary.textContent = '';
    eventsNotice.textContent = '';
    return;
  }

  const rows = events.map(evt => {
    const status = evt.status === 'pass' ? 'Pass' : evt.status === 'fail' ? 'Fail' : '—';
    const weight = evt.net_g === null || evt.net_g === undefined ? '—' : Number(evt.net_g).toFixed(2);
    return `
      <tr>
        <td>${escapeHtml(evt.ts)}</td>
        <td>${escapeHtml(evt.variant ?? '—')}</td>
        <td>${escapeHtml(evt.serial ?? '—')}</td>
        <td>${escapeHtml(evt.moulding_serial ?? '—')}</td>
        <td>${escapeHtml(evt.contract ?? '—')}</td>
        <td>${escapeHtml(evt.order_number ?? '—')}</td>
        <td>${escapeHtml(evt.operator ?? '—')}</td>
        <td>${escapeHtml(evt.colour ?? '—')}</td>
        <td>${status}</td>
        <td>${weight}</td>
      </tr>
    `;
  });

  eventRows.innerHTML = rows.join('');
  eventsEmpty.hidden = true;
  eventsSummary.textContent = `Showing ${events.length} event${events.length === 1 ? '' : 's'}.`;
  if (truncated) {
    eventsNotice.textContent = `Showing the first ${events.length} events (limit ${limit}). Narrow the date range to see additional history.`;
  } else {
    eventsNotice.textContent = '';
  }
}

async function refresh() {
  if (!startInput || !endInput) return;
  if (startInput.value && endInput.value && startInput.value > endInput.value) {
    setStatus('From date must be on or before the To date.', false);
    return;
  }

  setLoading(true);
  setStatus('Loading…');

  try {
    const query = buildQuery();
    const res = await fetch(`/api/production/output?${query}`, { cache: 'no-store' });
    if (!res.ok) {
      let msg = 'Failed to load production output.';
      try {
        const payload = await res.json();
        if (payload?.detail) msg = payload.detail;
      } catch (_) {}
      throw new Error(msg);
    }

    const payload = await res.json();
    const totals = payload.totals || {};

    if (startInput && payload.start) startInput.value = payload.start;
    if (endInput && payload.end) endInput.value = payload.end;

    totalEl.textContent = formatNumber(totals.total ?? 0);
    passEl.textContent = formatNumber(totals.pass ?? 0);
    failEl.textContent = formatNumber(totals.fail ?? 0);

    const passRate = totals.pass_rate ?? null;
    passRateEl.textContent = formatPercent(passRate);
    if (passRate !== null && passRate !== undefined && !Number.isNaN(passRate)) {
      const totalCount = totals.total ?? 0;
      passRateSubEl.textContent = `Based on ${formatNumber(totalCount)} result${totalCount === 1 ? '' : 's'}.`;
    } else {
      passRateSubEl.textContent = '';
    }

    renderBuckets(payload.buckets || []);
    if (bucketSummary) {
      const count = Array.isArray(payload.buckets) ? payload.buckets.length : 0;
      bucketSummary.textContent = count ? `${count} bucket${count === 1 ? '' : 's'} returned.` : '';
    }

    renderEvents(payload.events || [], payload.events_truncated, payload.events_limit);

    const labelsCount = Array.isArray(payload.buckets) ? payload.buckets.length : 0;
    const intervalLabel = payload.interval === 'hour' ? 'hour' : 'day';
    const variantName = payload.variant?.name || (variantSelect?.value && variantSelect.value !== 'all' ? `Variant ${variantSelect.value}` : 'All variants');
    const rangeText = `${payload.start ?? startInput.value || '—'} → ${payload.end ?? endInput.value || '—'}`;
    setStatus(`Showing ${labelsCount} ${intervalLabel}${labelsCount === 1 ? '' : 's'} for ${variantName} (${rangeText}).`);
  } catch (err) {
    console.error(err);
    totalEl.textContent = '0';
    passEl.textContent = '0';
    failEl.textContent = '0';
    passRateEl.textContent = '—';
    passRateSubEl.textContent = '';
    renderBuckets([]);
    renderEvents([], false, 0);
    setStatus(err.message || 'Failed to load production output.', false);
  } finally {
    setLoading(false);
  }
}

async function init() {
  variantSelect = document.getElementById('variant');
  intervalSelect = document.getElementById('interval');
  startInput = document.getElementById('start');
  endInput = document.getElementById('end');
  refreshBtn = document.getElementById('refresh');
  totalEl = document.getElementById('totalCount');
  passEl = document.getElementById('passCount');
  failEl = document.getElementById('failCount');
  passRateEl = document.getElementById('passRate');
  passRateSubEl = document.getElementById('passRateSub');
  statusEl = document.getElementById('status');
  bucketRows = document.getElementById('bucketRows');
  bucketEmpty = document.getElementById('bucketEmpty');
  bucketSummary = document.getElementById('bucketSummary');
  eventRows = document.getElementById('eventRows');
  eventsEmpty = document.getElementById('eventsEmpty');
  eventsSummary = document.getElementById('eventsSummary');
  eventsNotice = document.getElementById('eventsNotice');

  if (!variantSelect || !intervalSelect || !startInput || !endInput || !refreshBtn || !totalEl || !passEl || !failEl || !passRateEl || !statusEl) {
    console.error('Production Output page markup is missing required elements.');
    return;
  }

  refreshBtn.addEventListener('click', refresh);
  variantSelect.addEventListener('change', refresh);
  intervalSelect.addEventListener('change', refresh);
  startInput.addEventListener('change', refresh);
  endInput.addEventListener('change', refresh);

  setDefaultRange();
  await loadVariants();
  await refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.error(err)); });
} else {
  init().catch(err => console.error(err));
}
