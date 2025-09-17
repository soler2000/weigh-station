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
let lastVariants = [];
let bootstrapData = null;

const DAY_MS = 86400000;
const DEFAULT_DAY_WINDOW = 30;

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

function showEmptyState(message = '') {
  if (!emptyState) return;
  emptyState.hidden = false;
  emptyState.style.display = 'flex';
  emptyState.textContent = message;
}

function hideEmptyState() {
  if (!emptyState) return;
  emptyState.hidden = true;
  emptyState.style.display = 'none';
  emptyState.textContent = '';
}

function formatNum(value) {
  const num = Number(value) || 0;
  return num.toLocaleString();
}

function formatDateInput(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateInput(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatVariantRangeValue(value) {
  const num = Number(value);
  if (Number.isFinite(num)) {
    return num % 1 === 0 ? String(num.toFixed(0)) : String(num);
  }
  return String(value ?? '');
}

function extractVariantArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.variants)) return payload.variants;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.results)) return payload.results;
  return [];
}

function normalizeVariantEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const idCandidate =
    entry.id ?? entry.value ?? entry.variant_id ?? entry.variantId ?? entry.uuid ?? entry.key;
  if (idCandidate == null) return null;
  const id = String(idCandidate);
  const nameCandidate =
    entry.name ?? entry.display ?? entry.title ?? entry.variant ?? entry.label ?? `Version ${id}`;
  const name = String(nameCandidate);
  const min = entry.min_g ?? entry.min ?? entry.lsl ?? entry.lower ?? entry.start ?? null;
  const max = entry.max_g ?? entry.max ?? entry.usl ?? entry.upper ?? entry.end ?? null;
  const unit = entry.unit ?? entry.units ?? entry.measure ?? 'g';
  const providedLabel = entry.label != null ? String(entry.label) : null;
  let label = providedLabel ?? name;
  if (providedLabel == null && min != null && max != null) {
    const minLabel = formatVariantRangeValue(min);
    const maxLabel = formatVariantRangeValue(max);
    label += ` [${minLabel}-${maxLabel} ${unit}]`;
  }
  return { id, label, name };
}

function applyVariantOptions(payload, currentValue = 'all') {
  if (!variantSelect) return 0;
  const source = extractVariantArray(payload);
  const seen = new Set();
  const sanitized = [];
  for (const entry of source) {
    const normalized = normalizeVariantEntry(entry);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    sanitized.push(normalized);
  }

  const desired = currentValue ? String(currentValue) : 'all';
  const options = ['<option value="all">All Versions</option>'];
  let keepSelection = desired === 'all';
  for (const variant of sanitized) {
    options.push(`<option value="${variant.id}">${variant.label}</option>`);
    if (variant.id === desired) {
      keepSelection = true;
    }
  }

  variantSelect.innerHTML = options.join('');
  variantSelect.value = keepSelection ? desired : 'all';
  lastVariants = sanitized;
  return sanitized.length;
}

function bootstrapVariants() {
  if (!variantSelect) return null;
  const node = document.getElementById('production-variant-data');
  if (!node) return null;
  try {
    const text = node.textContent || node.innerText || 'null';
    const parsed = JSON.parse(text || 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      bootstrapData = parsed;
    } else if (Array.isArray(parsed)) {
      bootstrapData = { variants: parsed };
    } else {
      bootstrapData = null;
    }
    const count = applyVariantOptions(parsed, variantSelect.value || 'all');
    if (bootstrapData) {
      bootstrapData.variants = lastVariants.slice();
    }
    if (count === 0) {
      setStatus('Showing all versions (none configured yet).');
    }
    return bootstrapData;
  } catch (err) {
    console.error('Failed to parse initial variants', err);
    bootstrapData = null;
    return null;
  } finally {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
  }
}

async function loadVariants() {
  if (!variantSelect) return;
  const current = variantSelect.value || 'all';
  try {
    const res = await fetch('/api/variants', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load variants');
    const payload = await res.json();
    const count = applyVariantOptions(payload, current);
    if (!bootstrapData) bootstrapData = {};
    bootstrapData.variants = lastVariants.slice();
    if (count === 0) {
      setStatus('Showing all versions (none configured yet).');
    }
  } catch (err) {
    console.error(err);
    if (!lastVariants.length) {
      applyVariantOptions([], 'all');
    }
    setStatus('Failed to load versions.', false);
  }
}

function updateRangeBounds(range) {
  if (!startInput || !endInput) return;
  if (!range) {
    startInput.removeAttribute('min');
    startInput.removeAttribute('max');
    endInput.removeAttribute('min');
    endInput.removeAttribute('max');
    return;
  }
  if (range.start) {
    startInput.min = range.start;
    endInput.min = range.start;
  }
  if (range.end) {
    startInput.max = range.end;
    endInput.max = range.end;
  }
}

function setDefaultRange(range) {
  if (!startInput || !endInput) return;
  if (range && range.start && range.end) {
    updateRangeBounds(range);
    const startDate = parseDateInput(range.start);
    const endDate = parseDateInput(range.end);
    if (startDate && endDate) {
      const defaultEnd = endDate;
      let defaultStart;
      if (DEFAULT_DAY_WINDOW <= 1) {
        defaultStart = defaultEnd;
      } else {
        defaultStart = new Date(defaultEnd.getTime() - (DEFAULT_DAY_WINDOW - 1) * DAY_MS);
      }
      const minStart = startDate;
      if (defaultStart < minStart) {
        defaultStart = minStart;
      }
      startInput.value = formatDateInput(defaultStart);
      endInput.value = formatDateInput(defaultEnd);
      return;
    }
  }
  updateRangeBounds(null);
  const now = new Date();
  const endDate = formatDateInput(now);
  const startDate = formatDateInput(new Date(now.getTime() - 6 * DAY_MS));
  startInput.value = startDate;
  endInput.value = endDate;
}

function maybeAutoAdjustRange(range, hasValues) {
  if (!startInput || !endInput) return false;
  if (hasValues || !range || !range.start || !range.end) return false;
  const reqStart = startInput.value;
  const reqEnd = endInput.value;
  if (!reqStart || !reqEnd) return false;
  if (reqEnd < range.start || reqStart > range.end) {
    startInput.value = range.start;
    endInput.value = range.end;
    return true;
  }
  return false;
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
  const width = canvas.clientWidth || 960;
  const height = canvas.clientHeight || 420;
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);

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

async function refresh(options = {}) {
  const allowAutoAdjust = Object.prototype.hasOwnProperty.call(options, 'allowAutoAdjust')
    ? Boolean(options.allowAutoAdjust)
    : true;

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

    if (payload && typeof payload === 'object') {
      if (payload.variants !== undefined) {
        applyVariantOptions(payload.variants, variantSelect.value || 'all');
        if (!bootstrapData) bootstrapData = {};
        bootstrapData.variants = lastVariants.slice();
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'available_range')) {
        if (!bootstrapData) bootstrapData = {};
        bootstrapData.availableRange = payload.available_range || null;
        if (payload.available_range) {
          updateRangeBounds(payload.available_range);
        } else {
          updateRangeBounds(null);
        }
      }
    }

    const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
    const labels = buckets.map(b => b.label);
    const passData = buckets.map(b => b.pass ?? 0);
    const failData = buckets.map(b => b.fail ?? 0);
    const hasValues = buckets.some(b => (Number(b.pass) || 0) + (Number(b.fail) || 0));

    if (allowAutoAdjust && maybeAutoAdjustRange(payload.available_range, hasValues)) {
      setStatus('Adjusted date range to available production data. Refreshing…');
      await refresh({ allowAutoAdjust: false });
      return;
    }

    drawChart(labels, passData, failData, payload.interval || intervalSelect.value);

    const totals = payload.totals || {};
    const passTotal = totals.pass ?? 0;
    const failTotal = totals.fail ?? 0;
    const total = totals.total ?? passTotal + failTotal;
    passEl.textContent = formatNum(passTotal);
    failEl.textContent = formatNum(failTotal);
    totalEl.textContent = formatNum(total);

    if (hasValues) {
      hideEmptyState();
    } else {
      showEmptyState('No production results for the selected filters.');
    }

    let variantName = payload.variant?.name;
    if ((!variantName || variantName === '') && variantSelect.value && variantSelect.value !== 'all') {
      const selected = lastVariants.find(v => v.id === String(variantSelect.value));
      if (selected) {
        variantName = selected.name;
      }
    }
    const intervalLabel = (payload.interval === 'hour') ? 'hour' : 'day';
    const plural = labels.length === 1 ? '' : 's';
    const startLabel = payload.start ?? startInput.value ?? '';
    const endLabel = payload.end ?? endInput.value ?? '';
    const rangeText = `${startLabel || '—'} → ${endLabel || '—'}`;
    const variantText = variantName ? ` • ${variantName}` : '';
    setStatus(`Showing ${labels.length} ${intervalLabel}${plural} (${rangeText})${variantText}.`);
  } catch (err) {
    console.error(err);
    drawChart([], [], [], intervalSelect.value);
    cachedChart = { labels: [], pass: [], fail: [], interval: intervalSelect.value };
    showEmptyState(err.message || 'No production results for the selected filters.');
    passEl.textContent = '0';
    failEl.textContent = '0';
    totalEl.textContent = '0';
    if (bootstrapData && Object.prototype.hasOwnProperty.call(bootstrapData, 'availableRange')) {
      updateRangeBounds(bootstrapData.availableRange);
    }
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

  const requestRefresh = (allowAutoAdjust = true) => {
    refresh({ allowAutoAdjust }).catch(err => console.error(err));
  };

  refreshBtn.addEventListener('click', event => {
    event.preventDefault();
    requestRefresh();
  });
  variantSelect.addEventListener('change', () => requestRefresh());
  intervalSelect.addEventListener('change', () => requestRefresh());
  startInput.addEventListener('change', () => requestRefresh());
  endInput.addEventListener('change', () => requestRefresh());
  window.addEventListener('resize', handleResize);

  const bootPayload = bootstrapVariants();
  if (bootPayload?.availableRange) {
    setDefaultRange(bootPayload.availableRange);
  } else {
    setDefaultRange();
  }
  await loadVariants();
  if (!startInput.value || !endInput.value) {
    setDefaultRange();
  }
  await refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.error(err)); });
} else {
  init().catch(err => console.error(err));
}
