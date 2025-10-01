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
let chartCanvas;
let chartEmpty;
let chartSummary;

let currentChartBuckets = [];
let currentChartInterval = 'day';

const tzOffsetMinutes = new Date().getTimezoneOffset();

function setStatus(message, ok) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.style.color = ok === false ? '#f87171' : 'var(--app-fg-muted)';
}

function setLoading(isLoading) {
  if (!refreshBtn) return;
  refreshBtn.disabled = !!isLoading;
  refreshBtn.textContent = isLoading ? 'Loading…' : 'Refresh';
}

function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '0';
  }
  return num.toLocaleString();
}

function formatPercent(rate) {
  if (rate === null || rate === undefined) {
    return '—';
  }
  const num = Number(rate);
  if (!Number.isFinite(num)) {
    return '—';
  }
  return `${(num * 100).toFixed(1)}%`;
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

function normalizeVariant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let id = raw.id;
  if (id === undefined || id === null) {
    id = raw.value;
  }
  if (id === undefined || id === null) {
    return null;
  }
  let label = raw.name;
  if (label === undefined || label === null || String(label).trim() === '') {
    if (raw.label !== undefined && raw.label !== null && String(raw.label).trim() !== '') {
      label = raw.label;
    } else if (raw.display !== undefined && raw.display !== null && String(raw.display).trim() !== '') {
      label = raw.display;
    } else {
      label = `Variant ${id}`;
    }
  }
  return { id: String(id), label: String(label) };
}

function applyVariantOptions(list, preserveSelection) {
  if (!variantSelect) return;
  const current = preserveSelection && variantSelect.value ? variantSelect.value : 'all';
  const options = ['<option value="all">All Variants</option>'];
  let hasMatch = current === 'all';

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    options.push(`<option value="${item.id}">${item.label}</option>`);
    if (item.id === current) {
      hasMatch = true;
    }
  }

  variantSelect.innerHTML = options.join('');
  variantSelect.value = hasMatch ? current : 'all';
}

async function fetchVariants() {
  const endpoints = ['/api/production/variants', '/api/variants'];
  for (let i = 0; i < endpoints.length; i += 1) {
    const url = endpoints[i];
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const payload = await res.json();
      let list = [];
      if (Array.isArray(payload)) {
        list = payload;
      } else if (payload && Array.isArray(payload.items)) {
        list = payload.items;
      }
      const normalized = [];
      for (let j = 0; j < list.length; j += 1) {
        const normalizedItem = normalizeVariant(list[j]);
        if (normalizedItem) normalized.push(normalizedItem);
      }
      return normalized;
    } catch (err) {
      console.warn('Variant fetch failed', url, err);
    }
  }
  return [];
}

async function loadVariants() {
  if (!variantSelect) return;
  try {
    const variants = await fetchVariants();
    applyVariantOptions(variants, true);
    if (variants.length === 0) {
      setStatus('No variants found. Configure variants in Settings.', false);
    }
  } catch (err) {
    console.error(err);
    applyVariantOptions([], false);
    setStatus('Failed to load variants.', false);
  }
}

function buildQuery() {
  const params = new URLSearchParams();
  if (intervalSelect) params.set('interval', intervalSelect.value);
  if (startInput && startInput.value) params.set('start', startInput.value);
  if (endInput && endInput.value) params.set('end', endInput.value);
  if (variantSelect && variantSelect.value && variantSelect.value !== 'all') {
    params.set('variant_id', variantSelect.value);
  }
  params.set('tz_offset', String(tzOffsetMinutes));
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

  const rows = [];
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    rows.push(
      '<tr>' +
        `<td>${escapeHtml(bucket.label)}</td>` +
        `<td>${formatNumber(bucket.total)}</td>` +
        `<td>${formatNumber(bucket.pass)}</td>` +
        `<td>${formatNumber(bucket.fail)}</td>` +
        `<td>${formatPercent(bucket.pass_rate)}</td>` +
      '</tr>'
    );
  }

  bucketRows.innerHTML = rows.join('');
  bucketEmpty.hidden = true;
  bucketSummary.textContent = `${buckets.length} bucket${buckets.length === 1 ? '' : 's'} returned.`;
}

function niceCeiling(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(numeric));
  const base = Math.pow(10, exponent);
  const normalized = numeric / base;
  let nice;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function renderOutputChart(buckets, interval) {
  if (!chartCanvas || !chartEmpty || !chartSummary) return;

  const ctx = chartCanvas.getContext('2d');
  const rect = chartCanvas.getBoundingClientRect();
  const width = rect.width || chartCanvas.clientWidth || 640;
  const height = rect.height || chartCanvas.clientHeight || 320;
  const dpr = window.devicePixelRatio || 1;

  chartCanvas.width = width * dpr;
  chartCanvas.height = height * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const hasRows = Array.isArray(buckets) && buckets.length > 0 && buckets.some((b) => Number(b.total) > 0);
  if (!hasRows) {
    chartEmpty.hidden = false;
    chartSummary.textContent = 'No production totals available for the selected filters.';
    return;
  }

  chartEmpty.hidden = true;
  const intervalLabel = interval === 'hour' ? 'hourly' : 'daily';
  chartSummary.textContent = `Stacked ${intervalLabel} totals for ${buckets.length} bucket${buckets.length === 1 ? '' : 's'}.`;

  const paddingTop = 16;
  const paddingRight = 24;
  const paddingBottom = 56;
  const paddingLeft = 56;
  const plotWidth = Math.max(0, width - paddingLeft - paddingRight);
  const plotHeight = Math.max(0, height - paddingTop - paddingBottom);

  const totals = buckets.map((b) => Number(b.total) || 0);
  const passes = buckets.map((b) => Number(b.pass) || 0);
  const fails = buckets.map((b) => Number(b.fail) || 0);
  const maxTotal = Math.max(...totals, 0);
  const scaleMax = niceCeiling(maxTotal);
  const yRatio = scaleMax > 0 ? plotHeight / scaleMax : 0;

  const tickCount = 5;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px "Inter", "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= tickCount; i += 1) {
    const value = (scaleMax / tickCount) * i;
    const y = height - paddingBottom - value * yRatio;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(width - paddingRight, y);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    ctx.fillText(formatNumber(value), paddingLeft - 8, y);
  }

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.beginPath();
  ctx.moveTo(paddingLeft, height - paddingBottom);
  ctx.lineTo(width - paddingRight, height - paddingBottom);
  ctx.stroke();

  const count = buckets.length;
  const step = count > 0 ? plotWidth / count : plotWidth;
  const barWidth = Math.max(18, Math.min(52, step * 0.6));

  ctx.textBaseline = 'middle';

  for (let i = 0; i < count; i += 1) {
    const x = paddingLeft + step * i + (step - barWidth) / 2;
    const total = totals[i];
    const passValue = passes[i];
    const failValue = fails[i];
    const passHeight = passValue * yRatio;
    const failHeight = failValue * yRatio;
    const barBottom = height - paddingBottom;

    ctx.fillStyle = '#22c55e';
    ctx.fillRect(x, barBottom - passHeight, barWidth, passHeight);

    if (failValue > 0) {
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(x, barBottom - passHeight - failHeight, barWidth, failHeight);
    }

    if (total > 0) {
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.font = '12px "Inter", "Segoe UI", sans-serif';
      const textY = Math.max(12, barBottom - (passHeight + failHeight) - 10);
      ctx.fillText(formatNumber(total), x + barWidth / 2, textY);
    }

    let label = String(buckets[i].label || '');
    if (label.length > 20) {
      label = `${label.slice(0, 20)}…`;
    }
    ctx.save();
    ctx.translate(x + barWidth / 2, barBottom + 18);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = '#cbd5f5';
    ctx.textAlign = 'right';
    ctx.font = '12px "Inter", "Segoe UI", sans-serif';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
}

function describeVariant(payloadVariant) {
  if (payloadVariant && payloadVariant.name) {
    return payloadVariant.name;
  }
  if (variantSelect && variantSelect.value && variantSelect.value !== 'all') {
    return `Variant ${variantSelect.value}`;
  }
  return 'All variants';
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
        const problem = await res.json();
        if (problem && problem.detail) msg = problem.detail;
      } catch (err) {
        // ignore JSON parse errors
      }
      throw new Error(msg);
    }

    const payload = await res.json();

    if (Array.isArray(payload.variants) && payload.variants.length) {
      const normalized = [];
      for (let i = 0; i < payload.variants.length; i += 1) {
        const normalizedItem = normalizeVariant(payload.variants[i]);
        if (normalizedItem) normalized.push(normalizedItem);
      }
      if (normalized.length) {
        applyVariantOptions(normalized, true);
      }
    }

    if (startInput && payload.start) startInput.value = payload.start;
    if (endInput && payload.end) endInput.value = payload.end;

    const totals = payload.totals || {};
    totalEl.textContent = formatNumber(totals.total);
    passEl.textContent = formatNumber(totals.pass);
    failEl.textContent = formatNumber(totals.fail);

    const passRate = totals.pass_rate;
    passRateEl.textContent = formatPercent(passRate);
    if (passRate !== null && passRate !== undefined && Number.isFinite(Number(passRate))) {
      const totalCount = Number(totals.total);
      const numericCount = Number.isFinite(totalCount) ? totalCount : 0;
      const labelCount = formatNumber(numericCount);
      passRateSubEl.textContent = `Based on ${labelCount} result${numericCount === 1 ? '' : 's'}.`;
    } else {
      passRateSubEl.textContent = '';
    }

    const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
    renderBuckets(buckets);

    currentChartBuckets = buckets;
    currentChartInterval = payload.interval === 'hour' ? 'hour' : 'day';
    renderOutputChart(currentChartBuckets, currentChartInterval);

    const variantName = describeVariant(payload.variant);
    const rangeStart = payload.start || (startInput ? startInput.value : '—');
    const rangeEnd = payload.end || (endInput ? endInput.value : '—');
    const intervalLabel = payload.interval === 'hour' ? 'hour' : 'day';
    const bucketCount = buckets.length;
    const queryCount = Number(payload.query_count);
    let suffix = '';
    if (Number.isFinite(queryCount)) {
      suffix = ` Queried ${formatNumber(queryCount)} event${queryCount === 1 ? '' : 's'}.`;
    }
    setStatus(`Showing ${bucketCount} ${intervalLabel}${bucketCount === 1 ? '' : 's'} for ${variantName} (${rangeStart} → ${rangeEnd}).${suffix}`);
  } catch (err) {
    console.error(err);
    totalEl.textContent = '0';
    passEl.textContent = '0';
    failEl.textContent = '0';
    passRateEl.textContent = '—';
    passRateSubEl.textContent = '';
    renderBuckets([]);
    currentChartBuckets = [];
    renderOutputChart([], currentChartInterval);
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
  chartCanvas = document.getElementById('outputChart');
  chartEmpty = document.getElementById('chartEmpty');
  chartSummary = document.getElementById('chartSummary');

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

  window.addEventListener('resize', function () {
    renderOutputChart(currentChartBuckets, currentChartInterval);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    init().catch(function (err) { console.error(err); });
  });
} else {
  init().catch(function (err) { console.error(err); });
}
