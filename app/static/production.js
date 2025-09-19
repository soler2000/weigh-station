let variantSelect;
let intervalSelect;
let startInput;
let endInput;
let refreshBtn;
let passEl;
let failEl;
let totalEl;
let statusEl;
let canvas;
let emptyState;
let ctx;

let cachedChart = { labels: [], pass: [], fail: [], interval: 'day' };

function resizeCanvas(canvasEl, context) {
  if (!canvasEl || !context) return { width: 0, height: 0 };
  const cssWidth = canvasEl.clientWidth || 0;
  const cssHeight = canvasEl.clientHeight || 0;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

  if (canvasEl.width !== pixelWidth || canvasEl.height !== pixelHeight) {
    canvasEl.width = pixelWidth;
    canvasEl.height = pixelHeight;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvasEl.width, canvasEl.height);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: cssWidth, height: cssHeight };
}

function setStatus(message, ok = true) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.style.color = ok ? 'var(--app-fg-muted)' : '#f87171';
}

function setLoading(loading) {
  if (!refreshBtn) return;
  refreshBtn.disabled = loading;
  refreshBtn.textContent = loading ? 'Loading…' : 'Refresh';
}

function formatNum(value) {
  const num = Number(value) || 0;
  return num.toLocaleString();
}

async function loadVariants() {
  if (!variantSelect) return;
  const current = variantSelect.value || 'all';
  try {
    const res = await fetch('/api/variants', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load variants');
    const payload = await res.json();
    const variants = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.items)
        ? payload.items
        : [];
    const options = ['<option value="all">All Versions</option>'];
    for (const v of variants) {
      const id = v?.id ?? v?.value;
      const label = (v && (v.name || v.label || v.display)) ?? `Version ${id ?? ''}`;
      if (id == null) continue;
      options.push(`<option value="${id}">${label}</option>`);
    }
    variantSelect.innerHTML = options.join('');
    if (variants.some(v => String(v?.id ?? v?.value) === current)) {
      variantSelect.value = current;
    } else {
      variantSelect.value = 'all';
    }
    if (variants.length === 0) {
      setStatus('Showing all versions (none configured yet).');
    }
  } catch (err) {
    console.error(err);
    variantSelect.innerHTML = '<option value="all">All Versions</option>';
    variantSelect.value = 'all';
    setStatus('Failed to load versions.', false);
  }
}

function setDefaultRange() {
  if (!startInput || !endInput) return;
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(now.getTime() - 6 * 86400000);
  const start = startDate.toISOString().slice(0, 10);
  startInput.value = start;
  endInput.value = end;
}

function buildQuery() {
  if (!intervalSelect) return '';
  const params = new URLSearchParams();
  params.set('interval', intervalSelect.value);
  if (startInput?.value) params.set('start', startInput.value);
  if (endInput?.value) params.set('end', endInput.value);
  if (variantSelect?.value && variantSelect.value !== 'all') {
    params.set('variant_id', variantSelect.value);
  }
  return params.toString();
}

function drawChart(labels, passData, failData, interval, cache = true) {
  if (!canvas || !ctx) return;
  const { width, height } = resizeCanvas(canvas, ctx);
  if (!width || !height) {
    if (cache) {
      cachedChart = { labels: [], pass: [], fail: [], interval };
    }
    return;
  }

  if (!labels.length) {
    if (cache) {
      cachedChart = { labels: [], pass: [], fail: [], interval };
    }
    return;
  }

  const margin = {
    left: 64,
    right: 28,
    top: 24,
    bottom: interval === 'hour' ? 96 : 70,
  };
  const chartWidth = Math.max(1, width - margin.left - margin.right);
  const chartHeight = Math.max(1, height - margin.top - margin.bottom);
  const baseY = height - margin.bottom;
  const topY = margin.top;

  // axes
  ctx.strokeStyle = 'rgba(148,163,184,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, baseY);
  ctx.lineTo(width - margin.right, baseY);
  ctx.moveTo(margin.left, baseY);
  ctx.lineTo(margin.left, topY);
  ctx.stroke();

  const totals = labels.map((_, i) => (Number(passData[i]) || 0) + (Number(failData[i]) || 0));
  const maxTotal = totals.length ? Math.max(...totals, 1) : 1;
  const yTicks = 5;
  ctx.font = '12px "Inter", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i++) {
    const value = (maxTotal / yTicks) * i;
    const y = baseY - (value / maxTotal) * chartHeight;
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(width - margin.right, y);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(value).toString(), margin.left - 8, y);
  }

  const slot = labels.length ? chartWidth / labels.length : chartWidth;
  const gap = Math.min(8, slot * 0.25);
  const barWidth = Math.max(2, Math.min(64, slot - gap));
  const offset = (slot - barWidth) / 2;
  const rotateLabels = interval === 'hour' || labels.length > 10;

  for (let i = 0; i < labels.length; i++) {
    const passVal = Number(passData[i]) || 0;
    const failVal = Number(failData[i]) || 0;
    const x = margin.left + slot * i + offset;
    const scale = maxTotal ? chartHeight / maxTotal : 0;
    const minVisible = chartHeight > 0 ? Math.min(2, chartHeight) : 0;
    let passHeight = passVal * scale;
    let failHeight = failVal * scale;
    if (passVal > 0 && passHeight < minVisible) passHeight = minVisible;
    if (failVal > 0 && failHeight < minVisible) failHeight = minVisible;
    let combined = passHeight + failHeight;
    if (combined > chartHeight) {
      const ratio = chartHeight / combined;
      passHeight *= ratio;
      failHeight *= ratio;
      combined = chartHeight;
    }
    const passY = baseY - passHeight;
    const failY = passY - failHeight;

    ctx.fillStyle = 'rgba(34,197,94,0.85)';
    if (passHeight > 0) {
      ctx.fillRect(x, passY, barWidth, passHeight);
    }

    ctx.fillStyle = 'rgba(239,68,68,0.85)';
    if (failHeight > 0) {
      ctx.fillRect(x, failY, barWidth, failHeight);
    }

    ctx.save();
    const centerX = x + barWidth / 2;
    ctx.fillStyle = '#94a3b8';
    if (rotateLabels) {
      ctx.translate(centerX, height - margin.bottom + 16);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(labels[i], 0, 0);
    } else {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(labels[i], centerX, height - margin.bottom + 8);
    }
    ctx.restore();
  }

  if (cache) {
    cachedChart = {
      labels: labels.slice(),
      pass: passData.slice(),
      fail: failData.slice(),
      interval,
    };
  }
}

async function refresh() {
  if (!variantSelect || !intervalSelect || !startInput || !endInput || !passEl || !failEl || !totalEl || !emptyState) {
    console.error('Production Output page is missing required elements.');
    return;
  }
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
        const err = await res.json();
        if (err && err.detail) msg = err.detail;
      } catch {}
      throw new Error(msg);
    }

    const payload = await res.json();
    const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
    const labels = buckets.map(b => b.label);
    const passData = buckets.map(b => b.pass ?? 0);
    const failData = buckets.map(b => b.fail ?? 0);

    drawChart(labels, passData, failData, payload.interval || intervalSelect.value);

    const totals = payload.totals || {};
    const passTotal = totals.pass ?? 0;
    const failTotal = totals.fail ?? 0;
    const total = totals.total ?? passTotal + failTotal;
    passEl.textContent = formatNum(passTotal);
    failEl.textContent = formatNum(failTotal);
    totalEl.textContent = formatNum(total);

    const hasValues = buckets.some(b => (Number(b.pass) || 0) + (Number(b.fail) || 0));
    emptyState.hidden = hasValues;
    if (!hasValues) {
      emptyState.textContent = 'No production results for the selected filters.';
    }

    const variantName = payload.variant?.name;
    const intervalLabel = (payload.interval === 'hour') ? 'hour' : 'day';
    const plural = labels.length === 1 ? '' : 's';
    const rangeText = `${payload.start ?? startInput.value || '—'} → ${payload.end ?? endInput.value || '—'}`;
    const variantText = variantName ? ` • ${variantName}` : '';
    setStatus(`Showing ${labels.length} ${intervalLabel}${plural} (${rangeText})${variantText}.`);
  } catch (err) {
    console.error(err);
    drawChart([], [], [], intervalSelect.value);
    cachedChart = { labels: [], pass: [], fail: [], interval: intervalSelect.value };
    emptyState.hidden = false;
    emptyState.textContent = err.message || 'No production results for the selected filters.';
    passEl.textContent = '0';
    failEl.textContent = '0';
    totalEl.textContent = '0';
    setStatus(err.message || 'Failed to load production output.', false);
  } finally {
    setLoading(false);
  }
}

function handleResize() {
  if (!cachedChart.labels.length || !ctx) return;
  drawChart(cachedChart.labels, cachedChart.pass, cachedChart.fail, cachedChart.interval, false);
}

let initialized = false;
async function init() {
  if (initialized) return;
  variantSelect = document.getElementById('variant');
  intervalSelect = document.getElementById('interval');
  startInput = document.getElementById('start');
  endInput = document.getElementById('end');
  refreshBtn = document.getElementById('refresh');
  passEl = document.getElementById('passCount');
  failEl = document.getElementById('failCount');
  totalEl = document.getElementById('totalCount');
  statusEl = document.getElementById('status');
  canvas = document.getElementById('outputChart');
  emptyState = document.getElementById('emptyState');

  if (!variantSelect || !intervalSelect || !startInput || !endInput || !refreshBtn || !passEl || !failEl || !totalEl || !statusEl || !canvas || !emptyState) {
    console.error('Production Output page markup is missing required elements.');
    return;
  }

  ctx = canvas.getContext('2d');
  initialized = true;

  refreshBtn.addEventListener('click', refresh);
  variantSelect.addEventListener('change', refresh);
  intervalSelect.addEventListener('change', refresh);
  startInput.addEventListener('change', refresh);
  endInput.addEventListener('change', refresh);
  window.addEventListener('resize', handleResize);

  setDefaultRange();
  await loadVariants();
  await refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.error(err)); });
} else {
  init().catch(err => console.error(err));
}
