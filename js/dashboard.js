// =============================================================
//  Painel personalizável
//  - Modo visualização: filtros, clique no gráfico para filtrar
//  - Modo edição: adicionar/editar/duplicar/excluir gráficos,
//    escolher filtros, arrastar para mover e puxar o canto
//    para redimensionar
// =============================================================

import { isCodeName, toNumber } from './parser.js?v=31';
import { compile, formatValue, FORMATS, FUNCTIONS_HELP } from './formula.js?v=31';
import { buildModel } from './model.js?v=31';
import { ColTable } from './coltable.js?v=31';

const PALETTE = ['#2563eb', '#0d9488', '#f59e0b', '#db2777', '#7c3aed', '#16a34a', '#ea580c', '#0891b2', '#64748b'];
const AGG = { sum: 'Soma', avg: 'Média', max: 'Máximo', min: 'Mínimo', count: 'Contagem', countd: 'Contagem distinta' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const GRAINS = { month: 'Mês', year: 'Ano', day: 'Dia' };
export const TYPES = {
  kpi: { label: 'Indicador', icon: '123', h: 130 },
  gauge: { label: 'Medidor', icon: '◠', h: 250 },
  bar: { label: 'Colunas', icon: '▮▮', h: 320 },
  hbar: { label: 'Barras', icon: '☰', h: 320 },
  line: { label: 'Linha', icon: '⟋', h: 300 },
  area: { label: 'Área', icon: '◭', h: 300 },
  pie: { label: 'Pizza', icon: '◕', h: 320 },
  doughnut: { label: 'Rosca', icon: '◎', h: 320 },
  table: { label: 'Tabela resumo', icon: '▤', h: 320 },
  pivot: { label: 'Tabela dinâmica', icon: '⊞', h: 400 },
  datatable: { label: 'Tabela de dados', icon: '▦', h: 420 },
  filterpane: { label: 'Painel de filtro', icon: '☷', h: 300 }
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
// formatador de cada gráfico, guardado fora das opções do Chart.js (que chamaria a função com outro argumento)
const FMT_BY_CANVAS = new WeakMap();
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
      const f = FMT_BY_CANVAS.get(chart.canvas) || fmtLabel;
      const text = o.mode === 'percent' ? pctTxt : o.mode === 'both' ? `${f(v)} (${pctTxt})` : f(v);
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
const asTable = (ds, rows) => rows instanceof ColTable ? rows : ColTable.fromRows(ds.columns || [], rows || []);

export function suggestConfig(ds, rows, pref = {}) {
  const T = asTable(ds, rows);
  const byType = t => ds.columns.filter(c => c.type === t);
  const text = byType('text'), nums = byType('number'), dates = byType('date');
  const card = c => T.cardinality(c.name);
  const isCode = c => /(^|_)(cod|codigo|id|nota|doc|nf|num|pedido|serie)(_|$)/i.test(c.name);
  const good = text.filter(c => !isCode(c) && card(c) > 1 && card(c) <= 60);
  const dim = pref.dim || (good.find(c => /categ|grupo|famil|segment|regiao|estado|uf|vendedor|canal|tipo/i.test(c.name))
    || good[0] || text[0] || dates[0])?.name || null;
  // códigos (nota, documento, pedido…) nunca viram medida, mesmo se vierem como número
  const meas = nums.filter(c => !isCodeName(c.name));
  const measure = pref.measure || (meas.find(c => /valor|total|venda|receita|fatur/i.test(c.name))
    || meas.find(c => /saldo|custo|preco|preço/i.test(c.name))
    || meas.find(c => /qtd|quant/i.test(c.name) && !c.name.startsWith('Qtd_Registros')) || meas[0])?.name || '__count';
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
  // painel resumido na importação: a quantidade real de registros está em Qtd_Registros
  const countCol = nums.find(c => c.name.startsWith('Qtd_Registros'));
  widgets.push(countCol
    ? w('kpi', { w: 3, measure: countCol.name, agg: 'sum', format: 'integer', title: 'Registros' })
    : w('kpi', { w: measure === '__count' ? 12 : 3, measure: '__count', agg: 'count', title: 'Quantidade de linhas' }));
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
// seleções: { campo: [valor, valor...] } — aceita o formato antigo { campo: 'valor' }
function normFilters(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) {
    const arr = (Array.isArray(v) ? v : [v]).filter(x => x !== '' && x != null).map(String);
    if (arr.length) out[k] = [...new Set(arr)];
  }
  return out;
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

// ---------- itens mestres ----------
let MASTERS = [], COLUMNS = [];
const masterOf = w => (w.measure || '').startsWith('m:') ? MASTERS.find(m => m.id === w.measure.slice(2)) || { missing: true, name: '(item mestre excluído)', expr: '' } : null;
const compiledOf = m => m.missing ? { error: 'excluído' } : compile(m.expr, COLUMNS);
const fmtOf = w => (w.format && w.format !== 'auto') ? w.format : (masterOf(w)?.format || 'number');
const fv = (w, v, short) => formatValue(v, fmtOf(w), short);

// subconjunto de posições que passam no teste
const subset = (idx, test) => { const out = new Uint32Array(idx.length); let k = 0; for (let j = 0; j < idx.length; j++) { const i = idx[j]; if (test(i)) out[k++] = i; } return out.subarray(0, k); };

// acumula medida simples (soma/média/mín/máx/contagem) por grupo
function simpleAcc(w) {
  const groups = new Map();
  return {
    add(k, v) {
      let a = groups.get(k);
      if (!a) { a = { sum: 0, n: 0, cnt: 0, min: Infinity, max: -Infinity, set: w.agg === 'countd' ? new Set() : null }; groups.set(k, a); }
      if (w.measure === '__count' || (v !== null && v !== undefined)) a.cnt++;
      if (a.set && v !== null && v !== undefined) a.set.add(v);
      if (typeof v === 'number' && v === v) { a.sum += v; a.n++; if (v < a.min) a.min = v; if (v > a.max) a.max = v; }
    },
    result: () => [...groups].map(([k, a]) => [k, accValue(a, w)])
  };
}
function accValue(a, w) {
  if (w.measure === '__count' || w.agg === 'count') return a.cnt;
  if (w.agg === 'countd') return a.set ? a.set.size : 0;
  if (!a.n) return 0;
  return w.agg === 'avg' ? a.sum / a.n : w.agg === 'min' ? a.min : w.agg === 'max' ? a.max : a.sum;
}

// caminho geral: keyFn(posição) -> chave ou lista de chaves (dimensão vinda de outra tabela)
function aggregate(T, idx, keyFn, w) {
  const master = masterOf(w);
  if (master) {
    const c = compiledOf(master);
    if (c.error) return [];
    const fn = c.bind(T);
    const groups = new Map();
    const put = (k, i) => { if (k === null) return; let g = groups.get(k); if (!g) { g = []; groups.set(k, g); } g.push(i); };
    for (let j = 0; j < idx.length; j++) { const i = idx[j]; const ks = keyFn(i); if (Array.isArray(ks)) for (const k of ks) put(k, i); else put(ks, i); }
    return [...groups].map(([k, arr]) => [k, fn(arr)]);
  }
  const get = w.measure === '__count' ? () => 1 : T.getter(w.measure);
  const acc = simpleAcc(w);
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j]; const ks = keyFn(i); const v = get(i);
    if (Array.isArray(ks)) { for (const k of ks) if (k !== null) acc.add(k, v); } else if (ks !== null) acc.add(ks, v);
  }
  return acc.result();
}

// caminho rápido: dimensão é coluna-dicionário da mesma tabela -> agrupa pelos códigos
function aggregateByCode(T, idx, dimName, keyOfValue, w) {
  const c = T.col(dimName);
  const D = c.dict.length, codes = c.codes;
  const slotOf = new Int32Array(D).fill(-1);
  const keys = [], keyPos = new Map();
  for (let k = 0; k < D; k++) {
    const key = keyOfValue(c.dict[k]);
    if (key === null) continue;
    let sl = keyPos.get(key);
    if (sl === undefined) { sl = keys.length; keys.push(key); keyPos.set(key, sl); }
    slotOf[k] = sl;
  }
  const G = keys.length;
  const master = masterOf(w);
  if (master) {
    const cc = compiledOf(master);
    if (cc.error) return [];
    const fn = cc.bind(T);
    const cnt = new Uint32Array(G);
    for (let j = 0; j < idx.length; j++) { const sl = slotOf[codes[idx[j]]]; if (sl >= 0) cnt[sl]++; }
    const start = new Uint32Array(G + 1);
    for (let sl = 0; sl < G; sl++) start[sl + 1] = start[sl] + cnt[sl];
    const pos = start.slice(0, G), order = new Uint32Array(start[G]);
    for (let j = 0; j < idx.length; j++) { const i = idx[j]; const sl = slotOf[codes[i]]; if (sl >= 0) order[pos[sl]++] = i; }
    const out = [];
    for (let sl = 0; sl < G; sl++) if (cnt[sl]) out.push([keys[sl], fn(order.subarray(start[sl], start[sl + 1]))]);
    return out;
  }
  const num = w.measure === '__count' ? null : T.col(w.measure)?.num;
  const get = !num && w.measure !== '__count' ? T.getter(w.measure) : null;
  const cnt = new Float64Array(G), sum = new Float64Array(G), n = new Float64Array(G);
  const mn = new Float64Array(G).fill(Infinity), mx = new Float64Array(G).fill(-Infinity);
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j]; const sl = slotOf[codes[i]];
    if (sl < 0) continue;
    cnt[sl]++;
    const v = num ? num[i] : get ? get(i) : NaN;
    if (typeof v === 'number' && v === v) { sum[sl] += v; n[sl]++; if (v < mn[sl]) mn[sl] = v; if (v > mx[sl]) mx[sl] = v; }
  }
  const out = [];
  for (let sl = 0; sl < G; sl++) if (cnt[sl]) out.push([keys[sl], accValue({ cnt: cnt[sl], sum: sum[sl], n: n[sl], min: mn[sl], max: mx[sl] }, w)]);
  return out;
}

const isAdditive = w => {
  const m = masterOf(w);
  if (m) return !!compiledOf(m).additive;
  return w.measure === '__count' || w.agg === 'sum' || w.agg === 'count';   // contagem distinta não soma entre grupos
};
const measureLabel = w => masterOf(w)?.name || (w.measure === '__count' ? 'Quantidade de linhas' : `${AGG[w.agg]} de ${w.measure}`);
// valor único de um conjunto de posições (KPI e comparativos)
function valueOf(T, idx, w) {
  const master = masterOf(w);
  if (master) { const c = compiledOf(master); return c.error ? null : c.bind(T)(idx); }
  const r = aggregate(T, idx, () => 'all', w)[0];
  return r ? r[1] : 0;
}

// ---------- comparativos de período ----------
export const PERIODS = { all: 'Tudo (conforme filtros)', month: 'Último mês com dados', ytd: 'Acumulado do ano' };
export const COMPARES = { none: 'Não comparar', prev: 'Período anterior', yoy: 'Mesmo período do ano anterior' };
const pad2 = n => String(n).padStart(2, '0');
function shiftMonth(ym, delta) { let [y, m] = ym.split('-').map(Number); m += delta; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${pad2(m)}`; }
// devolve { test(iso), label } para o período pedido em relação à data de referência
function periodWindow(ref, period, compare) {
  const y = +ref.slice(0, 4), ym = ref.slice(0, 7), md = ref.slice(5);
  const mlabel = k => `${MONTHS[+k.slice(5, 7) - 1]}/${k.slice(2, 4)}`;
  if (period === 'month') {
    const k = compare === 'prev' ? shiftMonth(ym, -1) : compare === 'yoy' ? shiftMonth(ym, -12) : ym;
    return { test: d => d && d.slice(0, 7) === k, label: mlabel(k) };
  }
  if (period === 'ytd') {
    const yy = compare ? y - 1 : y; // no acumulado, "anterior" e "ano anterior" são o mesmo período do ano passado
    const end = `${yy}-${md}`;
    return { test: d => d && d >= `${yy}-01-01` && d <= end, label: `jan–${MONTHS[+md.slice(0, 2) - 1]}/${String(yy).slice(2)}` };
  }
  return null;
}

function autoTitle(w, ds) {
  if (w.type === 'datatable') return 'Dados';
  if (w.type === 'filterpane') return 'Filtros';
  if (w.type === 'kpi' || w.type === 'gauge') return measureLabel(w);
  if (w.type === 'pivot') return `${measureLabel(w)} por ${[w.dim, w.dim2].filter(Boolean).join(' / ') || '—'}${w.pcol ? ' × ' + w.pcol : ''}`;
  const dimCol = (COLUMNS.length ? COLUMNS : ds.columns).find(c => c.name === w.dim);
  const by = dimCol?.type === 'date' ? `${w.dim} (${GRAINS[w.grain || 'month'].toLowerCase()})` : w.dim;
  return `${measureLabel(w)} por ${by || '—'}`;
}

// agrupa, ordena e limita os dados de um gráfico
// T/idx: tabela da medida e posições selecionadas; valuesOf: dimensão vinda de outra tabela (ou null)
function groupData(T, idx, w, dimCol, valuesOf) {
  if (!dimCol) return { labels: [], keys: [], values: [], isDate: false };
  const isDate = dimCol.type === 'date';
  const grain = w.grain || 'month';
  const keyOfValue = isDate ? v => dateKey(v, grain) : v => v ?? '(vazio)';
  let g;
  if (!valuesOf && T.col(w.dim)?.dict && w.agg !== 'countd' && !(w.agg === 'count' && w.measure !== '__count')) g = aggregateByCode(T, idx, w.dim, keyOfValue, w);
  else {
    const vals = valuesOf || (() => { const gt = T.getter(w.dim); return i => [gt(i)]; })();
    g = aggregate(T, idx, isDate
      ? i => vals(i).map(v => dateKey(v, grain))
      : i => { const vs = vals(i); return vs.length ? vs.map(v => v ?? '(vazio)') : ['(sem ligação)']; }, w);
  }
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
export function mountDashboard(el, ds, data, savedCfg, onSave) {
  const model = buildModel(ds, data);
  const mainT = model.primary.t;
  const PID = model.primary.id;
  let saved = normalizeConfig(savedCfg, { ...ds, columns: model.primary.columns }, mainT);
  let cfg = clone(saved);
  let editing = false;

  // ---------- pastas (abas): cada pasta tem seus gráficos; seleções valem para todas ----------
  const ensureSheets = c => {
    if (!c.sheets || !c.sheets.length) c.sheets = [{ id: uid(), name: 'Pasta 1', widgets: c.widgets || [] }];
    delete c.widgets;
    return c;
  };
  ensureSheets(saved); ensureSheets(cfg);
  let sheetIdx = 0;
  cfg.widgets = cfg.sheets[0].widgets;                    // gráficos da pasta ativa
  const syncSheet = () => { cfg.sheets[sheetIdx].widgets = cfg.widgets; };
  const openSheet = i => { syncSheet(); sheetIdx = clamp(i, 0, cfg.sheets.length - 1); cfg.widgets = cfg.sheets[sheetIdx].widgets; };
  const forSave = () => { syncSheet(); const c = clone(cfg); delete c.widgets; return c; };
  const allWidgets = () => { syncSheet(); return cfg.sheets.flatMap(sh => sh.widgets); };
  const resetFromSaved = () => { cfg = clone(saved); sheetIdx = clamp(sheetIdx, 0, cfg.sheets.length - 1); cfg.widgets = cfg.sheets[sheetIdx].widgets; };
  let dirty = false;
  const charts = new Map();

  const cols = model.fields;                       // campos de todas as tabelas
  const tableHint = c => model.multi ? ` · ${c.tables.map(id => model.byId[id].name).join(', ')}` : '';
  const textCols = cols.filter(c => c.type === 'text');
  const dateCols = cols.filter(c => c.type === 'date');
  const numCols = cols.filter(c => c.type === 'number');
  if (cfg.dateCol && !dateCols.find(c => c.name === cfg.dateCol)) cfg.dateCol = dateCols[0]?.name || null;
  cfg.filters = normFilters(cfg.filters);
  cfg.masters = cfg.masters || [];
  saved.masters = saved.masters || [];
  saved.filters = normFilters(saved.filters);

  // ---------- seleções: histórico para voltar/avançar ----------
  let history = [], future = [];
  const fieldLabel = c => c === '__year' ? 'Ano' : c === '__month' ? 'Mês' : c;
  const valueLabel = (c, v) => c === '__month' ? (MONTHS_FULL[+v - 1] || v) : v;
  function allValues(c) {
    if (c === '__year') return [...new Set([...model.distinctValues(cfg.dateCol)].map(d => (d || '').slice(0, 4)).filter(Boolean))].sort();
    if (c === '__month') return MONTHS_FULL.map((_, i) => String(i + 1).padStart(2, '0'));
    return [...model.distinctValues(c)].map(v => String(v ?? '(vazio)')).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  }
  // valores de um campo que ainda são possíveis com as seleções dos OUTROS campos (null = todos)
  function possibleValues(c) {
    const others = Object.fromEntries(Object.entries(cfg.filters).filter(([k, v]) => k !== c && v && v.length));
    if (!Object.keys(others).length) return null;
    const st = model.select(others, cfg.dateCol);
    const field = c === '__year' || c === '__month' ? cfg.dateCol : c;
    const out = new Set();
    for (const tid of model.tablesOf(field)) {
      const t = model.byId[tid].t, idx = st[tid], col = t.col(field);
      if (!idx) continue;
      if (col.dict && field === c) {
        const seen = new Uint8Array(col.dict.length);
        for (let j = 0; j < idx.length; j++) seen[col.codes[idx[j]]] = 1;
        seen.forEach((f, k) => { if (f) out.add(String(col.dict[k] ?? '(vazio)')); });
      } else {
        const g = t.getter(field);
        for (let j = 0; j < idx.length; j++) {
          const v = g(idx[j]);
          if (c === '__year') { if (v) out.add(String(v).slice(0, 4)); }
          else if (c === '__month') { if (v) out.add(String(v).slice(5, 7)); }
          else out.add(String(v ?? '(vazio)'));
        }
      }
    }
    return out;
  }
  const fpSearch = new Map();   // texto da busca de cada campo do painel de filtro (sobrevive ao redesenho)

  function setFilters(next) {
    next = normFilters(next);
    if (JSON.stringify(next) === JSON.stringify(cfg.filters)) return;
    history.push(clone(cfg.filters));
    if (history.length > 50) history.shift();
    future = [];
    cfg.filters = next;
    if (editing) markDirty();
    draw();
  }

  // ---------- desfazer / refazer do modo edição ----------
  // guarda o layout antes de cada mudança (posição, tamanho, gráficos, escolha de filtros)
  let undoStack = [], redoStack = [], lastSnap = null;
  const snapshot = () => { syncSheet(); return clone({ sheets: cfg.sheets, sheetIdx, filterCols: cfg.filterCols, dateCol: cfg.dateCol, masters: cfg.masters }); };
  const restore = snap => {
    cfg.sheets = clone(snap.sheets); sheetIdx = clamp(snap.sheetIdx || 0, 0, cfg.sheets.length - 1); cfg.widgets = cfg.sheets[sheetIdx].widgets;
    cfg.filterCols = clone(snap.filterCols); cfg.dateCol = snap.dateCol; cfg.masters = clone(snap.masters || []);
  };
  function resetUndo() { undoStack = []; redoStack = []; lastSnap = snapshot(); }
  function markDirty() {
    dirty = true;
    if (!editing || !lastSnap) return;
    const now = snapshot();
    if (JSON.stringify(now) === JSON.stringify(lastSnap)) return; // só seleção mudou: não entra no histórico
    undoStack.push(lastSnap);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    lastSnap = now;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    lastSnap = snapshot();
    dirty = true;
    draw();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    lastSnap = snapshot();
    dirty = true;
    draw();
  }
  const onKeyUndo = e => {
    if (!document.body.contains(el)) { document.removeEventListener('keydown', onKeyUndo); return; }
    if (!editing) return;
    if (document.querySelector('.modal-back')) return;                 // janela aberta: o Ctrl+Z é do campo de texto
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  };
  document.addEventListener('keydown', onKeyUndo);
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;

  function draw() {
    MASTERS = cfg.masters; COLUMNS = cols;
    charts.forEach(c => c.destroy());
    charts.clear();
    const state = model.select(cfg.filters, cfg.dateCol);
    const rows = state[PID] || new Uint32Array(0);

    // ----- barra superior -----
    const toolbar = editing ? `
      <div class="dash-toolbar card editing-bar">
        <div class="hint">✎ <strong>Modo edição</strong> — arraste o gráfico pelo título para qualquer lugar e puxe o canto ◢ para mudar o tamanho.</div>
        <div class="undo-group">
          <button class="btn ghost icon" data-act="undo" title="Desfazer (Ctrl+Z)" ${undoStack.length ? '' : 'disabled'}>↶</button>
          <button class="btn ghost icon" data-act="redo" title="Refazer (Ctrl+Y)" ${redoStack.length ? '' : 'disabled'}>↷</button>
        </div>
        <button class="btn ghost" data-act="filters">⚲ Escolher filtros</button>
        <button class="btn ghost" data-act="masters">ƒ Itens mestres</button>
        <button class="btn ghost" data-act="add">+ Adicionar gráfico</button>
        <button class="btn ghost" data-act="cancel">Cancelar</button>
        <button class="btn" data-act="save">Salvar</button>
      </div>` : `
      <div class="view-actions">
        <button class="btn ghost small" data-act="export" title="Exportar as linhas selecionadas em CSV">⤓ CSV</button>
        ${onSave ? '<button class="btn small" data-act="edit">✎ Editar</button>' : ''}
      </div>`;

    // ----- abas das pastas -----
    const nSheets = cfg.sheets.length;
    const tabs = (nSheets > 1 || editing) ? `
      <div class="sheet-tabs">
        <div class="sheet-list">${cfg.sheets.map((sh, i) => `<button class="sheet-tab ${i === sheetIdx ? 'active' : ''}" data-sheet="${i}" ${editing ? 'title="Duplo clique para renomear"' : ''}>${esc(sh.name)}</button>`).join('')}</div>
        ${editing ? `<div class="sheet-tools">
          <button data-shact="add" title="Nova pasta">+ Pasta</button>
          <button data-shact="rename" title="Renomear pasta">✎</button>
          <button data-shact="dup" title="Duplicar pasta">⧉</button>
          <button data-shact="left" title="Mover para a esquerda" ${sheetIdx === 0 ? 'disabled' : ''}>◀</button>
          <button data-shact="right" title="Mover para a direita" ${sheetIdx === nSheets - 1 ? 'disabled' : ''}>▶</button>
          <button data-shact="del" title="Excluir pasta" ${nSheets < 2 ? 'disabled' : ''}>🗑</button>
        </div>` : ''}
      </div>` : '';

    // fora da edição, os filtros viram pílulas dentro da barra de seleções (uma linha só)
    const filterPills = cfg.filterCols.map(c => {
      if ((c === '__year' || c === '__month') && !cfg.dateCol) return '';
      if (!c.startsWith('__') && !cols.find(x => x.name === c)) return '';
      if (cfg.filters[c]?.length) return '';   // já aparece como seleção
      return `<button type="button" class="filter-pill" data-field="${esc(c)}">${esc(fieldLabel(c))} <i>▾</i></button>`;
    }).join('');
    // ----- barra de seleções atuais -----
    const selEntries = Object.entries(cfg.filters);
    const selChips = selEntries.map(([c, vals]) => {
      const total = allValues(c).length;
      const text = vals.length <= 2 ? vals.map(v => valueLabel(c, v)).join(', ') : `${vals.length} de ${total}`;
      return `<div class="sel-chip" data-field="${esc(c)}" title="${esc(vals.map(v => valueLabel(c, v)).join(', '))}">
        <span class="sel-field">${esc(fieldLabel(c))}</span>
        <span class="sel-vals">${esc(text)}</span>
        <button class="sel-x" data-unsel="${esc(c)}" title="Limpar ${esc(fieldLabel(c))}">×</button>
      </div>`;
    }).join('');
    const selBar = `
      <div class="sel-bar">
        <div class="sel-nav">
          <button data-sel="back" title="Voltar à seleção anterior" ${history.length ? '' : 'disabled'}>↶</button>
          <button data-sel="fwd" title="Avançar" ${future.length ? '' : 'disabled'}>↷</button>
          <button data-sel="clear" title="Limpar todas as seleções" ${selEntries.length ? '' : 'disabled'}>⌫</button>
        </div>
        <div class="sel-items">${selChips || '<span class="sel-empty">Nenhuma seleção</span>'}${!editing ? filterPills : ''}</div>
        <span class="rowcount" title="${model.multi ? esc(model.tables.map(t => `${t.name}: ${nf.format(state[t.id].length)} de ${nf.format(t.n)}`).join(' · ')) : ''}">${nf.format(rows.length)} de ${nf.format(mainT.n)} linhas${model.multi ? ` · ${model.tables.length} tabelas` : ''}</span>
        ${!editing ? toolbar : ''}
      </div>`;

    // ----- filtros (lista com seleção múltipla) -----
    const filterBtns = cfg.filterCols.map(c => {
      if ((c === '__year' || c === '__month') && !cfg.dateCol) return '';
      if (!c.startsWith('__') && !cols.find(x => x.name === c)) return '';
      const vals = cfg.filters[c] || [];
      const summary = !vals.length ? 'Todos' : vals.length === 1 ? valueLabel(c, vals[0]) : `${vals.length} selecionados`;
      return `<div class="field"><span>${esc(fieldLabel(c))}</span>
        <button type="button" class="filter-dd ${vals.length ? 'active' : ''}" data-field="${esc(c)}"><span>${esc(summary)}</span><i>▾</i></button></div>`;
    }).join('');
    const filterBar = editing ? `
      <div class="filters card">
        ${filterBtns || '<span class="muted">Nenhum filtro escolhido. Clique em "Escolher filtros".</span>'}
      </div>` : '';

    el.innerHTML = `${editing ? toolbar : ''}${tabs}${selBar}${filterBar}
      <div class="dash-canvas ${editing ? 'editing' : ''}">
        ${editing ? '<div class="grid-bg"></div><div class="drop-ghost" hidden></div>' : ''}
        ${cfg.widgets.map(w => widgetHtml(w)).join('')}
      </div>
      ${!cfg.widgets.length && !editing ? `<div class="card empty"><p>${nSheets > 1 ? 'Esta pasta' : 'Este app'} está vazio. ${onSave ? 'Clique em <strong>Editar</strong> para adicionar gráficos.' : ''}</p></div>` : ''}`;

    layout();
    const dateless = { filters: Object.fromEntries(Object.entries(cfg.filters).filter(([k]) => k !== '__year' && k !== '__month')) };
    const ctx = { state, stateNoDate: model.select(dateless.filters, cfg.dateCol) };
    if (fsId) markFs();   // tela cheia continua no mesmo gráfico depois de redesenhar
    cfg.widgets.forEach(w => fillWidget(w, rows, ctx));
    bindEvents();
    bindViewTools();
  }

  // ---------- tela cheia e exportar imagem / PDF ----------
  const LIBS = {};
  const loadLib = (url, global) => LIBS[url] || (LIBS[url] = new Promise((ok, fail) => {
    const g = () => global.split('.').reduce((o, k) => o && o[k], window);
    if (g()) return ok(g());
    const sc = document.createElement('script');
    sc.src = url; sc.onload = () => ok(g()); sc.onerror = () => { delete LIBS[url]; fail(new Error('Não foi possível carregar ' + url)); };
    document.head.append(sc);
  }));
  const H2C = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
  const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
  const fileName = t => (t || 'grafico').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
  async function snapWidget(sec) {
    const html2canvas = await loadLib(H2C, 'html2canvas');
    return html2canvas(sec, {
      scale: 2, backgroundColor: '#ffffff', logging: false,
      ignoreElements: n => n.classList && (n.classList.contains('w-tools') || n.classList.contains('w-resize') || n.classList.contains('export-menu'))
    });
  }
  async function exportWidget(w, sec, kind) {
    const title = w.title || autoTitle(w, ds);
    try {
      document.body.classList.add('busy');
      const canvas = await snapWidget(sec);
      if (kind === 'png') {
        const a = document.createElement('a');
        a.download = fileName(title) + '.png';
        a.href = canvas.toDataURL('image/png');
        a.click();
      } else {
        const { jsPDF } = await loadLib(JSPDF, 'jspdf');
        const land = canvas.width >= canvas.height;
        const pdf = new jsPDF({ orientation: land ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
        const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight(), m = 12;
        pdf.setFontSize(9); pdf.setTextColor(120);
        pdf.text(`${ds.name} · ${new Date().toLocaleString('pt-BR')}`, m, ph - 6);
        const k = Math.min((pw - 2 * m) / canvas.width, (ph - 2 * m - 6) / canvas.height);
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', m, m, canvas.width * k, canvas.height * k);   // JPEG: arquivo bem menor
        pdf.save(fileName(title) + '.pdf');
      }
    } catch (e) {
      console.error(e);
      alert('Não foi possível exportar agora. Verifique a internet e tente de novo.');
    } finally { document.body.classList.remove('busy'); }
  }
  function bindViewTools() {
    if (editing) return;
    el.querySelectorAll('.widget[data-id]').forEach(sec => {
      const w = allWidgets().find(x => x.id === sec.dataset.id);
      if (!w) return;
      sec.querySelector('[data-wv="full"]')?.addEventListener('click', () => {
        if (fsId) { exitFs(); return; }
        // tela cheia do painel inteiro (que não é recriado), mostrando só este gráfico + a barra de seleções
        fsId = w.id;
        el.classList.add('dash-fs');
        markFs();
        if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
        setTimeout(() => { charts.get(w.id)?.resize(); refitPanes(); }, 80);
      });
      sec.querySelector('[data-wv="export"]')?.addEventListener('click', e => {
        e.stopPropagation();
        document.querySelector('.export-menu')?.remove();
        const menu = document.createElement('div');
        menu.className = 'export-menu card';
        menu.innerHTML = '<button data-x="png">🖼 Imagem (PNG)</button><button data-x="pdf">📄 PDF</button>';
        sec.querySelector('.w-head').append(menu);
        menu.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', ev => { ev.stopPropagation(); menu.remove(); exportWidget(w, sec, b.dataset.x); }));
        setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
      });
    });
  }
  // ao entrar/sair da tela cheia, os gráficos se ajustam ao novo tamanho
  let fsId = null;
  function markFs() { el.querySelectorAll('.widget[data-id]').forEach(x => x.classList.toggle('fs-target', x.dataset.id === fsId)); }
  function exitFs() {
    fsId = null;
    el.classList.remove('dash-fs');
    markFs();
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    setTimeout(() => { charts.forEach(c => c.resize()); refitPanes(); }, 80);
  }
  const onKeyFs = e => { if (e.key === 'Escape' && fsId && !document.fullscreenElement) exitFs(); };
  document.addEventListener('keydown', onKeyFs);
  const refitPanes = () => el.querySelectorAll('.widget.w-filterpane').forEach(sec => {
    const w = allWidgets().find(x => x.id === sec.dataset.id);
    if (w) fillFilterPane(w, sec.querySelector('.w-body'));
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && fsId) { exitFs(); return; }
    setTimeout(() => { charts.forEach(c => c.resize()); refitPanes(); }, 80);
  });
  let refitTimer;
  window.addEventListener('resize', () => { clearTimeout(refitTimer); refitTimer = setTimeout(() => { if (el.isConnected) refitPanes(); }, 200); });

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
          </div>` : `<div class="w-tools w-view">
            <button data-wv="full" title="Tela cheia">⛶</button>
            <button data-wv="export" title="Exportar como imagem ou PDF">⤓</button>
          </div>`}
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

  // meta do indicador/medidor: valor fixo ou outra medida (campo ou item mestre), com as seleções atuais
  function targetOf(w, ctx) {
    if (!w.target) return null;
    if (w.target === '__value') {
      const raw = String(w.targetValue ?? '').trim();
      if (!raw) return null;
      const x = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : toNumber(raw);
      return Number.isFinite(x) ? x : null;
    }
    const tw = { measure: w.target, agg: 'sum' };
    const m = masterOf(tw);
    if (m && compiledOf(m).error) return null;
    const used = m ? compiledOf(m).fields : [w.target];
    const tt = model.measureTable(used, null);
    return tt ? valueOf(tt.t, ctx.state[tt.id], tw) : null;
  }
  const goalColor = p => p >= 1 ? '#16a34a' : p >= .8 ? '#f59e0b' : '#dc2626';
  const pivotOpen = new Map();   // tabela dinâmica: grupos recolhidos (por gráfico)

  function fillWidget(w, rows, ctx) {  // rows: linhas da tabela principal; trocadas pela tabela da medida abaixo
    const body = el.querySelector(`.widget[data-id="${w.id}"] .w-body`);
    if (!body) return;
    const color = PALETTE[w.color || 0] || PALETTE[0];
    const master = masterOf(w);
    if (master && compiledOf(master).error) {
      body.innerHTML = `<div class="muted center small">Item mestre com problema: ${esc(master.missing ? 'foi excluído' : compiledOf(master).error)}</div>`;
      return;
    }

    if (w.type === 'filterpane') { fillFilterPane(w, body); return; }

    if (w.type === 'datatable' && Array.isArray(w.fields) && w.fields.some(n => !(model.byId[w.table] || model.primary).columns.some(c => c.name === n))) {
      fillMultiTable(w, body, ctx); return;
    }
    if (w.type === 'datatable') {
      const t = model.byId[w.table] || model.primary;
      const tRows = ctx.state[t.id];
      // campos escolhidos na edição (na ordem escolhida); sem escolha = todos
      const picked = Array.isArray(w.fields) ? w.fields.map(n => t.columns.find(c => c.name === n)).filter(Boolean) : [];
      const tcols = picked.length ? picked : t.columns;
      const gs = tcols.map(c => t.t.getter(c.name));
      body.innerHTML = `<div class="table-wrap fill"><table>
        <thead><tr>${tcols.map(c => `<th class="${c.type}">${esc(c.name)}</th>`).join('')}</tr></thead>
        <tbody>${Array.from(tRows.subarray(0, 200), i => `<tr>${tcols.map((c, j) => `<td class="${c.type}">${esc(fmtCell(gs[j](i), c.type))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>${tRows.length > 200 ? `<div class="muted small">Mostrando 200 de ${nf.format(tRows.length)} linhas. Use "Exportar CSV" para ver tudo.</div>` : ''}`;
      return;
    }

    // em qual tabela a medida é calculada (a que tem todos os campos dela)
    const used = master ? compiledOf(master).fields : (w.measure === '__count' ? [] : [w.measure]);
    const mt = model.measureTable(used, w.type === 'kpi' ? null : w.dim);
    const gone = used.filter(f => !model.tablesOf(f).length);
    if (gone.length) {
      body.innerHTML = `<div class="muted center small">O campo ${esc(gone.join(', '))} não existe mais neste app (a tabela pode ter sido removida). Edite o gráfico e escolha outra medida.</div>`;
      return;
    }
    if (!mt) {
      const where = used.map(f => `${f} (${model.tablesOf(f).map(id => model.byId[id].name).join('/') || '?'})`).join(', ');
      body.innerHTML = `<div class="muted center small">A medida usa campos de tabelas diferentes: ${esc(where)}. Monte a fórmula com campos de uma tabela só.</div>`;
      return;
    }
    rows = ctx.state[mt.id];
    const rowsNoDate = ctx.stateNoDate[mt.id];

    if (w.type === 'kpi') {
      const dcol = cfg.dateCol;
      const period = dcol && model.pathTo(mt.id, dcol) ? (w.period || 'all') : 'all';
      const dateIn = st => { const f = model.resolver(st, mt.id, dcol); return r => f(r)[0]; };
      let v, sub = '';
      if (period === 'all') {
        v = valueOf(mt.t, rows, w);
      } else {
        // data de referência = a mais recente nas linhas filtradas
        let ref = '';
        const dNow = dateIn(ctx.state);
        for (let j = 0; j < rows.length; j++) { const d = dNow(rows[j]); if (d && d > ref) ref = d; }
        const dAll = dateIn(ctx.stateNoDate);
        if (!ref) { body.innerHTML = '<div class="muted center small">Sem datas no filtro atual.</div>'; return; }
        const cur = periodWindow(ref, period);
        v = valueOf(mt.t, subset(rowsNoDate, i => cur.test(dAll(i))), w);
        sub = `<div class="kpi-period">${esc(cur.label)}</div>`;
        if (w.compare && w.compare !== 'none') {
          const prev = periodWindow(ref, period, w.compare);
          const pv = valueOf(mt.t, subset(rowsNoDate, i => prev.test(dAll(i))), w);
          const delta = (pv === null || v === null || pv === 0) ? null : (v - pv) / Math.abs(pv);
          const cls = delta === null ? '' : delta >= 0 ? 'up' : 'down';
          const deltaTxt = delta === null ? '—' : `${delta >= 0 ? '▲' : '▼'} ${formatValue(Math.abs(delta), 'percent')}`;
          sub = `<div class="kpi-compare"><span class="delta ${cls}">${deltaTxt}</span> vs ${esc(prev.label)} <span class="muted">(${esc(fv(w, pv, true))})</span></div>${sub}`;
        }
      }
      const tgt = targetOf(w, ctx);
      if (tgt !== null && tgt !== 0 && v !== null) {
        const pct = v / tgt, diff = pct - 1;
        sub += `<div class="kpi-goal">
          <div class="goal-bar"><span style="width:${Math.min(100, Math.max(0, pct * 100))}%;background:${goalColor(pct)}"></span></div>
          <div class="goal-txt"><span class="delta ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '▲' : '▼'} ${formatValue(Math.abs(diff), 'percent')}</span> ${diff >= 0 ? 'acima' : 'abaixo'} da meta <span class="muted">(${esc(fv(w, tgt, true))} · ${formatValue(pct, 'percent')} atingido)</span></div>
        </div>`;
      }
      body.innerHTML = `<div class="kpi-val" style="color:${color}" title="${esc(fv(w, v))}">${esc(fv(w, v, true))}</div>${sub}`;
      return;
    }

    if (w.type === 'gauge') {
      const v = valueOf(mt.t, rows, w);
      const tgt = targetOf(w, ctx);
      if (tgt === null || !tgt) { body.innerHTML = '<div class="muted center small">Defina a meta do medidor: Editar gráfico → Meta.</div>'; return; }
      if (!window.Chart) { body.innerHTML = '<div class="muted center">Biblioteca de gráficos não carregou.</div>'; return; }
      const pct = v === null ? 0 : v / tgt;
      const fill = Math.max(0, Math.min(1, pct));
      const gc = goalColor(pct);
      body.innerHTML = `<div class="gauge">
        <div class="chart-box"><canvas></canvas></div>
        <div class="gauge-center"><div class="gauge-val" style="color:${gc}" title="${esc(fv(w, v))}">${esc(fv(w, v, true))}</div>
          <div class="gauge-pct"><span class="delta ${pct >= 1 ? 'up' : 'down'}">${pct >= 1 ? '▲' : '▼'}</span> ${formatValue(pct, 'percent')} da meta</div></div>
        <div class="gauge-scale"><span>0</span><span>Meta: ${esc(fv(w, tgt, true))}</span></div>
      </div>`;
      const chart = new Chart(body.querySelector('canvas'), {
        type: 'doughnut',
        data: { datasets: [{ data: [fill, 1 - fill], backgroundColor: [gc, '#e2e8f0'], borderWidth: 0 }] },
        options: { maintainAspectRatio: false, rotation: -90, circumference: 180, cutout: '74%', events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } } }
      });
      charts.set(w.id, chart);
      return;
    }

    if (w.type === 'pivot') { fillPivot(w, body, mt, rows, ctx); return; }
    const dimCol = cols.find(c => c.name === w.dim);
    const g = groupData(mt.t, rows, w, dimCol, dimCol && !model.has(mt.id, w.dim) ? model.resolver(ctx.state, mt.id, w.dim) : null);
    if (!g.values.length) { body.innerHTML = '<div class="muted center">Sem dados para este filtro.</div>'; return; }

    if (w.type === 'table') {
      const total = g.values.reduce((s, v) => s + (v || 0), 0);
      const max = Math.max(...g.values.map(v => Math.abs(v || 0))) || 1;
      body.innerHTML = `<div class="table-wrap fill"><table class="summary">
        <thead><tr><th>${esc(w.dim)}</th><th class="number">${esc(measureLabel(w))}</th>${isAdditive(w) ? '<th class="number">%</th>' : ''}</tr></thead>
        <tbody>${g.labels.map((l, i) => `<tr data-key="${esc(g.keys[i])}" class="${g.isDate ? '' : 'clickable'}">
          <td><div class="bar-cell"><span style="width:${Math.abs(g.values[i] || 0) / max * 100}%;background:${color}22"></span>${esc(l)}</div></td>
          <td class="number">${esc(fv(w, g.values[i]))}</td>
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
    FMT_BY_CANVAS.set(canvas, v => fv(w, v, true));
    const pie = w.type === 'pie' || w.type === 'doughnut';
    const line = w.type === 'line' || w.type === 'area';
    const onClick = (evt, els) => {
      if (editing || g.isDate || !els.length) return;
      const key = g.keys[els[0].index];
      // adia para depois do Chart.js terminar de tratar o clique
      if (key !== '__outros') setTimeout(() => toggleFilter(w.dim, String(key)), 0);
    };
    const tooltip = { callbacks: { label: c => ` ${pie ? c.label + ': ' : ''}${fv(w, c.raw)}` } };
    const fmtShort = v => fv(w, v, true);
    const axisTick = function (v) { const l = this.type === 'category' ? this.getLabelForValue(v) : v; return typeof l === 'number' ? fmtShort(l) : String(l).slice(0, 20); };
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
          scales: { x: { grid: { display: w.type === 'hbar' }, ticks: { callback: axisTick } }, y: { grid: { color: '#eef2f7', display: w.type !== 'hbar' }, ticks: { callback: axisTick } } }
        }
      });
    }
    charts.set(w.id, chart);
  }

  // ---------- tabela de dados com campos de várias tabelas ligadas ----------
  // parte da tabela com mais linhas entre as que têm os campos (em geral a de movimento, ex.: Vendas)
  // e busca os campos das outras pelas ligações, respeitando as seleções
  function fillMultiTable(w, body, ctx) {
    const picked = w.fields.map(n => cols.find(c => c.name === n)).filter(Boolean);
    if (!picked.length) { body.innerHTML = '<div class="muted center small">Escolha os campos: Editar → ✎ na tabela → Campos.</div>'; return; }
    const cands = model.tables.filter(t => picked.some(c => model.has(t.id, c.name)));
    const base = cands.sort((a, b) => b.n - a.n)[0];
    const rows = ctx.state[base.id];
    const gets = picked.map(c => {
      if (model.has(base.id, c.name)) { const g = base.t.getter(c.name); return i => [g(i)]; }
      return model.pathTo(base.id, c.name) ? model.resolver(ctx.state, base.id, c.name) : () => [];
    });
    const LIMIT = 200;
    const out = [];
    let multi = false, total = 0;
    for (let j = 0; j < rows.length && out.length < LIMIT; j++) {
      const i = rows[j];
      // um valor por campo; se a ligação trouxer vários (ex.: 1 cliente com 2 vendedores), vira uma linha para cada
      let combos = [[]];
      for (const f of gets) {
        const vs = f(i);
        const list = vs.length ? vs : [null];
        if (list.length > 1) multi = true;
        combos = combos.flatMap(cmb => list.map(v => [...cmb, v]));
        if (combos.length > LIMIT) combos = combos.slice(0, LIMIT);
      }
      for (const cmb of combos) { if (out.length < LIMIT) out.push(cmb); }
    }
    total = rows.length;
    const unlinked = picked.filter((c, k) => !model.has(base.id, c.name) && !model.pathTo(base.id, c.name));
    body.innerHTML = `<div class="table-wrap fill"><table>
        <thead><tr>${picked.map(c => `<th class="${c.type}" title="${esc(c.tables.map(id => model.byId[id].name).join(', '))}">${esc(c.name)}${model.multi ? `<small class="th-table">${esc(model.byId[c.tables[0]].name)}</small>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${out.map(r => `<tr>${r.map((v, k) => `<td class="${picked[k].type}">${v === null || v === undefined ? '<span class="muted">—</span>' : esc(fmtCell(v, picked[k].type))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div class="muted small">${total > LIMIT || out.length >= LIMIT ? `Mostrando ${LIMIT} linhas de ${nf.format(total)} registros de ${esc(base.name)}.` : `${nf.format(total)} registro(s) de ${esc(base.name)}.`}${multi ? ' Alguns registros têm mais de um valor ligado e aparecem em mais de uma linha.' : ''}${unlinked.length ? ` ⚠ Sem ligação com ${esc(base.name)}: ${esc(unlinked.map(c => c.name).join(', '))}.` : ''}</div>`;
  }

  // ---------- painel de filtro: listas de valores na pasta (verde = selecionado, branco = possível, cinza = excluído) ----------
  function fillFilterPane(w, body) {
    const valid = c => (c === '__year' || c === '__month') ? !!cfg.dateCol : !!cols.find(x => x.name === c);
    const fields = (Array.isArray(w.fields) ? w.fields : []).filter(valid);
    if (!fields.length) { body.innerHTML = '<div class="muted center small">Escolha os campos do painel: Editar → ✎ no painel → Campos.</div>'; return; }
    // sem espaço para as listas abertas: cada campo vira uma linha compacta que abre a lista (como no Qlik)
    const W = body.clientWidth || 300, H = body.clientHeight || 300;
    const perRow = Math.max(1, Math.min(fields.length, Math.floor((W + 10) / 170)));
    const rowsN = Math.ceil(fields.length / perRow);
    if ((H - (rowsN - 1) * 10) / rowsN < 120) {
      body.innerHTML = `<div class="fp-compact">${fields.map(c => {
        const sel = cfg.filters[c] || [];
        const txt = !sel.length ? 'Todos' : sel.length === 1 ? valueLabel(c, sel[0]) : `${sel.length} de ${nf.format(allValues(c).length)}`;
        return `<button type="button" class="fp-pill ${sel.length ? 'on' : ''}" data-field="${esc(c)}"><strong>${esc(fieldLabel(c))}</strong><span>${esc(txt)}</span><i>▾</i></button>`;
      }).join('')}</div>`;
      body.querySelectorAll('.fp-pill').forEach(b => b.addEventListener('click', () => openListbox(b.dataset.field, b)));
      return;
    }
    body.innerHTML = `<div class="fp">${fields.map((c, n) => {
      const values = allValues(c);
      const sel = new Set(cfg.filters[c] || []);
      const poss = possibleValues(c);
      const state = v => sel.has(v) ? 'sel' : (poss && !poss.has(v)) ? 'excl' : sel.size ? 'alt' : 'poss';
      const rank = { sel: 0, poss: 1, alt: 1, excl: 2 };
      const q = (fpSearch.get(w.id + '|' + c) || '').toLowerCase();
      const list = values.filter(v => !q || String(valueLabel(c, v)).toLowerCase().includes(q))
        .map(v => [v, state(v)]).sort((a, b) => rank[a[1]] - rank[b[1]]);
      return `<div class="fp-field">
        <div class="fp-head"><strong title="${esc(fieldLabel(c))}">${esc(fieldLabel(c))}</strong>
          ${sel.size ? `<span class="fp-count">${sel.size}</span><button type="button" class="fp-clear" data-fpclear="${n}" title="Limpar ${esc(fieldLabel(c))}">×</button>` : ''}</div>
        ${values.length > 6 ? `<input class="fp-search" data-fps="${n}" placeholder="Pesquisar…" value="${esc(fpSearch.get(w.id + '|' + c) || '')}">` : ''}
        <div class="fp-list">${list.slice(0, 500).map(([v, st]) => `<div class="fp-v ${st}" data-fpv="${n}" data-v="${esc(v)}" title="${esc(valueLabel(c, v))}">${esc(valueLabel(c, v))}</div>`).join('')}
          ${list.length > 500 ? `<div class="muted small">+${nf.format(list.length - 500)} — use a pesquisa</div>` : ''}${!list.length ? '<div class="muted small">Nada encontrado.</div>' : ''}</div>
      </div>`;
    }).join('')}</div>`;
    body.querySelectorAll('[data-fpv]').forEach(d => d.addEventListener('click', () => toggleFilter(fields[+d.dataset.fpv], d.dataset.v)));
    body.querySelectorAll('[data-fpclear]').forEach(b => b.addEventListener('click', () => setFilters({ ...cfg.filters, [fields[+b.dataset.fpclear]]: [] })));
    body.querySelectorAll('[data-fps]').forEach(inp => inp.addEventListener('input', () => {
      const n = +inp.dataset.fps, key = w.id + '|' + fields[n];
      fpSearch.set(key, inp.value);
      const pos = inp.selectionStart;
      fillFilterPane(w, body);
      const again = body.querySelector(`[data-fps="${n}"]`);
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }));
  }

  // ---------- tabela dinâmica: linhas (com sub-linhas e subtotais) × colunas ----------
  function fillPivot(w, body, mt, rows, ctx) {
    const grain = w.grain || 'month';
    const keyer = name => {
      if (!name) return null;
      const c = cols.find(x => x.name === name);
      if (!c) return null;
      const vals = model.has(mt.id, name) ? (g => i => [g(i)])(mt.t.getter(name)) : model.resolver(ctx.state, mt.id, name);
      const isDate = c.type === 'date';
      return {
        name, isDate,
        keys: isDate ? i => vals(i).map(v => dateKey(v, grain)) : i => { const vs = vals(i); return vs.length ? vs.map(v => v ?? '(vazio)') : ['(sem ligação)']; },
        label: k => isDate ? dateLabel(k, grain) : String(k)
      };
    };
    const K1 = keyer(w.dim), K2 = keyer(w.dim2), KC = keyer(w.pcol);
    if (!K1) { body.innerHTML = '<div class="muted center small">Escolha o campo das linhas.</div>'; return; }
    const A = '\u0002', S = '\u0001';
    const buckets = new Map(), kids = new Map(), colSet = new Set();
    const put = (k, i) => { let a = buckets.get(k); if (!a) { a = []; buckets.set(k, a); } a.push(i); };
    for (let j = 0; j < rows.length; j++) {
      const i = rows[j];
      const a1 = K1.keys(i), a2 = K2 ? K2.keys(i) : [A], ac = KC ? KC.keys(i) : [A];
      const set = new Set();
      for (const k1 of a1) {
        if (!kids.has(k1)) kids.set(k1, new Set());
        for (const k2 of a2) {
          if (K2) kids.get(k1).add(k2);
          for (const kc of ac) {
            if (KC) colSet.add(kc);
            set.add(k1 + S + k2 + S + kc); set.add(k1 + S + A + S + kc); set.add(k1 + S + k2 + S + A);
            set.add(k1 + S + A + S + A); set.add(A + S + A + S + kc); set.add(A + S + A + S + A);
          }
        }
      }
      for (const k of set) put(k, i);
    }
    if (!kids.size) { body.innerHTML = '<div class="muted center">Sem dados para este filtro.</div>'; return; }
    const cache = new Map();
    const val = (k1, k2, kc) => {
      const k = k1 + S + k2 + S + kc;
      if (cache.has(k)) return cache.get(k);
      const a = buckets.get(k);
      const v = a ? valueOf(mt.t, Uint32Array.from(a), w) : null;
      cache.set(k, v); return v;
    };
    const byLabel = (a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
    const sort = w.sort || 'label';
    const order = (list, total) => sort === 'label' ? list.sort(byLabel) : list.sort((a, b) => sort === 'asc' ? (total(a) ?? 0) - (total(b) ?? 0) : (total(b) ?? 0) - (total(a) ?? 0));
    const MAXC = 40, MAX1 = 300, MAX2 = 200;
    const allCols = KC ? [...colSet].sort(byLabel) : [];
    const colKeys = allCols.slice(0, MAXC);
    const l1 = order([...kids.keys()], k1 => val(k1, A, A));
    const closed = pivotOpen.get(w.id) || new Set();
    pivotOpen.set(w.id, closed);
    const cells = (k1, k2) => (KC ? colKeys.map(kc => `<td class="number">${esc(fv(w, val(k1, k2, kc)))}</td>`).join('') : '') + `<td class="number pv-tot">${esc(fv(w, val(k1, k2, A)))}</td>`;
    const head = `<tr><th>${esc(K1.name)}${K2 ? ` <span class="muted">/ ${esc(K2.name)}</span>` : ''}</th>${KC ? colKeys.map(kc => `<th class="number">${esc(KC.label(kc))}</th>`).join('') : ''}<th class="number">${KC ? 'Total' : esc(measureLabel(w))}</th></tr>`;
    let html = '';
    l1.slice(0, MAX1).forEach((k1, n) => {
      const sub = K2 ? order([...kids.get(k1)], k2 => val(k1, k2, A)) : [];
      const isClosed = closed.has(String(k1));
      html += `<tr class="pv-l1 ${K2 ? 'pv-grp' : ''}" data-g="${n}">
        <td>${K2 ? `<button type="button" class="pv-tog" data-g="${n}">${isClosed ? '▸' : '▾'}</button>` : ''}<span class="pv-lbl ${K1.isDate ? '' : 'clickable'}" data-f="1" data-key="${esc(k1)}">${esc(K1.label(k1))}</span>${K2 ? ` <small class="muted">(${sub.length})</small>` : ''}</td>${cells(k1, A)}</tr>`;
      sub.slice(0, MAX2).forEach(k2 => {
        html += `<tr class="pv-l2" data-p="${n}" ${isClosed ? 'hidden' : ''}><td><span class="pv-lbl ${K2.isDate ? '' : 'clickable'}" data-f="2" data-key="${esc(k2)}">${esc(K2.label(k2))}</span></td>${cells(k1, k2)}</tr>`;
      });
    });
    html += `<tr class="pv-total"><td>Total geral</td>${cells(A, A)}</tr>`;
    const notes = [l1.length > MAX1 ? `mostrando ${MAX1} de ${nf.format(l1.length)} linhas` : '', allCols.length > MAXC ? `mostrando ${MAXC} de ${allCols.length} colunas` : ''].filter(Boolean);
    body.innerHTML = `${K2 ? '<div class="pv-tools"><button type="button" class="btn link" data-pv="open">Expandir tudo</button><button type="button" class="btn link" data-pv="close">Recolher tudo</button></div>' : ''}
      <div class="table-wrap fill"><table class="pivot"><thead>${head}</thead><tbody>${html}</tbody></table></div>
      ${notes.length ? `<div class="muted small">${notes.join(' · ')}</div>` : ''}`;
    const keysByIdx = l1.slice(0, MAX1).map(String);
    const setOpen = (n, open) => {
      const k = keysByIdx[n];
      if (open) closed.delete(k); else closed.add(k);
      body.querySelectorAll(`tr[data-p="${n}"]`).forEach(tr => { tr.hidden = !open; });
      const b = body.querySelector(`.pv-tog[data-g="${n}"]`); if (b) b.textContent = open ? '▾' : '▸';
    };
    body.querySelectorAll('.pv-tog').forEach(b => b.addEventListener('click', () => setOpen(+b.dataset.g, closed.has(keysByIdx[+b.dataset.g]))));
    body.querySelectorAll('[data-pv]').forEach(b => b.addEventListener('click', () => keysByIdx.forEach((_, n) => setOpen(n, b.dataset.pv === 'open'))));
    body.querySelectorAll('.pv-lbl.clickable').forEach(sp => sp.addEventListener('click', () => {
      if (editing) return;
      toggleFilter(sp.dataset.f === '1' ? K1.name : K2.name, sp.dataset.key);
    }));
  }

  function toggleFilter(col, value) {
    const cur = cfg.filters[col] || [];
    const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
    setFilters({ ...cfg.filters, [col]: next });
  }

  // lista de valores de um campo (listbox)
  function openListbox(c, anchor) {
    document.querySelector('.listbox')?.remove();
    const box = document.createElement('div');
    box.className = 'listbox card';
    const r = anchor.getBoundingClientRect();
    box.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
    box.style.top = Math.min(r.bottom + 4, window.innerHeight - 380) + 'px';
    box.innerHTML = `
      <div class="lb-head"><strong>${esc(fieldLabel(c))}</strong><button class="lb-close" title="Fechar">×</button></div>
      <input class="lb-search" placeholder="Pesquisar…">
      <div class="lb-list"></div>
      <div class="lb-foot"><button class="btn link" data-lb="all">Selecionar visíveis</button><button class="btn link" data-lb="none">Limpar</button></div>`;
    document.body.append(box);
    const values = allValues(c);
    const search = box.querySelector('.lb-search');
    const list = box.querySelector('.lb-list');
    const visible = () => { const q = search.value.trim().toLowerCase(); return values.filter(v => !q || valueLabel(c, v).toLowerCase().includes(q)); };
    const poss = possibleValues(c);
    const paint = () => {
      const sel = new Set(cfg.filters[c] || []);
      const rank = v => sel.has(v) ? 0 : poss && !poss.has(v) ? 2 : 1;
      const vis = visible().sort((a, b) => rank(a) - rank(b));
      list.innerHTML = vis.slice(0, 1000).map(v => `
        <label class="lb-item ${sel.has(v) ? 'selected' : poss && !poss.has(v) ? 'excl' : ''}"><input type="checkbox" value="${esc(v)}" ${sel.has(v) ? 'checked' : ''}><span>${esc(valueLabel(c, v))}</span></label>`).join('')
        + (vis.length > 1000 ? `<div class="muted small">Mostrando 1.000 de ${nf.format(vis.length)}. Use a pesquisa.</div>` : '')
        + (!vis.length ? '<div class="muted small">Nada encontrado.</div>' : '');
    };
    paint();
    list.addEventListener('change', e => { toggleFilter(c, e.target.value); paint(); });
    search.addEventListener('input', paint);
    box.querySelector('[data-lb="all"]').addEventListener('click', () => {
      setFilters({ ...cfg.filters, [c]: [...new Set([...(cfg.filters[c] || []), ...visible()])] }); paint();
    });
    box.querySelector('[data-lb="none"]').addEventListener('click', () => { setFilters({ ...cfg.filters, [c]: [] }); paint(); });
    const close = () => { box.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey); };
    const outside = e => { if (!box.contains(e.target) && !e.target.closest(`[data-field="${CSS.escape(c)}"]`)) close(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    box.querySelector('.lb-close').addEventListener('click', close);
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', onKey); search.focus(); }, 0);
  }

  // ---------------- eventos ----------------
  function bindEvents() {
    const act = (name, fn) => el.querySelectorAll(`[data-act="${name}"]`).forEach(b => b.addEventListener('click', fn));
    act('edit', () => { editing = true; dirty = false; resetUndo(); draw(); });
    act('undo', undo);
    act('redo', redo);
    el.querySelectorAll('[data-sheet]').forEach(b => {
      b.addEventListener('click', () => { openSheet(+b.dataset.sheet); if (editing) lastSnap = snapshot(); draw(); });
      b.addEventListener('dblclick', () => { if (editing) renameSheet(); });
    });
    const renameSheet = () => {
      const name = prompt('Nome da pasta:', cfg.sheets[sheetIdx].name);
      if (name && name.trim()) { cfg.sheets[sheetIdx].name = name.trim().slice(0, 40); markDirty(); draw(); }
    };
    el.querySelectorAll('[data-shact]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.shact;
      syncSheet();
      if (a === 'add') {
        cfg.sheets.splice(sheetIdx + 1, 0, { id: uid(), name: `Pasta ${cfg.sheets.length + 1}`, widgets: [] });
        openSheet(sheetIdx + 1);
      } else if (a === 'dup') {
        const cur = cfg.sheets[sheetIdx];
        cfg.sheets.splice(sheetIdx + 1, 0, { id: uid(), name: `${cur.name} (cópia)`, widgets: clone(cur.widgets).map(w => ({ ...w, id: uid() })) });
        openSheet(sheetIdx + 1);
      } else if (a === 'rename') return renameSheet();
      else if (a === 'left' || a === 'right') {
        const j = sheetIdx + (a === 'left' ? -1 : 1);
        [cfg.sheets[sheetIdx], cfg.sheets[j]] = [cfg.sheets[j], cfg.sheets[sheetIdx]];
        sheetIdx = j; cfg.widgets = cfg.sheets[sheetIdx].widgets;
      } else if (a === 'del') {
        if (cfg.sheets.length < 2) return;
        if (!confirm(`Excluir a pasta "${cfg.sheets[sheetIdx].name}" e os gráficos dela?`)) return;
        cfg.sheets.splice(sheetIdx, 1);
        sheetIdx = clamp(sheetIdx, 0, cfg.sheets.length - 1); cfg.widgets = cfg.sheets[sheetIdx].widgets;
      }
      markDirty(); draw();
    }));
    act('cancel', () => {
      if (dirty && !confirm('Descartar as alterações?')) return;
      resetFromSaved(); editing = false; draw();
    });
    act('save', async e => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const out = forSave();
        await onSave(out);
        saved = clone(out); editing = false; dirty = false; resetUndo(); draw();
      } catch { btn.disabled = false; }
    });
    act('export', () => exportCSV(ds.name, mainT, model.select(cfg.filters, cfg.dateCol)[PID]));
    el.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.sel;
      if (a === 'clear') return setFilters({});
      if (a === 'back' && history.length) { future.push(clone(cfg.filters)); cfg.filters = history.pop(); }
      if (a === 'fwd' && future.length) { history.push(clone(cfg.filters)); cfg.filters = future.pop(); }
      if (editing) markDirty();
      draw();
    }));
    el.querySelectorAll('[data-unsel]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation(); setFilters({ ...cfg.filters, [b.dataset.unsel]: [] });
    }));
    el.querySelectorAll('.sel-chip').forEach(ch => ch.addEventListener('click', () => openListbox(ch.dataset.field, ch)));
    el.querySelectorAll('.filter-dd, .filter-pill').forEach(b => b.addEventListener('click', () => openListbox(b.dataset.field, b)));
    act('add', () => editWidget(null));
    act('filters', chooseFilters);
    act('masters', manageMasters);
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
    const mainW = allWidgets().find(x => x.measure && x.measure !== '__count' && x.agg !== 'avg');
    const mainMeasure = mainW?.measure || numCols[0]?.name || '__count';
    const base = existing ? clone(existing) : {
      id: uid(), type: 'bar', title: '',
      dim: textCols[0]?.name || dateCols[0]?.name || null, grain: 'month',
      measure: mainMeasure, agg: mainMeasure === '__count' ? 'count' : 'sum',
      top: 10, sort: 'desc', color: 0
    };
    // qualquer campo pode ser dimensão; números (Ano, Mês…) ficam num grupo à parte
    const dimOpts = cols.filter(c => c.type !== 'number')
      .map(c => opt(c.name, c.name + (c.type === 'date' ? ' (data)' : '') + tableHint(c), c.name === base.dim)).join('')
      + (numCols.length ? `<optgroup label="Campos numéricos (ex.: Ano, Mês)">${numCols.map(c => opt(c.name, c.name + tableHint(c), c.name === base.dim)).join('')}</optgroup>` : '');
    const textMeasures = cols.filter(c => c.type !== 'number');
    function dimOptsFor(sel) {
      return cols.filter(c => c.type !== 'number').map(c => opt(c.name, c.name + (c.type === 'date' ? ' (data)' : '') + tableHint(c), c.name === sel)).join('')
        + (numCols.length ? `<optgroup label="Campos numéricos (ex.: Ano, Mês)">${numCols.map(c => opt(c.name, c.name + tableHint(c), c.name === sel)).join('')}</optgroup>` : '');
    }
    const targetOpts = opt('', 'Sem meta', !base.target) + opt('__value', 'Valor fixo…', base.target === '__value')
      + (cfg.masters.length ? `<optgroup label="Itens mestres">${cfg.masters.map(m => opt('m:' + m.id, 'ƒ ' + m.name, base.target === 'm:' + m.id)).join('')}</optgroup>` : '')
      + (numCols.length ? `<optgroup label="Soma de um campo (ex.: tabela de metas)">${numCols.map(c => opt(c.name, c.name + tableHint(c), c.name === base.target)).join('')}</optgroup>` : '');
    const body = `
      <div class="type-picker">${Object.entries(TYPES).map(([k, t]) => `
        <label class="type-opt"><input type="radio" name="type" value="${k}" ${k === base.type ? 'checked' : ''}>
          <span class="ti">${t.icon}</span><span>${t.label}</span></label>`).join('')}
      </div>
      <label class="field"><span>Título do gráfico</span><input name="wtitle" value="${esc(base.title)}" placeholder="${esc(autoTitle(base, ds))}"></label>
      <div class="form-grid">
        <label class="field" data-show="dim"><span>Analisar por</span><select name="dim">${dimOpts}</select></label>
        <label class="field" data-show="dim2"><span>Sub-linhas <small class="muted">(opcional, com subtotal)</small></span><select name="dim2">${opt('', '— nenhuma —', !base.dim2)}${dimOptsFor(base.dim2)}</select></label>
        <label class="field" data-show="pcol"><span>Colunas <small class="muted">(opcional)</small></span><select name="pcol">${opt('', '— nenhuma —', !base.pcol)}${dimOptsFor(base.pcol)}</select></label>
        <label class="field" data-show="grain"><span>Agrupar data por</span><select name="grain">${Object.entries(GRAINS).map(([k, v]) => opt(k, v, k === (base.grain || 'month'))).join('')}</select></label>
        <label class="field" data-show="measure"><span>Medida</span><select name="measure">
          ${cfg.masters.length ? `<optgroup label="Itens mestres">${cfg.masters.map(m => opt('m:' + m.id, 'ƒ ' + m.name, base.measure === 'm:' + m.id)).join('')}</optgroup>` : ''}
          <optgroup label="Campos">
          ${opt('__count', 'Quantidade de linhas', base.measure === '__count')}
          ${numCols.map(c => opt(c.name, c.name + tableHint(c), c.name === base.measure)).join('')}</optgroup>
          ${textMeasures.length ? `<optgroup label="Contar valores (texto e datas)">${textMeasures.map(c => opt(c.name, c.name + tableHint(c), c.name === base.measure)).join('')}</optgroup>` : ''}</select></label>
        ${model.multi ? `<label class="field" data-show="table"><span>Tabela</span><select name="wtable">${model.tables.map(t => opt(t.id, t.name, t.id === (base.table || PID))).join('')}</select></label>` : ''}
        <div class="field dt-fields" data-show="fields">
          <span><span id="dt-title">Campos da tabela</span> <small class="muted" id="dt-count"></small></span>
          <div class="dt-tools">
            <input type="search" id="dt-search" placeholder="Buscar campo…">
            <button type="button" class="btn ghost small" id="dt-all">Todos</button>
            <button type="button" class="btn ghost small" id="dt-none">Nenhum</button>
          </div>
          <ul class="dt-list" id="dt-list"></ul>
          <small class="muted">Marque os campos que quer ver. Use ↑ ↓ para mudar a ordem das colunas.</small>
        </div>
        <label class="field" data-show="target"><span>Meta</span><select name="target">${targetOpts}</select></label>
        <label class="field" data-show="targetValue"><span>Valor da meta</span><input name="targetValue" inputmode="decimal" value="${esc(base.targetValue ?? '')}" placeholder="Ex.: 1.500.000"></label>
        <label class="field" data-show="agg"><span>Cálculo</span><select name="agg">${Object.entries(AGG).map(([k, v]) => opt(k, v, k === base.agg)).join('')}</select></label>
        <label class="field" data-show="top"><span>Mostrar</span><select name="top">
          ${[[0, 'Todos os itens'], [5, 'Top 5'], [10, 'Top 10'], [15, 'Top 15'], [20, 'Top 20'], [30, 'Top 30'], [50, 'Top 50']].map(([v, l]) => opt(v, l, +base.top === v)).join('')}</select></label>
        <label class="field" data-show="format"><span>Formato do número</span><select name="format">
          ${Object.entries(FORMATS).map(([k, v]) => opt(k, v, k === (base.format || 'auto'))).join('')}</select></label>
        <label class="field" data-show="period"><span>Período do indicador</span><select name="period">
          ${Object.entries(PERIODS).map(([k, v]) => opt(k, v, k === (base.period || 'all'))).join('')}</select></label>
        <label class="field" data-show="compare"><span>Comparar com</span><select name="compare">
          ${Object.entries(COMPARES).map(([k, v]) => opt(k, v, k === (base.compare || 'none'))).join('')}</select></label>
        <label class="field" data-show="sort"><span>Ordenar por</span><select name="sort">
          ${opt('desc', 'Maior valor primeiro', base.sort === 'desc')}${opt('asc', 'Menor valor primeiro', base.sort === 'asc')}${opt('label', 'Nome / data (A→Z)', base.sort === 'label')}</select></label>
      </div>
      <label class="field" data-show="labels"><span>Rótulos de dados</span><select name="labels">
        ${Object.entries(LABELS).map(([k, v]) => opt(k, v, k === labelsOf(base))).join('')}</select></label>
      <div class="field" data-show="color"><span>Cor</span><div class="swatches">${PALETTE.map((c, i) => `
        <label><input type="radio" name="color" value="${i}" ${i === (base.color || 0) ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>`;

    const isTextField = m => !!m && m !== '__count' && !m.startsWith('m:') && cols.some(c => c.name === m && c.type !== 'number');
    const aggFor = (m, a) => m === '__count' ? 'count' : isTextField(m) && !['count', 'countd'].includes(a) ? 'countd' : a;
    const modal = openModal(isNew ? 'Adicionar gráfico' : 'Editar gráfico', body, isNew ? 'Adicionar' : 'Aplicar', form => {
      const t = form.type.value;
      const w = {
        ...base, type: t, title: form.wtitle.value.trim(), dim: form.dim.value || null, grain: form.grain.value,
        measure: form.measure.value, agg: aggFor(form.measure.value, form.agg.value),
        top: +form.top.value, sort: form.sort.value, color: +(form.color.value || 0), labels: form.labels.value,
        format: form.format.value, period: form.period.value, compare: form.period.value === 'all' ? 'none' : form.compare.value,
        table: form.wtable ? form.wtable.value : PID,
        fields: t === 'datatable' || t === 'filterpane' ? dtPicked() : base.fields,
        dim2: t === 'pivot' ? (form.dim2.value || null) : base.dim2,
        pcol: t === 'pivot' ? (form.pcol.value || null) : base.pcol,
        target: ['kpi', 'gauge'].includes(t) ? (form.target.value || null) : base.target,
        targetValue: ['kpi', 'gauge'].includes(t) ? form.targetValue.value.trim() : base.targetValue
      };
      if (isNew) {
        w.gw = t === 'kpi' || t === 'filterpane' ? 6 : t === 'datatable' ? COLS : 12;
        w.gh = Math.round((TYPES[t].h + GAP) / ROW);
        Object.assign(w, findFree(w.gw, w.gh));
        cfg.widgets.push(w);
      } else {
        cfg.widgets[cfg.widgets.findIndex(x => x.id === existing.id)] = w;
      }
      // indicador com período/comparação precisa de mais altura para as linhas extras
      const kpiBase = w.compare && w.compare !== 'none' ? 18 : (w.period && w.period !== 'all') ? 16 : 0;
      const minGh = t === 'kpi' ? (w.target ? Math.max(kpiBase, 15) + 6 : kpiBase) : t === 'gauge' ? 20 : 0;
      if (minGh && (w.gh || 0) < minGh) { w.gh = minGh; resolve(w); }
      markDirty(); draw();
    });

    const form = modal.querySelector('form');
    const refresh = () => {
      const t = form.type.value;
      // campo de texto como medida: só contagem ou contagem distinta
      const txt = isTextField(form.measure.value);
      [...form.agg.options].forEach(o => { o.disabled = txt && !['count', 'countd'].includes(o.value); });
      if (txt && !['count', 'countd'].includes(form.agg.value)) form.agg.value = 'countd';
      const dimCol = cols.find(c => c.name === form.dim.value);
      const isDateF = n => cols.find(c => c.name === n)?.type === 'date';
      const noChart = t === 'datatable' || t === 'filterpane';   // sem dimensão/medida
      const show = {
        dim: !['kpi', 'gauge', 'datatable', 'filterpane'].includes(t),
        dim2: t === 'pivot', pcol: t === 'pivot',
        target: t === 'kpi' || t === 'gauge',
        targetValue: (t === 'kpi' || t === 'gauge') && form.target.value === '__value',
        grain: !['kpi', 'gauge', 'datatable', 'filterpane'].includes(t) && (dimCol?.type === 'date' || (t === 'pivot' && (isDateF(form.dim2.value) || isDateF(form.pcol.value)))),
        measure: !noChart,
        agg: !noChart && form.measure.value !== '__count' && !form.measure.value.startsWith('m:'),
        format: !noChart,
        table: false,
        fields: t === 'datatable' || t === 'filterpane',
        period: t === 'kpi' && !!cfg.dateCol,
        compare: t === 'kpi' && !!cfg.dateCol && form.period.value !== 'all',
        top: !noChart && !['kpi', 'gauge', 'pivot'].includes(t),
        sort: !noChart && !['kpi', 'gauge'].includes(t),
        color: !noChart && !['table', 'pivot', 'gauge'].includes(t),
        labels: !noChart && !['kpi', 'gauge', 'table', 'pivot'].includes(t)
      };
      form.querySelectorAll('[data-show]').forEach(f => (f.hidden = !show[f.dataset.show]));
      form.querySelector('[data-show="dim"] > span').textContent = t === 'pivot' ? 'Linhas' : 'Analisar por';
      const preview = {
        type: t, dim: form.dim.value, grain: form.grain.value, measure: form.measure.value,
        agg: aggFor(form.measure.value, form.agg.value)
      };
      form.wtitle.placeholder = autoTitle(preview, ds);
    };
    form.labels.addEventListener('change', () => (form.labels.dataset.touched = '1'));
    form.querySelectorAll('input[name=type]').forEach(r => r.addEventListener('change', () => {
      if (!form.labels.dataset.touched) form.labels.value = defaultLabels(form.type.value);
      if (form.type.value === 'pivot' && !existing?.sort) form.sort.value = 'label';
    }));
    form.querySelectorAll('input[name=type], select').forEach(x => x.addEventListener('change', () => {
      // ao escolher uma data em "Analisar por", ordena cronologicamente
      if (x.name === 'dim' && cols.find(c => c.name === x.value)?.type === 'date') { form.sort.value = 'label'; form.top.value = '0'; }
      refresh();
    }));
    // ----- tabela de dados: escolher e ordenar campos -----
    const dtTable = () => model.byId[form.wtable ? form.wtable.value : PID] || model.primary;
    // painel de filtro: qualquer campo do app (+ Ano/Mês da data principal)
    const fpCols = [...(cfg.dateCol ? [{ name: '__year', type: 'text' }, { name: '__month', type: 'text' }] : []), ...cols];
    const isFP = () => form.type.value === 'filterpane';
    const isDT = () => form.type.value === 'datatable';
    const dtSource = () => isFP() ? { columns: fpCols } : { columns: cols };
    let dtOrder = [], dtSel = new Set();
    const dtReset = (t, fields, emptyDefault) => {
      const names = t.columns.map(c => c.name);
      const keep = Array.isArray(fields) ? fields.filter(n => names.includes(n)) : [];
      dtOrder = keep.length ? [...keep, ...names.filter(n => !keep.includes(n))] : names;
      dtSel = new Set(keep.length ? keep : emptyDefault || names);
    };
    const dtList = form.querySelector('#dt-list'), dtSearch = form.querySelector('#dt-search');
    const dtRender = () => {
      const t = dtSource();
      form.querySelector('#dt-title').textContent = isFP() ? 'Campos do filtro' : model.multi ? 'Campos (de qualquer tabela)' : 'Campos da tabela';
      const q = dtSearch.value.trim().toLowerCase();
      dtList.innerHTML = dtOrder.map((n, k) => {
        const c = t.columns.find(x => x.name === n);
        return `<li ${q && !n.toLowerCase().includes(q) ? 'hidden' : ''} class="${dtSel.has(n) ? 'on' : ''}">
          <label><input type="checkbox" data-dtf="${esc(n)}" ${dtSel.has(n) ? 'checked' : ''}> ${esc(fieldLabel(n))}${model.multi && c?.tables ? ` <small class="muted">${esc(c.tables.map(id => model.byId[id].name).join(', '))}</small>` : ''} <i class="tag ${c?.type}">${c?.type === 'number' ? 'número' : c?.type === 'date' ? 'data' : 'texto'}</i></label>
          <span class="dt-move"><button type="button" data-dtup="${k}" ${k ? '' : 'disabled'} title="Subir">↑</button><button type="button" data-dtdown="${k}" ${k < dtOrder.length - 1 ? '' : 'disabled'} title="Descer">↓</button></span>
        </li>`;
      }).join('');
      form.querySelector('#dt-count').textContent = `(${dtSel.size} de ${dtOrder.length})`;
    };
    // ordem final = ordem da lista, só os marcados; todos marcados na ordem original = sem escolha
    const dtPicked = () => {
      if (isFP() || isDT()) return dtOrder.filter(n => dtSel.has(n));
      const t = dtTable();
      const out = dtOrder.filter(n => dtSel.has(n));
      if (!out.length) return null;
      const all = t.columns.map(c => c.name);
      return out.length === all.length && out.every((n, k) => n === all[k]) ? null : out;
    };
    // campos sugeridos para um painel de filtro novo: os filtros do app ou os 3 primeiros campos de texto
    const fpDefault = () => (cfg.filterCols?.length ? cfg.filterCols : textCols.slice(0, 3).map(c => c.name)).filter(n => fpCols.some(c => c.name === n));
    const dtInit = () => {
      if (isFP()) dtReset(dtSource(), base.type === 'filterpane' ? base.fields : null, fpDefault());
      else {
        // tabela antiga (sem escolha): começa com os campos da tabela que ela mostrava
        const legacy = (model.byId[base.table] || model.primary).columns.map(c => c.name);
        const start = base.type === 'datatable' && Array.isArray(base.fields) && base.fields.length ? base.fields : legacy;
        dtReset(dtSource(), start, start);
      }
    };
    dtInit();
    dtRender();
    form.querySelectorAll('input[name=type]').forEach(r => r.addEventListener('change', () => { dtInit(); dtRender(); }));
    form.wtable?.addEventListener('change', () => { dtReset(dtTable(), null); dtRender(); });
    dtSearch.addEventListener('input', dtRender);
    dtSearch.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    form.querySelector('#dt-all').addEventListener('click', () => { dtOrder.forEach(n => { if (!dtSearch.value || n.toLowerCase().includes(dtSearch.value.trim().toLowerCase())) dtSel.add(n); }); dtRender(); });
    form.querySelector('#dt-none').addEventListener('click', () => { dtOrder.forEach(n => { if (!dtSearch.value || n.toLowerCase().includes(dtSearch.value.trim().toLowerCase())) dtSel.delete(n); }); dtRender(); });
    dtList.addEventListener('change', e => { const n = e.target.dataset.dtf; if (n === undefined) return; e.target.checked ? dtSel.add(n) : dtSel.delete(n); dtRender(); });
    dtList.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const k = +(b.dataset.dtup ?? b.dataset.dtdown), to = b.dataset.dtup !== undefined ? k - 1 : k + 1;
      if (to < 0 || to >= dtOrder.length) return;
      [dtOrder[k], dtOrder[to]] = [dtOrder[to], dtOrder[k]];
      dtRender();
    });
    refresh();
  }

  // ---------------- janela: itens mestres ----------------
  function manageMasters() {
    const usedBy = id => allWidgets().filter(w => w.measure === 'm:' + id).length;
    const body = `
      <p class="muted">Medidas com nome que você cria uma vez e usa em qualquer gráfico. Ex.: <code>Faturamento</code>, <code>Ticket médio</code>, <code>% da meta</code>.</p>
      <div class="master-list">${cfg.masters.map(m => {
        const c = compile(m.expr, cols);
        return `<div class="master-item">
          <div class="mi-main"><strong>ƒ ${esc(m.name)}</strong><code>${esc(m.expr)}</code>
            <small class="${c.error ? 'error' : 'muted'}">${c.error ? '⚠ ' + esc(c.error) : `${esc(FORMATS[m.format || 'number'])} · usado em ${usedBy(m.id)} gráfico(s)`}</small></div>
          <div class="row-actions"><button type="button" class="btn ghost small" data-medit="${m.id}">Editar</button>
            <button type="button" class="btn ghost small danger" data-mdel="${m.id}">Excluir</button></div>
        </div>`;
      }).join('') || '<div class="muted">Nenhum item mestre ainda.</div>'}</div>
      <button type="button" class="btn ghost" data-mnew>+ Novo item mestre</button>`;
    const modal = openModal('Itens mestres', body, 'Fechar', () => {});
    modal.querySelector('[data-close]').remove();
    modal.querySelector('[data-mnew]').addEventListener('click', () => { modal.remove(); editMaster(null); });
    modal.querySelectorAll('[data-medit]').forEach(b => b.addEventListener('click', () => { modal.remove(); editMaster(cfg.masters.find(m => m.id === b.dataset.medit)); }));
    modal.querySelectorAll('[data-mdel]').forEach(b => b.addEventListener('click', () => {
      const m = cfg.masters.find(x => x.id === b.dataset.mdel);
      const n = usedBy(m.id);
      if (!confirm(`Excluir o item mestre "${m.name}"?${n ? `\n${n} gráfico(s) usam ele e vão passar a mostrar "Quantidade de linhas".` : ''}`)) return;
      cfg.masters = cfg.masters.filter(x => x !== m);
      allWidgets().forEach(w => { if (w.measure === 'm:' + m.id) { w.measure = '__count'; w.agg = 'count'; } });
      markDirty(); modal.remove(); draw(); manageMasters();
    }));
  }

  function editMaster(existing) {
    const m = existing ? clone(existing) : { id: uid(), name: '', expr: numCols[0] ? `Sum([${numCols[0].name}])` : 'Count([' + (cols[0]?.name || 'Campo') + '])', format: 'number' };
    const body = `
      <label class="field"><span>Nome</span><input name="mname" value="${esc(m.name)}" placeholder="Ex.: Faturamento" required maxlength="60"></label>
      <label class="field"><span>Fórmula</span><textarea name="mexpr" rows="3" spellcheck="false">${esc(m.expr)}</textarea></label>
      <div class="expr-status" data-status></div>
      <div class="expr-help">
        ${model.tables.map(t => `<div><small class="muted">${model.multi ? `Campos de ${esc(t.name)}` : 'Campos'} — clique para inserir</small><div class="chips">${t.columns.map(c => `<button type="button" class="chip-btn ${c.type}" data-ins="[${esc(c.name)}]">${esc(c.name)}</button>`).join('')}</div></div>`).join('')}
        ${model.multi ? '<small class="muted">Use campos de uma tabela só em cada fórmula (campos-chave valem para todas as tabelas em que aparecem).</small>' : ''}
        <div><small class="muted">Funções</small><div class="chips">${FUNCTIONS_HELP.map(([f, d]) => `<button type="button" class="chip-btn fn" data-ins="${esc(f.replace('[Campo]', '').replace('()', '(').replace('(Distinct )', '(Distinct '))}" title="${esc(d)}">${esc(f)}</button>`).join('')}
          <button type="button" class="chip-btn op" data-ins=" / ">÷</button><button type="button" class="chip-btn op" data-ins=" * ">×</button><button type="button" class="chip-btn op" data-ins=" - ">−</button><button type="button" class="chip-btn op" data-ins=" + ">+</button></div></div>
        <details><summary>Exemplos</summary><ul class="small">
          <li><code>Sum([Valor_Total])</code> — faturamento</li>
          <li><code>Sum([Valor_Total]) / Count(Distinct [Nota])</code> — ticket médio por nota</li>
          <li><code>Sum([Realizado]) / Sum([Meta])</code> — % da meta (formato Percentual)</li>
          <li><code>Sum([Quantidade] * [Preço])</code> — conta linha a linha e depois soma</li>
        </ul></details>
      </div>
      <label class="field"><span>Formato</span><select name="mformat">${Object.entries(FORMATS).filter(([k]) => k !== 'auto').map(([k, v]) => opt(k, v, k === (m.format || 'number'))).join('')}</select></label>`;
    const modal = openModal(existing ? 'Editar item mestre' : 'Novo item mestre', body, 'Salvar', form => {
      const c = compile(form.mexpr.value, cols);
      const name = form.mname.value.trim();
      if (c.error || !name || !model.measureTable(c.fields, null)) return false;
      Object.assign(m, { name, expr: form.mexpr.value.trim(), format: form.mformat.value });
      if (existing) cfg.masters[cfg.masters.findIndex(x => x.id === m.id)] = m; else cfg.masters.push(m);
      markDirty(); draw(); setTimeout(manageMasters, 0);
    });
    const form = modal.querySelector('form');
    const status = modal.querySelector('[data-status]');
    const check = () => {
      let c = compile(form.mexpr.value, cols);
      const mt = !c.error && model.measureTable(c.fields, null);
      if (!c.error && !mt) c = { error: 'A fórmula mistura campos de tabelas diferentes. Use campos de uma tabela só.' };
      const rowsNow = mt ? model.select(cfg.filters, cfg.dateCol)[mt.id] : new Uint32Array(0);
      status.className = 'expr-status ' + (c.error ? 'bad' : 'ok');
      status.textContent = c.error ? '⚠ ' + c.error : `✓ Fórmula válida${model.multi ? ` (tabela ${mt.name})` : ''} — com os filtros atuais dá ${formatValue(mt ? c.bind(mt.t)(rowsNow) : null, form.mformat.value)}`;
      form.querySelector('button[type=submit]').disabled = !!c.error || !form.mname.value.trim();
    };
    modal.querySelectorAll('[data-ins]').forEach(b => b.addEventListener('click', () => {
      const ta = form.mexpr, ins = b.dataset.ins;
      const a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a;
      ta.value = ta.value.slice(0, a) + ins + ta.value.slice(z);
      ta.focus(); ta.selectionStart = ta.selectionEnd = a + ins.length;
      check();
    }));
    form.mexpr.addEventListener('input', check);
    form.mname.addEventListener('input', check);
    form.mformat.addEventListener('change', check);
    check();
  }

  // ---------------- janela: escolher filtros ----------------
  function chooseFilters() {
    const checked = new Set(cfg.filterCols);
    const item = (value, label, extra = '') => `
      <label class="check"><input type="checkbox" name="f" value="${esc(value)}" ${checked.has(value) ? 'checked' : ''}>
        <span>${esc(label)}</span>${extra}</label>`;
    const body = `
      <p class="muted">Marque os campos que devem aparecer como filtro no topo do app.</p>
      ${dateCols.length ? `
        <h4>Datas</h4>
        <label class="field"><span>Coluna de data usada nos filtros</span>
          <select name="dateCol">${dateCols.map(c => opt(c.name, c.name, c.name === cfg.dateCol)).join('')}</select></label>
        <div class="check-list">${item('__year', 'Ano')}${item('__month', 'Mês')}</div>` : ''}
      <h4>Colunas</h4>
      <div class="check-list">${textCols.map(c => {
        const k = model.cardinality(c.name);
        return item(c.name, c.name, `<small class="muted">${nf.format(k)} valores${k > 500 ? ' · mostra os 500 primeiros' : ''}${esc(tableHint(c))}</small>`);
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
    if (!document.body.contains(el)) { ro.disconnect(); document.removeEventListener('keydown', onKeyUndo); return; }
    layout();
  });
  ro.observe(el);
  return { destroy: () => { ro.disconnect(); document.removeEventListener('keydown', onKeyUndo); charts.forEach(c => c.destroy()); } };
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
  form.addEventListener('submit', e => { e.preventDefault(); if (onOk(form) === false) return; close(); });
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

function exportCSV(name, T, idx) {
  const cols = T.columns;
  const gs = cols.map(c => T.getter(c.name));
  const cell = (v, t) => {
    const x = v == null ? '' : t === 'number' ? String(v).replace('.', ',') : t === 'date' ? fmtCell(v, t) : String(v);
    return /[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const parts = ['\uFEFF' + cols.map(c => cell(c.name)).join(';') + '\r\n'];
  let buf = [];
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    buf.push(cols.map((c, k) => cell(gs[k](i), c.type)).join(';'));
    if (buf.length === 50000) { parts.push(buf.join('\r\n') + '\r\n'); buf = []; }
  }
  if (buf.length) parts.push(buf.join('\r\n'));
  const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w\-]+/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
