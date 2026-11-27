// =============================================================
//  Painel personalizável
//  - Modo visualização: filtros, clique no gráfico para filtrar
//  - Modo edição: adicionar/editar/duplicar/excluir gráficos,
//    escolher filtros, arrastar para mover e puxar o canto
//    para redimensionar
// =============================================================

const PALETTE = ['#2563eb', '#0d9488', '#f59e0b', '#db2777', '#7c3aed', '#16a34a', '#ea580c', '#0891b2', '#64748b'];
const AGG = { sum: 'Soma', avg: 'Média', max: 'Máximo', min: 'Mínimo', count: 'Contagem' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const GRAINS = { month: 'Mês', year: 'Ano', day: 'Dia' };
export const TYPES = {
  kpi: { label: 'Indicador', icon: '123', h: 130 },
  bar: { label: 'Colunas', icon: '▮▮', h: 320 },
  hbar: { label: 'Barras', icon: '☰', h: 320 },
  line: { label: 'Linha', icon: '⟋', h: 300 },
  area: { label: 'Área', icon: '◭', h: 300 },
  pie: { label: 'Pizza', icon: '◕', h: 320 },
  doughnut: { label: 'Rosca', icon: '◎', h: 320 },
  table: { label: 'Tabela resumo', icon: '▤', h: 320 },
  datatable: { label: 'Tabela de dados', icon: '▦', h: 420 }
};
const GAP = 16;          // espaço entre os cartões (px)
const COLS = 24;         // colunas da grade livre
const ROW = 10;          // altura de uma linha da grade (px)
const MOBILE = 700;      // abaixo disso os cartões ficam empilhados
const defaultLabels = t => (t === 'pie' || t === 'doughnut') ? 'percent' : ['bar', 'hbar', 'line', 'area'].includes(t) ? 'value' : 'none';
const labelsOf = w => w.labels || defaultLabels(w.type);
const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const nfc = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => 'w' + Math.random().toString(36).slice(2, 9);
const clone = o => JSON.parse(JSON.stringify(o));

// ---------------- rótulos de valores (plugin próprio do Chart.js) ----------------
const LABELS = { none: 'Não mostrar', value: 'Valor', percent: 'Percentual', both: 'Valor e %' };
const fmtLabel = v => Math.abs(v) >= 10000 ? nfc.format(v) : nf.format(v);
const valueLabelsPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    const o = chart.options.plugins.valueLabels;
    if (!o || !o.mode || o.mode === 'none') return;
    const { ctx } = chart;
    const ds = chart.data.datasets[0];
    const meta = chart.getDatasetMeta(0);
    const total = ds.data.reduce((s, v) => s + (Number(v) || 0), 0);
    const step = Math.max(1, Math.ceil(meta.data.length / 40)); // evita poluição em séries longas
    ctx.save();
    ctx.font = `600 11px Inter, system-ui, sans-serif`;
    meta.data.forEach((el, i) => {
      const v = ds.data[i];
      if (v == null || (o.kind === 'line' && i % step)) return;
      const pct = total ? v / total * 100 : 0;
      if (o.kind === 'pie' && pct < 4) return; // fatias muito pequenas
      const pctTxt = nf.format(Math.round(pct * 10) / 10) + '%';
      const text = o.mode === 'percent' ? pctTxt : o.mode === 'both' ? `${fmtLabel(v)} (${pctTxt})` : fmtLabel(v);
      let x, y;
      if (o.kind === 'pie') {
        ({ x, y } = el.tooltipPosition());
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(15,23,42,.55)'; ctx.fillStyle = '#fff';
        ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
        return;
      }
      ctx.fillStyle = '#334155';
      if (o.kind === 'hbar') {
        x = el.x + (v < 0 ? -6 : 6); y = el.y;
        ctx.textAlign = v < 0 ? 'right' : 'left'; ctx.textBaseline = 'middle';
      } else {
        x = el.x; y = el.y + (v < 0 ? 6 : -6);
        ctx.textAlign = 'center'; ctx.textBaseline = v < 0 ? 'top' : 'bottom';
        if (o.kind === 'line') { y -= 2; ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText(text, x, y); }
      }
      ctx.fillText(text, x, y);
    });
    ctx.restore();
  }
};

// ---------------- configuração inicial ----------------
function distinct(rows, col, limit = 5000) {
  const set = new Set();
  for (let i = 0; i < rows.length && i < limit; i++) set.add(rows[i][col]);
  return set;
}

export function suggestConfig(ds, rows, pref = {}) {
  const byType = t => ds.columns.filter(c => c.type === t);
  const text = byType('text'), nums = byType('number'), dates = byType('date');
  const card = c => distinct(rows, c.name).size;
  const isCode = c => /(^|_)(cod|codigo|id|nota|doc|nf|num|pedido|serie)(_|$)/i.test(c.name);
  const good = text.filter(c => !isCode(c) && card(c) > 1 && card(c) <= 60);
  const dim = pref.dim || (good.find(c => /categ|grupo|famil|segment|regiao|estado|uf|vendedor|canal|tipo/i.test(c.name))
    || good[0] || text[0] || dates[0])?.name || null;
  const measure = pref.measure || (nums.find(c => /valor|total|venda|receita|fatur|preco|custo|saldo/i.test(c.name))
    || nums.find(c => /qtd|quant/i.test(c.name)) || nums[0])?.name || '__count';
  const agg = pref.agg || (measure === '__count' ? 'count' : 'sum');
  const dateCol = dates[0]?.name || null;
  const filterCols = pref.filterCols || [
    ...(dateCol ? ['__year'] : []),
    ...text.filter(c => c.name !== dim && !isCode(c)).filter(c => { const k = card(c); return k > 1 && k <= 200; }).slice(0, 4).map(c => c.name)
  ];
  const w = (type, extra) => ({ id: uid(), type, title: '', dim, grain: 'month', measure, agg, top: 0, sort: 'desc', color: 0, w: 6, h: TYPES[type].h, ...extra });
  const widgets = [];
  if (measure !== '__count') {
    widgets.push(w('kpi', { w: 3 }));
    widgets.push(w('kpi', { w: 3, agg: 'avg' }));
    widgets.push(w('kpi', { w: 3, agg: 'max' }));
  }
  widgets.push(w('kpi', { w: measure === '__count' ? 12 : 3, measure: '__count', agg: 'count', title: 'Quantidade de linhas' }));
  if (dim) {
    widgets.push(w('bar', { w: 8, top: 15 }));
    widgets.push(w('doughnut', { w: 4, top: 5, color: 1 }));
  }
  if (dateCol) widgets.push(w('area', { w: 12, dim: dateCol, sort: 'label', color: 1 }));
  widgets.push(w('datatable', { w: 12, title: 'Dados' }));
  return toV3({ version: 2, dateCol, filterCols, filters: {}, widgets });
}

// v2 (sequência de cartões) -> v3 (posição livre x/y na grade)
function toV3(cfg) {
  const out = clone(cfg);
  let x = 0, y = 0, rowH = 0;
  for (const w of out.widgets) {
    const gw = clamp(Math.round((w.w || 6) * 2), 4, COLS);
    const gh = Math.max(8, Math.round(((w.h || 300) + GAP) / ROW));
    if (x + gw > COLS) { x = 0; y += rowH; rowH = 0; }
    Object.assign(w, { gx: x, gy: y, gw, gh });
    if (w.labels === 'none') delete w.labels; // passa a usar o padrão do tipo
    delete w.w; delete w.h;
    x += gw; rowH = Math.max(rowH, gh);
  }
  out.version = 3;
  return out;
}

// configurações antigas viram v3 mantendo as escolhas
export function normalizeConfig(cfg, ds, rows) {
  if (cfg && cfg.version === 3) return clone(cfg);
  if (cfg && cfg.version === 2) return toV3(cfg);
  if (!cfg) return suggestConfig(ds, rows);
  return suggestConfig(ds, rows, { dim: cfg.dim, measure: cfg.measure, agg: cfg.agg, filterCols: cfg.filterCols });
}

// ---------------- cálculos ----------------
function applyFilters(rows, cfg, dateCol) {
  const f = Object.entries(cfg.filters || {}).filter(([, v]) => v !== '' && v != null);
  if (!f.length) return rows;
  return rows.filter(r => {
    for (const [c, v] of f) {
      if (c === '__year') { if ((r[dateCol] || '').slice(0, 4) !== v) return false; }
      else if (c === '__month') { if ((r[dateCol] || '').slice(5, 7) !== v) return false; }
      else if (String(r[c] ?? '(vazio)') !== v) return false;
    }
    return true;
  });
}

function dateKey(iso, grain) {
  if (!iso) return null;
  return grain === 'year' ? iso.slice(0, 4) : grain === 'day' ? iso : iso.slice(0, 7);
}
function dateLabel(k, grain) {
  if (grain === 'year') return k;
  if (grain === 'day') { const [y, m, d] = k.split('-'); return `${d}/${m}/${y.slice(2)}`; }
  const [y, m] = k.split('-'); return `${MONTHS[+m - 1]}/${y.slice(2)}`;
}

function aggregate(rows, keyFn, w) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null) continue;
    let a = m.get(k);
    if (!a) { a = { sum: 0, n: 0, cnt: 0, min: Infinity, max: -Infinity }; m.set(k, a); }
    a.cnt++;
    const v = w.measure === '__count' ? 1 : r[w.measure];
    if (typeof v === 'number') { a.sum += v; a.n++; if (v < a.min) a.min = v; if (v > a.max) a.max = v; }
  }
  const val = a => {
    if (w.measure === '__count' || w.agg === 'count') return a.cnt;
    if (!a.n) return 0;
    return w.agg === 'avg' ? a.sum / a.n : w.agg === 'min' ? a.min : w.agg === 'max' ? a.max : a.sum;
  };
  return [...m].map(([k, a]) => [k, val(a)]);
}

const isAdditive = w => w.measure === '__count' || w.agg === 'sum' || w.agg === 'count';
const measureLabel = w => w.measure === '__count' ? 'Quantidade de linhas' : `${AGG[w.agg]} de ${w.measure}`;

function autoTitle(w, ds) {
  if (w.type === 'datatable') return 'Dados';
  if (w.type === 'kpi') return measureLabel(w);
  const dimCol = ds.columns.find(c => c.name === w.dim);
  const by = dimCol?.type === 'date' ? `${w.dim} (${GRAINS[w.grain || 'month'].toLowerCase()})` : w.dim;
  return `${measureLabel(w)} por ${by || '—'}`;
}

// agrupa, ordena e limita os dados de um gráfico
function groupData(rows, w, ds) {
  const dimCol = ds.columns.find(c => c.name === w.dim);
  if (!dimCol) return { labels: [], keys: [], values: [], isDate: false };
  const isDate = dimCol.type === 'date';
  const grain = w.grain || 'month';
  let g = aggregate(rows, isDate ? r => dateKey(r[w.dim], grain) : r => r[w.dim] ?? '(vazio)', w);
  const sort = w.sort || (isDate ? 'label' : 'desc');
  if (sort === 'label') g.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'pt-BR', { numeric: true }));
  else g.sort((a, b) => sort === 'asc' ? a[1] - b[1] : b[1] - a[1]);
  const pie = w.type === 'pie' || w.type === 'doughnut';
  if (w.top > 0 && g.length > w.top) {
    const rest = g.slice(w.top);
    g = g.slice(0, w.top);
    if (pie && isAdditive(w)) g.push(['__outros', rest.reduce((s, x) => s + x[1], 0)]);
  }
  return {
    isDate,
    keys: g.map(x => x[0]),
    labels: g.map(x => x[0] === '__outros' ? 'Outros' : isDate ? dateLabel(x[0], grain) : x[0]),
    values: g.map(x => x[1])
  };
}

// ---------------- montagem do painel ----------------
export function mountDashboard(el, ds, allRows, savedCfg, onSave) {
  let saved = normalizeConfig(savedCfg, ds, allRows);
  let cfg = clone(saved);
  let editing = false;
  let dirty = false;
  const charts = new Map();

  const cols = ds.columns;
  const textCols = cols.filter(c => c.type === 'text');
  const dateCols = cols.filter(c => c.type === 'date');
  const numCols = cols.filter(c => c.type === 'number');
  if (cfg.dateCol && !dateCols.find(c => c.name === cfg.dateCol)) cfg.dateCol = dateCols[0]?.name || null;

  const markDirty = () => { dirty = true; };
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;

  function draw() {
    charts.forEach(c => c.destroy());
    charts.clear();
    const rows = applyFilters(allRows, cfg, cfg.dateCol);

    // ----- barra superior -----
    const toolbar = editing ? `
      <div class="dash-toolbar card editing-bar">
        <div class="hint">✎ <strong>Modo edição</strong> — arraste o gráfico pelo título para qualquer lugar e puxe o canto ◢ para mudar o tamanho.</div>
        <button class="btn ghost" data-act="filters">⚲ Escolher filtros</button>
        <button class="btn ghost" data-act="add">+ Adicionar gráfico</button>
        <button class="btn ghost" data-act="cancel">Cancelar</button>
        <button class="btn" data-act="save">Salvar painel</button>
      </div>` : `
      <div class="dash-toolbar">
        <div class="spacer"></div>
        <button class="btn ghost" data-act="export">Exportar CSV</button>
        <button class="btn" data-act="edit">✎ Editar painel</button>
      </div>`;

    // ----- filtros -----
    const filterSelects = cfg.filterCols.map(c => {
      if (c === '__year' || c === '__month') {
        if (!cfg.dateCol) return '';
        if (c === '__year') {
          const years = [...new Set(allRows.map(r => (r[cfg.dateCol] || '').slice(0, 4)).filter(Boolean))].sort();
          return `<label class="field"><span>Ano</span><select data-filter="__year">${opt('', 'Todos', !cfg.filters.__year)}${years.map(y => opt(y, y, cfg.filters.__year === y)).join('')}</select></label>`;
        }
        return `<label class="field"><span>Mês</span><select data-filter="__month">${opt('', 'Todos', !cfg.filters.__month)}${MONTHS_FULL.map((m, i) => { const v = String(i + 1).padStart(2, '0'); return opt(v, m, cfg.filters.__month === v); }).join('')}</select></label>`;
      }
      if (!cols.find(x => x.name === c)) return '';
      const values = [...distinct(allRows, c, allRows.length)].map(v => String(v ?? '(vazio)')).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })).slice(0, 500);
      return `<label class="field"><span>${esc(c)}</span><select data-filter="${esc(c)}">${opt('', 'Todos', !cfg.filters[c])}${values.map(v => opt(v, v, cfg.filters[c] === v)).join('')}</select></label>`;
    }).join('');
    // filtros ativos que não estão na barra (ex.: clique no gráfico)
    const chips = Object.entries(cfg.filters).filter(([k, v]) => v && !cfg.filterCols.includes(k))
      .map(([k, v]) => `<span class="chip">${esc(k)}: <strong>${esc(v)}</strong><button data-unfilter="${esc(k)}" title="Remover">×</button></span>`).join('');
    const hasActive = Object.values(cfg.filters).some(Boolean);
    const filterBar = (filterSelects || chips || editing) ? `
      <div class="filters card">
        ${filterSelects || (editing ? '<span class="muted">Nenhum filtro escolhido. Clique em "Escolher filtros".</span>' : '')}
        ${chips}
        ${hasActive ? '<button class="btn link" data-act="clear">Limpar filtros</button>' : ''}
        <span class="muted rowcount">${nf.format(rows.length)} de ${nf.format(allRows.length)} linhas</span>
      </div>` : '';

    el.innerHTML = `${toolbar}${filterBar}
      <div class="dash-canvas ${editing ? 'editing' : ''}">
        ${editing ? '<div class="grid-bg"></div><div class="drop-ghost" hidden></div>' : ''}
        ${cfg.widgets.map(w => widgetHtml(w)).join('')}
      </div>
      ${!cfg.widgets.length && !editing ? '<div class="card empty"><p>Este painel está vazio. Clique em <strong>Editar painel</strong> para adicionar gráficos.</p></div>' : ''}`;

    layout();
    cfg.widgets.forEach(w => fillWidget(w, rows));
    bindEvents();
  }

  function widgetHtml(w) {
    const title = w.title || autoTitle(w, ds);
    return `
      <section class="widget w-${w.type}" data-id="${w.id}">
        <header class="w-head">
          ${editing ? '<span class="grip" title="Arraste para mover">⠿</span>' : ''}
          <h3 title="${esc(title)}">${esc(title)}</h3>
          ${editing ? `<div class="w-tools">
            <button data-w="edit" title="Editar gráfico">✎</button>
            <button data-w="dup" title="Duplicar">⧉</button>
            <button data-w="del" title="Excluir">🗑</button>
          </div>` : ''}
        </header>
        <div class="w-body"></div>
        ${editing ? '<div class="w-resize" title="Arraste para redimensionar">◢</div>' : ''}
      </section>`;
  }

  // ---------- grade livre ----------
  const canvasEl = () => el.querySelector('.dash-canvas');
  const metrics = () => {
    const c = canvasEl();
    const width = c.clientWidth;
    return { width, colW: (width + GAP) / COLS, mobile: width < MOBILE };
  };
  const overlap = (a, b) => a.gx < b.gx + b.gw && b.gx < a.gx + a.gw && a.gy < b.gy + b.gh && b.gy < a.gy + a.gh;

  // empurra para baixo quem ficou em cima do cartão movido
  function resolve(moved) {
    const queue = [moved];
    let guard = 0;
    while (queue.length && guard++ < 500) {
      const a = queue.shift();
      for (const b of cfg.widgets) {
        if (b !== a && b !== moved && overlap(a, b)) { b.gy = a.gy + a.gh; queue.push(b); }
        else if (b !== a && b === moved && a !== moved && overlap(a, b)) { a.gy = b.gy + b.gh; queue.push(a); }
      }
    }
  }

  // primeiro espaço vazio onde o cartão cabe
  function findFree(gw, gh) {
    for (let y = 0; y < 2000; y++) {
      for (let x = 0; x + gw <= COLS; x++) {
        const t = { gx: x, gy: y, gw, gh };
        if (!cfg.widgets.some(o => overlap(t, o))) return { gx: x, gy: y };
      }
    }
    return { gx: 0, gy: 0 };
  }

  function rect(w, m) {
    return { left: w.gx * m.colW, top: w.gy * ROW, width: w.gw * m.colW - GAP, height: w.gh * ROW - GAP };
  }

  function layout() {
    const c = canvasEl();
    if (!c) return;
    const m = metrics();
    let bottom = 0;
    if (m.mobile) {
      // celular: empilha na ordem visual (de cima para baixo, da esquerda para a direita)
      let top = 0;
      [...cfg.widgets].sort((a, b) => a.gy - b.gy || a.gx - b.gx).forEach(w => {
        const sec = c.querySelector(`.widget[data-id="${w.id}"]`);
        const h = Math.max(110, w.gh * ROW - GAP);
        Object.assign(sec.style, { left: '0px', top: top + 'px', width: '100%', height: h + 'px' });
        top += h + GAP;
      });
      bottom = top;
    } else {
      cfg.widgets.forEach(w => {
        const sec = c.querySelector(`.widget[data-id="${w.id}"]`);
        const r = rect(w, m);
        Object.assign(sec.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        bottom = Math.max(bottom, (w.gy + w.gh) * ROW);
      });
    }
    c.style.height = (bottom + (editing && !m.mobile ? 320 : 0)) + 'px';
    const bg = c.querySelector('.grid-bg');
    if (bg) bg.style.backgroundSize = `${m.colW}px ${ROW * 4}px`;
  }

  function fillWidget(w, rows) {
    const body = el.querySelector(`.widget[data-id="${w.id}"] .w-body`);
    if (!body) return;
    const color = PALETTE[w.color || 0] || PALETTE[0];

    if (w.type === 'kpi') {
      const v = aggregate(rows, () => 'all', w)[0]?.[1] ?? 0;
      body.innerHTML = `<div class="kpi-val" style="color:${color}" title="${nf.format(v)}">${Math.abs(v) >= 1e5 ? nfc.format(v) : nf.format(v)}</div>`;
      return;
    }
    if (w.type === 'datatable') {
      body.innerHTML = `<div class="table-wrap fill"><table>
        <thead><tr>${cols.map(c => `<th class="${c.type}">${esc(c.name)}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 200).map(r => `<tr>${cols.map(c => `<td class="${c.type}">${esc(fmtCell(r[c.name], c.type))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>${rows.length > 200 ? `<div class="muted small">Mostrando 200 de ${nf.format(rows.length)} linhas. Use "Exportar CSV" para ver tudo.</div>` : ''}`;
      return;
    }
    const g = groupData(rows, w, ds);
    if (!g.values.length) { body.innerHTML = '<div class="muted center">Sem dados para este filtro.</div>'; return; }

    if (w.type === 'table') {
      const total = g.values.reduce((s, v) => s + v, 0);
      const max = Math.max(...g.values.map(Math.abs)) || 1;
      body.innerHTML = `<div class="table-wrap fill"><table class="summary">
        <thead><tr><th>${esc(w.dim)}</th><th class="number">${esc(measureLabel(w))}</th>${isAdditive(w) ? '<th class="number">%</th>' : ''}</tr></thead>
        <tbody>${g.labels.map((l, i) => `<tr data-key="${esc(g.keys[i])}" class="${g.isDate ? '' : 'clickable'}">
          <td><div class="bar-cell"><span style="width:${Math.abs(g.values[i]) / max * 100}%;background:${color}22"></span>${esc(l)}</div></td>
          <td class="number">${nf.format(g.values[i])}</td>
          ${isAdditive(w) ? `<td class="number">${total ? nf.format(g.values[i] / total * 100) : 0}%</td>` : ''}</tr>`).join('')}</tbody>
      </table></div>`;
      if (!g.isDate) body.querySelectorAll('tr[data-key]').forEach(tr => tr.addEventListener('click', () => toggleFilter(w.dim, tr.dataset.key)));
      return;
    }

    if (!window.Chart) { body.innerHTML = '<div class="muted center">Biblioteca de gráficos não carregou.</div>'; return; }
    body.innerHTML = '<div class="chart-box"><canvas></canvas></div>';
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.color = '#475569';
    const canvas = body.querySelector('canvas');
    const pie = w.type === 'pie' || w.type === 'doughnut';
    const line = w.type === 'line' || w.type === 'area';
    const onClick = (evt, els) => {
      if (editing || g.isDate || !els.length) return;
      const key = g.keys[els[0].index];
      if (key !== '__outros') toggleFilter(w.dim, String(key));
    };
    const tooltip = { callbacks: { label: c => ` ${pie ? c.label + ': ' : ''}${nf.format(c.raw)}` } };
    let chart;
    if (pie) {
      const colors = g.keys.map((k, i) => k === '__outros' ? '#cbd5e1' : PALETTE[(i + (w.color || 0)) % (PALETTE.length - 1)]);
      chart = new Chart(canvas, {
        type: w.type,
        data: { labels: g.labels, datasets: [{ data: g.values, backgroundColor: colors, borderColor: '#fff', borderWidth: 2 }] },
        options: { maintainAspectRatio: false, onClick, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } }, tooltip, valueLabels: { mode: labelsOf(w), kind: 'pie' } } },
        plugins: [valueLabelsPlugin]
      });
    } else {
      const showLabels = labelsOf(w) !== 'none';
      chart = new Chart(canvas, {
        type: line ? 'line' : 'bar',
        plugins: [valueLabelsPlugin],
        data: {
          labels: g.labels,
          datasets: [{
            label: measureLabel(w), data: g.values,
            backgroundColor: line ? color + '22' : color, borderColor: color,
            borderRadius: 4, fill: w.type === 'area', tension: .25, pointRadius: g.values.length > 60 ? 0 : 3
          }]
        },
        options: {
          maintainAspectRatio: false, onClick,
          indexAxis: w.type === 'hbar' ? 'y' : 'x',
          plugins: { legend: { display: false }, tooltip, valueLabels: { mode: labelsOf(w), kind: w.type === 'hbar' ? 'hbar' : line ? 'line' : 'bar' } },
          layout: { padding: !showLabels ? 0 : w.type === 'hbar' ? { right: labelsOf(w) === 'both' ? 90 : 50 } : line ? { top: 22, left: 12, right: 30 } : { top: 20 } },
          scales: { x: { grid: { display: w.type === 'hbar' }, ticks: { callback: tick } }, y: { grid: { color: '#eef2f7', display: w.type !== 'hbar' }, ticks: { callback: tick } } }
        }
      });
    }
    charts.set(w.id, chart);
  }

  function toggleFilter(col, value) {
    cfg.filters = { ...cfg.filters, [col]: cfg.filters[col] === value ? '' : value };
    if (editing) markDirty();
    draw();
  }

  // ---------------- eventos ----------------
  function bindEvents() {
    const act = (name, fn) => el.querySelectorAll(`[data-act="${name}"]`).forEach(b => b.addEventListener('click', fn));
    act('edit', () => { editing = true; dirty = false; draw(); });
    act('cancel', () => {
      if (dirty && !confirm('Descartar as alterações do painel?')) return;
      cfg = clone(saved); editing = false; draw();
    });
    act('save', async e => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        await onSave(clone(cfg));
        saved = clone(cfg); editing = false; dirty = false; draw();
      } catch { btn.disabled = false; }
    });
    act('export', () => exportCSV(ds, applyFilters(allRows, cfg, cfg.dateCol)));
    act('clear', () => { cfg.filters = {}; draw(); });
    act('add', () => editWidget(null));
    act('filters', chooseFilters);
    el.querySelectorAll('[data-filter]').forEach(s => s.addEventListener('change', () => {
      cfg.filters = { ...cfg.filters, [s.dataset.filter]: s.value }; draw();
    }));
    el.querySelectorAll('[data-unfilter]').forEach(b => b.addEventListener('click', () => {
      cfg.filters = { ...cfg.filters, [b.dataset.unfilter]: '' }; draw();
    }));
    if (!editing) return;

    el.querySelectorAll('.widget[data-id]').forEach(sec => {
      const w = cfg.widgets.find(x => x.id === sec.dataset.id);
      sec.querySelector('[data-w="edit"]').addEventListener('click', () => editWidget(w));
      sec.querySelector('[data-w="dup"]').addEventListener('click', () => {
        const i = cfg.widgets.indexOf(w);
        const copy = { ...clone(w), id: uid(), title: w.title ? w.title + ' (cópia)' : '' };
        Object.assign(copy, findFree(w.gw, w.gh));
        cfg.widgets.splice(i + 1, 0, copy);
        markDirty(); draw();
      });
      sec.querySelector('[data-w="del"]').addEventListener('click', () => {
        if (!confirm(`Excluir "${w.title || autoTitle(w, ds)}"?`)) return;
        cfg.widgets = cfg.widgets.filter(x => x !== w); markDirty(); draw();
      });
      sec.querySelector('.w-head h3').addEventListener('dblclick', () => editWidget(w));
      bindResize(sec, w);
      bindDrag(sec, w);
    });
  }

  // arrastar com o mouse: posição livre (move) ou tamanho (resize)
  function startPointer(e, sec, w, mode) {
    if (e.button !== 0) return;
    const m = metrics();
    if (m.mobile) return;
    e.preventDefault();
    const c = canvasEl();
    const ghost = c.querySelector('.drop-ghost');
    const start = { x: e.clientX, y: e.clientY, ...rect(w, m) };
    const orig = { gx: w.gx, gy: w.gy, gw: w.gw, gh: w.gh };
    let target = { ...orig };
    sec.classList.add(mode === 'move' ? 'moving' : 'resizing');
    ghost.hidden = false;
    const showGhost = () => {
      const r = rect(target, m);
      Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      sec.dataset.size = `${target.gw}/${COLS} col · ${target.gh * ROW - GAP}px`;
      // aumenta a área quando o cartão chega perto do fim
      const need = (target.gy + target.gh) * ROW + 320;
      if (parseFloat(c.style.height) < need) c.style.height = need + 'px';
    };
    showGhost();
    const move = ev => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (mode === 'move') {
        sec.style.left = start.left + dx + 'px';
        sec.style.top = Math.max(0, start.top + dy) + 'px';
        target.gx = clamp(Math.round((start.left + dx) / m.colW), 0, COLS - orig.gw);
        target.gy = Math.max(0, Math.round((start.top + dy) / ROW));
      } else {
        const wpx = Math.max(m.colW * 3 - GAP, start.width + dx);
        const hpx = Math.max(90, start.height + dy);
        sec.style.width = wpx + 'px';
        sec.style.height = hpx + 'px';
        target.gw = clamp(Math.round((wpx + GAP) / m.colW), 3, COLS - orig.gx);
        target.gh = clamp(Math.round((hpx + GAP) / ROW), 8, 150);
      }
      showGhost();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      sec.classList.remove('moving', 'resizing');
      ghost.hidden = true;
      if (target.gx !== orig.gx || target.gy !== orig.gy || target.gw !== orig.gw || target.gh !== orig.gh) {
        Object.assign(w, target);
        resolve(w);
        markDirty();
      }
      layout();
      charts.get(w.id)?.resize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function bindResize(sec, w) {
    sec.querySelector('.w-resize').addEventListener('pointerdown', e => { e.stopPropagation(); startPointer(e, sec, w, 'resize'); });
  }
  function bindDrag(sec, w) {
    sec.querySelector('.w-head').addEventListener('pointerdown', e => {
      if (e.target.closest('.w-tools')) return;
      startPointer(e, sec, w, 'move');
    });
  }

  // ---------------- janela: editar/adicionar gráfico ----------------
  function editWidget(existing) {
    const isNew = !existing;
    const mainW = cfg.widgets.find(x => x.measure && x.measure !== '__count');
    const mainMeasure = mainW?.measure || numCols[0]?.name || '__count';
    const base = existing ? clone(existing) : {
      id: uid(), type: 'bar', title: '',
      dim: textCols[0]?.name || dateCols[0]?.name || null, grain: 'month',
      measure: mainMeasure, agg: mainMeasure === '__count' ? 'count' : 'sum',
      top: 10, sort: 'desc', color: 0
    };
    const dimOpts = cols.filter(c => c.type !== 'number')
      .map(c => opt(c.name, c.name + (c.type === 'date' ? ' (data)' : ''), c.name === base.dim)).join('');
    const body = `
      <div class="type-picker">${Object.entries(TYPES).map(([k, t]) => `
        <label class="type-opt"><input type="radio" name="type" value="${k}" ${k === base.type ? 'checked' : ''}>
          <span class="ti">${t.icon}</span><span>${t.label}</span></label>`).join('')}
      </div>
      <label class="field"><span>Título do gráfico</span><input name="wtitle" value="${esc(base.title)}" placeholder="${esc(autoTitle(base, ds))}"></label>
      <div class="form-grid">
        <label class="field" data-show="dim"><span>Analisar por</span><select name="dim">${dimOpts}</select></label>
        <label class="field" data-show="grain"><span>Agrupar data por</span><select name="grain">${Object.entries(GRAINS).map(([k, v]) => opt(k, v, k === (base.grain || 'month'))).join('')}</select></label>
        <label class="field" data-show="measure"><span>Medida</span><select name="measure">
          ${opt('__count', 'Quantidade de linhas', base.measure === '__count')}
          ${numCols.map(c => opt(c.name, c.name, c.name === base.measure)).join('')}</select></label>
        <label class="field" data-show="agg"><span>Cálculo</span><select name="agg">${Object.entries(AGG).map(([k, v]) => opt(k, v, k === base.agg)).join('')}</select></label>
        <label class="field" data-show="top"><span>Mostrar</span><select name="top">
          ${[[0, 'Todos os itens'], [5, 'Top 5'], [10, 'Top 10'], [15, 'Top 15'], [20, 'Top 20'], [30, 'Top 30'], [50, 'Top 50']].map(([v, l]) => opt(v, l, +base.top === v)).join('')}</select></label>
        <label class="field" data-show="sort"><span>Ordenar por</span><select name="sort">
          ${opt('desc', 'Maior valor primeiro', base.sort === 'desc')}${opt('asc', 'Menor valor primeiro', base.sort === 'asc')}${opt('label', 'Nome / data (A→Z)', base.sort === 'label')}</select></label>
      </div>
      <label class="field" data-show="labels"><span>Rótulos de dados</span><select name="labels">
        ${Object.entries(LABELS).map(([k, v]) => opt(k, v, k === labelsOf(base))).join('')}</select></label>
      <div class="field" data-show="color"><span>Cor</span><div class="swatches">${PALETTE.map((c, i) => `
        <label><input type="radio" name="color" value="${i}" ${i === (base.color || 0) ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>`;

    const modal = openModal(isNew ? 'Adicionar gráfico' : 'Editar gráfico', body, isNew ? 'Adicionar' : 'Aplicar', form => {
      const t = form.type.value;
      const w = {
        ...base, type: t, title: form.wtitle.value.trim(), dim: form.dim.value || null, grain: form.grain.value,
        measure: form.measure.value, agg: form.measure.value === '__count' ? 'count' : form.agg.value,
        top: +form.top.value, sort: form.sort.value, color: +(form.color.value || 0), labels: form.labels.value
      };
      if (isNew) {
        w.gw = t === 'kpi' ? 6 : t === 'datatable' ? COLS : 12;
        w.gh = Math.round((TYPES[t].h + GAP) / ROW);
        Object.assign(w, findFree(w.gw, w.gh));
        cfg.widgets.push(w);
      } else {
        cfg.widgets[cfg.widgets.findIndex(x => x.id === existing.id)] = w;
      }
      markDirty(); draw();
    });

    const form = modal.querySelector('form');
    const refresh = () => {
      const t = form.type.value;
      const dimCol = cols.find(c => c.name === form.dim.value);
      const show = {
        dim: !['kpi', 'datatable'].includes(t),
        grain: !['kpi', 'datatable'].includes(t) && dimCol?.type === 'date',
        measure: t !== 'datatable',
        agg: t !== 'datatable' && form.measure.value !== '__count',
        top: !['kpi', 'datatable'].includes(t),
        sort: !['kpi', 'datatable'].includes(t),
        color: !['datatable', 'table'].includes(t),
        labels: !['kpi', 'datatable', 'table'].includes(t)
      };
      form.querySelectorAll('[data-show]').forEach(f => (f.hidden = !show[f.dataset.show]));
      const preview = {
        type: t, dim: form.dim.value, grain: form.grain.value, measure: form.measure.value,
        agg: form.measure.value === '__count' ? 'count' : form.agg.value
      };
      form.wtitle.placeholder = autoTitle(preview, ds);
    };
    form.labels.addEventListener('change', () => (form.labels.dataset.touched = '1'));
    form.querySelectorAll('input[name=type]').forEach(r => r.addEventListener('change', () => {
      if (!form.labels.dataset.touched) form.labels.value = defaultLabels(form.type.value);
    }));
    form.querySelectorAll('input[name=type], select').forEach(x => x.addEventListener('change', () => {
      // ao escolher uma data em "Analisar por", ordena cronologicamente
      if (x.name === 'dim' && cols.find(c => c.name === x.value)?.type === 'date') { form.sort.value = 'label'; form.top.value = '0'; }
      refresh();
    }));
    refresh();
  }

  // ---------------- janela: escolher filtros ----------------
  function chooseFilters() {
    const checked = new Set(cfg.filterCols);
    const item = (value, label, extra = '') => `
      <label class="check"><input type="checkbox" name="f" value="${esc(value)}" ${checked.has(value) ? 'checked' : ''}>
        <span>${esc(label)}</span>${extra}</label>`;
    const body = `
      <p class="muted">Marque as colunas que devem aparecer como filtro no topo do painel.</p>
      ${dateCols.length ? `
        <h4>Datas</h4>
        <label class="field"><span>Coluna de data usada nos filtros</span>
          <select name="dateCol">${dateCols.map(c => opt(c.name, c.name, c.name === cfg.dateCol)).join('')}</select></label>
        <div class="check-list">${item('__year', 'Ano')}${item('__month', 'Mês')}</div>` : ''}
      <h4>Colunas</h4>
      <div class="check-list">${textCols.map(c => {
        const k = distinct(allRows, c.name, allRows.length).size;
        return item(c.name, c.name, `<small class="muted">${nf.format(k)} valores${k > 500 ? ' · mostra os 500 primeiros' : ''}</small>`);
      }).join('') || '<span class="muted">Nenhuma coluna de texto.</span>'}</div>`;

    openModal('Filtros do painel', body, 'Aplicar', form => {
      const chosen = [...form.querySelectorAll('input[name=f]:checked')].map(i => i.value);
      // mantém a ordem anterior e acrescenta os novos no fim
      cfg.filterCols = [...cfg.filterCols.filter(c => chosen.includes(c)), ...chosen.filter(c => !cfg.filterCols.includes(c))];
      if (form.dateCol) cfg.dateCol = form.dateCol.value;
      for (const k of Object.keys(cfg.filters)) if (!chosen.includes(k) && (k === '__year' || k === '__month')) delete cfg.filters[k];
      markDirty(); draw();
    });
  }

  draw();
  const ro = new ResizeObserver(() => {
    if (!document.body.contains(el)) { ro.disconnect(); return; }
    layout();
  });
  ro.observe(el);
  return { destroy: () => { ro.disconnect(); charts.forEach(c => c.destroy()); } };
}

// ---------------- utilitários ----------------
function openModal(title, bodyHtml, okLabel, onOk) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <form class="modal card" novalidate>
      <header><h2>${esc(title)}</h2><button type="button" class="x" aria-label="Fechar">×</button></header>
      <div class="modal-body">${bodyHtml}</div>
      <footer><button type="button" class="btn ghost" data-close>Cancelar</button><button type="submit" class="btn">${esc(okLabel)}</button></footer>
    </form>`;
  document.body.append(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.querySelectorAll('.x,[data-close]').forEach(b => b.addEventListener('click', close));
  const form = back.querySelector('form');
  form.addEventListener('submit', e => { e.preventDefault(); onOk(form); close(); });
  setTimeout(() => form.querySelector('input:not([type=radio]):not([type=checkbox]), select')?.focus(), 30);
  return back;
}

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
    const s = v == null ? '' : t === 'number' ? String(v).replace('.', ',') : t === 'date' ? fmtCell(v, t) : String(v);
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
