const sel   = document.getElementById('variantSel');
const binsI = document.getElementById('bins');
const btn   = document.getElementById('refresh');
const cvs   = document.getElementById('hist');
const note  = document.getElementById('rangeNote');

const el = id => document.getElementById(id);
const fmt = (x, d=3) => (x==null || Number.isNaN(x)) ? '–' : Number(x).toFixed(d);
const fmt0 = x => (x==null) ? '–' : String(Math.round(x));

async function loadVariants() {
  const r = await fetch('/api/variants', { cache:'no-store' });
  const vs = await r.json();
  sel.innerHTML = vs.map(v => `<option value="${v.id}" data-lsl="${v.min_g}" data-usl="${v.max_g}" data-unit="${v.unit}">
    ${v.name} [${v.min_g}-${v.max_g} ${v.unit}]
  </option>`).join('');
}

function drawHistogram(edges, counts, lsl, usl, mu) {
  const ctx = cvs.getContext('2d');
  const W = cvs.clientWidth, H = cvs.clientHeight;
  cvs.width = W; cvs.height = H;
  ctx.clearRect(0,0,W,H);

  if (!edges || edges.length<2 || !counts || !counts.length) {
    ctx.fillStyle = '#ccc';
    ctx.fillText('No data', 10, 20);
    return;
  }

  const b = counts.length;
  const xmin = edges[0], xmax = edges[edges.length-1];
  const maxCount = Math.max(...counts, 1);

  // axes
  ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 10); ctx.lineTo(40, H-30); ctx.lineTo(W-10, H-30);
  ctx.stroke();

  // bars
  const plotW = W - 60, plotH = H - 50;
  for (let i=0;i<b;i++){
    const x0 = 40 + Math.floor(i * (plotW/b));
    const x1 = 40 + Math.floor((i+1) * (plotW/b));
    const barW = Math.max(1, x1-x0-2);
    const h = Math.round((counts[i]/maxCount) * plotH);
    ctx.fillStyle = '#aaa';
    ctx.fillRect(x0+1, H-30-h, barW, h);
  }

  // spec lines + mean
  const xOf = (x) => 40 + Math.round(((x - xmin) / (xmax - xmin)) * plotW);
  const drawV = (x, color, label) => {
    const xx = xOf(x);
    if (xx < 40 || xx > W-20) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(xx, 10); ctx.lineTo(xx, H-30); ctx.stroke();
    ctx.fillStyle = color; ctx.fillText(label, Math.min(W-50, xx+4), 14);
  };
  drawV(lsl, '#f66', 'LSL');
  drawV(usl, '#f66', 'USL');
  drawV(mu,  '#6cf', 'μ');
}

async function refresh() {
  const id = sel.value;
  const bins = Math.max(3, Math.min(100, parseInt(binsI.value||'20',10)));
  const r = await fetch(`/api/stats/summary?variant_id=${id}&bins=${bins}`, { cache:'no-store' });
  const s = await r.json();

  el('n').textContent    = s.n;
  el('pass').textContent = s.pass;
  el('fail').textContent = s.fail;
  el('mean').textContent = fmt(s.mean, 3);
  el('stdev').textContent= fmt(s.stdev, 3);
  const yieldPct = (s.n>0) ? (100*s.pass/s.n) : 0;
  el('yield').textContent= fmt(yieldPct, 2);
  el('cp').textContent   = (s.cp==null)?'–':fmt(s.cp, 3);
  el('cpk').textContent  = (s.cpk==null)?'–':fmt(s.cpk, 3);
  el('ppm').textContent  = (s.ppm_total==null)?'–':fmt0(s.ppm_total);
  el('zlow').textContent = (s.z_low==null)?'–':fmt(s.z_low, 3);
  el('zhigh').textContent= (s.z_high==null)?'–':fmt(s.z_high, 3);
  el('spec').textContent = `${s.variant.lsl} – ${s.variant.usl} ${s.variant.unit}`;

  const edges = s.hist?.edges || [];
  const counts= s.hist?.counts || [];
  drawHistogram(edges, counts, s.variant.lsl, s.variant.usl, s.mean);

  if (edges.length>=2) {
    note.textContent = `Histogram range: ${edges[0].toFixed(3)} to ${edges[edges.length-1].toFixed(3)} ${s.variant.unit} (${edges.length-1} bins)`;
  } else {
    note.textContent = '';
  }
}

document.getElementById('refresh').addEventListener('click', refresh);

window.addEventListener('load', async () => {
  await loadVariants();
  await refresh();
  // Redraw on resize
  window.addEventListener('resize', () => refresh());
});
