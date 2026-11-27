// =============================================================
//  Painel automático: sugestão de layout, filtros, KPIs,
//  gráficos (Chart.js), tabela e exportação CSV
// =============================================================

const PALETTE = ['#2563eb', '#0d9488', '#f59e0b', '#db2777', '#7c3aed', '#16a34a', '#ea580c', '#0891b2'];
const AGG = { sum: 'Soma', avg: 'Média', max: 'Máximo', min: 'Mínimo', count: 'Contagem' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const nfc = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let charts = [];

function distinct(rows, col, limit = 5000) {
  const set = new Set();
  for (let i = 0; i < rows.length && i < limit; i++) set.add(rows[i][col]);
  return set;
}

export function suggestConfig(ds, rows) {
  const byType = t => ds.columns.filter(c => c.type === t);
  const text = byType('text'), nums = byType('number'), dates = byType('date');
  const card = c => distinct(rows, c.name).size;
  const isCode = c => /(^|_)(cod|codigo|id|nota|doc|nf|num|pedido|serie)(_|$)/i.test(c.name);
  const good = text.filter(c => !isCode(c) && card(c) > 1 && card(c) <= 60);
  const dim = good.find(c => /categ|grupo|famil|segment|regiao|estado|uf|vendedor|canal|tipo/i.test(c.name))
    || good[0] || text[0] || dates[0];
  const measure = nums.find(c => /valor|total|venda|receita|fatur|preco|custo|saldo/i.test(c.name))
    || nums.find(c => /qtd|quant/i.test(c.name)) || nums[0];
  const filterCols = text
    .filter(c => c.name !== dim?.name && !isCode(c))
    .filter(c => { const k = card(c); return k > 1 && k <= 200; })
    .slice(0, 4).map(c => c.name);
  return {
    dim: dim?.name || null,
    measure: measure ? measure.name : '__count',
    agg: measure ? 'sum' : 'count',
    dateCol: dates[0]?.name || null,
    filterCols, filters: {}, year: ''
  };
}

function applyFilters(rows, cfg) {
  const f = Object.entries(cfg.filters || {}).filter(([, v]) => v !== '' && v != null);
  return rows.filter(r => {
    for (const [c, v] of f) if (String(r[c] ?? '(vazio)') !== v) return false;
    if (cfg.year && cfg.dateCol && !(r[cfg.dateCol] || '').startsWith(cfg.year)) return false;
    return true;
  });
}

function aggregate(rows, keyFn, cfg) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    let a = m.get(k);
    if (!a) { a = { sum: 0, n: 0, cnt: 0, min: Infinity, max: -Infinity }; m.set(k, a); }
    a.cnt++;
    const v = cfg.measure === '__count' ? 1 : r[cfg.measure];
    if (typeof v === 'number') { a.sum += v; a.n++; if (v < a.min) a.min = v; if (v > a.max) a.max = v; }
  }
  const val = a => {
    if (cfg.measure === '__count' || cfg.agg === 'count') return a.cnt;
    if (!a.n) return 0;
    return cfg.agg === 'avg' ? a.sum / a.n : cfg.agg === 'min' ? a.min : cfg.agg === 'max' ? a.max : a.sum;
  };
  return [...m].map(([k, a]) => [k, val(a)]);
}

const monthKey = iso => (iso ? iso.slice(0, 7) : null);
const monthLabel = k => { const [y, m] = k.split('-'); return `${MONTHS[+m - 1]}/${y.slice(2)}`; };

export function renderDashboard(el, ds, allRows, cfg, { onSave, onChange }) {
  charts.forEach(c => c.destroy());
  charts = [];

  const cols = ds.columns;
  const dimCol = cols.find(c => c.name === cfg.dim);
  const rows = applyFilters(allRows, cfg);
  const mLabel = cfg.measure === '__count' ? 'Quantidade de linhas' : `${AGG[cfg.agg]} de ${cfg.measure}`;
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;

  // ----- filtros -----
  const filterHtml = cfg.filterCols.map(c => {
    const values = [...distinct(allRows, c, allRows.length)].map(v => String(v ?? '(vazio)')).sort((a, b) => a.localeCompare(b, 'pt-BR')).slice(0, 300);
    return `<label class="field"><span>${esc(c)}</span><select data-filter="${esc(c)}">
      ${opt('', 'Todos', !cfg.filters[c])}${values.map(v => opt(v, v, cfg.filters[c] === v)).join('')}</select></label>`;
  }).join('');
  let yearHtml = '';
  if (cfg.dateCol) {
    const years = [...new Set(allRows.map(r => (r[cfg.dateCol] || '').slice(0, 4)).filter(Boolean))].sort();
    yearHtml = `<label class="field"><span>Ano</span><select data-year>${opt('', 'Todos', !cfg.year)}${years.map(y => opt(y, y, cfg.year === y)).join('')}</select></label>`;
  }

  // ----- KPIs -----
  const total = aggregate(rows, () => 'all', cfg)[0]?.[1] ?? 0;
  const groups = cfg.dim ? aggregate(rows, r => dimCol?.type === 'date' ? monthKey(r[cfg.dim]) : (r[cfg.dim] ?? '(vazio)'), cfg) : [];
  const best = [...groups].sort((a, b) => b[1] - a[1])[0];
  const avgPerGroup = groups.length ? groups.reduce((s, g) => s + g[1], 0) / groups.length : 0;

  el.innerHTML = `
    <div class="dash-controls card">
      <label class="field"><span>Analisar por</span><select data-cfg="dim">
        ${cols.filter(c => c.type !== 'number').map(c => opt(c.name, c.name + (c.type === 'date' ? ' (mês)' : ''), c.name === cfg.dim)).join('')}
      </select></label>
      <label class="field"><span>Medida</span><select data-cfg="measure">
        ${opt('__count', 'Quantidade de linhas', cfg.measure === '__count')}
        ${cols.filter(c => c.type === 'number').map(c => opt(c.name, c.name, c.name === cfg.measure)).join('')}
      </select></label>
      <label class="field"><span>Cálculo</span><select data-cfg="agg" ${cfg.measure === '__count' ? 'disabled' : ''}>
        ${Object.entries(AGG).map(([k, v]) => opt(k, v, k === cfg.agg)).join('')}
      </select></label>
      <div class="spacer"></div>
      <button class="btn ghost" data-act="export">Exportar CSV</button>
      <button class="btn" data-act="save">Salvar painel</button>
    </div>

    ${filterHtml || yearHtml ? `<div class="filters card">${yearHtml}${filterHtml}
      <button class="btn link" data-act="clear">Limpar filtros</button></div>` : ''}

    <div class="kpis">
      <div class="kpi card"><span>${esc(mLabel)}</span><strong title="${nf.format(total)}">${nfc.format(total)}</strong></div>
      <div class="kpi card"><span>Linhas no filtro</span><strong>${nf.format(rows.length)}</strong><small>de ${nf.format(allRows.length)}</small></div>
      <div class="kpi card"><span>Maior ${esc(cfg.dim || '')}</span><strong class="kpi-text">${esc(best ? (dimCol?.type === 'date' ? monthLabel(best[0]) : best[0]) : '—')}</strong><small>${best ? nf.format(best[1]) : ''}</small></div>
      <div class="kpi card"><span>Média por ${esc(cfg.dim || 'grupo')}</span><strong>${nfc.format(avgPerGroup)}</strong><small>${groups.length} itens</small></div>
    </div>

    <div class="charts">
      <div class="card chart-card wide"><h3>${esc(mLabel)} por ${esc(cfg.dim || '')}</h3><div class="chart-box"><canvas id="c-bar"></canvas></div></div>
      <div class="card chart-card"><h3>Participação (top 5)</h3><div class="chart-box"><canvas id="c-pie"></canvas></div></div>
      ${cfg.dateCol ? `<div class="card chart-card full"><h3>Evolução mensal — ${esc(cfg.dateCol)}</h3><div class="chart-box"><canvas id="c-line"></canvas></div></div>` : ''}
    </div>

    <div class="card">
      <h3>Dados (primeiras 100 linhas do filtro)</h3>
      <div class="table-wrap"><table>
        <thead><tr>${cols.map(c => `<th class="${c.type}">${esc(c.name)}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 100).map(r => `<tr>${cols.map(c => `<td class="${c.type}">${esc(fmtCell(r[c.name], c.type))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </div>`;

  // ----- gráficos -----
  if (window.Chart) {
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.color = '#475569';
    const isDateDim = dimCol?.type === 'date';
    const bars = isDateDim ? [...groups].filter(g => g[0]).sort((a, b) => a[0].localeCompare(b[0]))
      : [...groups].sort((a, b) => b[1] - a[1]).slice(0, 15);
    charts.push(new Chart(el.querySelector('#c-bar'), {
      type: isDateDim ? 'line' : 'bar',
      data: { labels: bars.map(b => isDateDim ? monthLabel(b[0]) : b[0]), datasets: [{ label: mLabel, data: bars.map(b => b[1]), backgroundColor: PALETTE[0], borderColor: PALETTE[0], borderRadius: 4, tension: .3 }] },
      options: baseOpts(isDateDim ? {} : { indexAxis: bars.length > 8 ? 'y' : 'x' })
    }));

    const sorted = [...groups].filter(g => !(isDateDim && !g[0])).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 5);
    const additive = cfg.measure === '__count' || cfg.agg === 'sum' || cfg.agg === 'count';
    if (additive && sorted.length > 5) top.push(['Outros', sorted.slice(5).reduce((s, g) => s + g[1], 0)]);
    charts.push(new Chart(el.querySelector('#c-pie'), {
      type: 'doughnut',
      data: { labels: top.map(t => isDateDim && t[0] !== 'Outros' ? monthLabel(t[0]) : t[0]), datasets: [{ data: top.map(t => t[1]), backgroundColor: [...PALETTE.slice(0, 5), '#cbd5e1'], borderWidth: 2, borderColor: '#fff' }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: c => ` ${c.label}: ${nf.format(c.raw)}` } } } }
    }));

    if (cfg.dateCol) {
      const line = aggregate(rows, r => monthKey(r[cfg.dateCol]), cfg).filter(g => g[0]).sort((a, b) => a[0].localeCompare(b[0]));
      charts.push(new Chart(el.querySelector('#c-line'), {
        type: 'line',
        data: { labels: line.map(l => monthLabel(l[0])), datasets: [{ label: mLabel, data: line.map(l => l[1]), borderColor: PALETTE[1], backgroundColor: 'rgba(13,148,136,.12)', fill: true, tension: .3, pointRadius: 3 }] },
        options: baseOpts({})
      }));
    }
  }

  // ----- eventos -----
  const update = patch => onChange({ ...cfg, ...patch });
  el.querySelectorAll('[data-cfg]').forEach(s => s.addEventListener('change', () => {
    const patch = { [s.dataset.cfg]: s.value };
    if (s.dataset.cfg === 'measure') patch.agg = s.value === '__count' ? 'count' : (cfg.agg === 'count' ? 'sum' : cfg.agg);
    update(patch);
  }));
  el.querySelectorAll('[data-filter]').forEach(s => s.addEventListener('change', () =>
    update({ filters: { ...cfg.filters, [s.dataset.filter]: s.value } })));
  el.querySelector('[data-year]')?.addEventListener('change', e => update({ year: e.target.value }));
  el.querySelector('[data-act="clear"]')?.addEventListener('click', () => update({ filters: {}, year: '' }));
  el.querySelector('[data-act="save"]').addEventListener('click', () => onSave(cfg));
  el.querySelector('[data-act="export"]').addEventListener('click', () => exportCSV(ds, rows));
}

function baseOpts(extra) {
  return {
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${nf.format(c.raw)}` } } },
    scales: {
      x: { grid: { display: false }, ticks: { callback: tick } },
      y: { grid: { color: '#eef2f7' }, ticks: { callback: tick } }
    },
    ...extra
  };
}

// rótulos dos eixos: números abreviados (1,2 mil) e textos cortados
function tick(v) {
  const l = this.type === 'category' ? this.getLabelForValue(v) : v;
  return typeof l === 'number' ? nfc.format(l) : String(l).slice(0, 20);
}

function fmtCell(v, type) {
  if (v === null || v === undefined) return '';
  if (type === 'number') return nf.format(v);
  if (type === 'date') { const [y, m, d] = v.split('-'); return `${d}/${m}/${y}`; }
  return v;
}

function exportCSV(ds, rows) {
  const cols = ds.columns;
  const cell = (v, t) => {
    let s = v == null ? '' : t === 'number' ? String(v).replace('.', ',') : t === 'date' ? fmtCell(v, t) : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(c => cell(c.name)).join(';'), ...rows.map(r => cols.map(c => cell(r[c.name], c.type)).join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${ds.name.replace(/[^\w\-]+/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
