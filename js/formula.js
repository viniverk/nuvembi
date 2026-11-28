// =============================================================
//  Fórmulas de itens mestres (no estilo das expressões do Qlik)
//
//  Exemplos:
//    Sum([Valor_Total])
//    Sum([Valor_Total]) / Count(Distinct [Nota])
//    (Sum([Valor Realizado]) - Sum([Meta])) / Sum([Meta])
//    Sum([Quantidade] * [Preço])
//    Soma([Valor]) / Média([Meta])         (nomes em português também valem)
//
//  Agregações: Sum/Soma, Avg/Média, Min, Max, Count/Contar, Count(Distinct X)
//  Operadores: + - * /  e parênteses. Campos: [Nome do campo] ou Nome_sem_espaço.
// =============================================================

const AGGS = {
  sum: 'sum', soma: 'sum',
  avg: 'avg', media: 'avg', média: 'avg',
  min: 'min', minimo: 'min', mínimo: 'min',
  max: 'max', maximo: 'max', máximo: 'max',
  count: 'count', contar: 'count', cont: 'count',
  countdistinct: 'distinct', contardistintos: 'distinct'
};
export const FUNCTIONS_HELP = [
  ['Sum([Campo])', 'Soma'],
  ['Avg([Campo])', 'Média'],
  ['Count([Campo])', 'Quantidade de linhas preenchidas'],
  ['Count(Distinct [Campo])', 'Quantidade de valores diferentes'],
  ['Min([Campo])', 'Menor valor'],
  ['Max([Campo])', 'Maior valor']
];

function tokenize(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[') {
      const j = src.indexOf(']', i);
      if (j < 0) throw new Error('Faltou fechar o colchete ] do campo.');
      t.push({ k: 'field', v: src.slice(i + 1, j).trim(), at: i }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = src.slice(i).match(/^[0-9]*[.,]?[0-9]+/);
      t.push({ k: 'num', v: Number(m[0].replace(',', '.')), at: i }); i += m[0].length; continue;
    }
    if (/[A-Za-zÀ-ÿ_]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_]*/);
      t.push({ k: 'id', v: m[0], at: i }); i += m[0].length; continue;
    }
    if ('+-*/(),'.includes(c)) { t.push({ k: c, at: i }); i++; continue; }
    throw new Error(`Caractere inesperado "${c}".`);
  }
  return t;
}

// AST: {t:'num',v} {t:'field',name} {t:'neg',a} {t:'bin',op,a,b} {t:'agg',fn,arg}
function parse(src, columns, used = new Set()) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = k => { const x = toks[p]; if (!x || (k && x.k !== k)) throw new Error(k ? `Esperava "${k}".` : 'Fórmula incompleta.'); p++; return x; };
  const colByName = name => {
    const c = columns.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`Campo "${name}" não existe neste painel.`);
    used.add(c.name);
    return c.name;
  };

  function expr(inAgg) {
    let a = term(inAgg);
    while (peek() && (peek().k === '+' || peek().k === '-')) { const op = take().k; a = { t: 'bin', op, a, b: term(inAgg) }; }
    return a;
  }
  function term(inAgg) {
    let a = factor(inAgg);
    while (peek() && (peek().k === '*' || peek().k === '/')) { const op = take().k; a = { t: 'bin', op, a, b: factor(inAgg) }; }
    return a;
  }
  function factor(inAgg) {
    const x = peek();
    if (!x) throw new Error('Fórmula incompleta.');
    if (x.k === '-') { take(); return { t: 'neg', a: factor(inAgg) }; }
    if (x.k === '+') { take(); return factor(inAgg); }
    if (x.k === 'num') { take(); return { t: 'num', v: x.v }; }
    if (x.k === '(') { take(); const e = expr(inAgg); take(')'); return e; }
    if (x.k === 'field') {
      take();
      if (!inAgg) throw new Error(`O campo [${x.v}] precisa estar dentro de uma agregação, por exemplo Sum([${x.v}]).`);
      return { t: 'field', name: colByName(x.v) };
    }
    if (x.k === 'id') {
      take();
      const key = x.v.toLowerCase();
      if (peek() && peek().k === '(') {
        const fn = AGGS[key];
        if (!fn) throw new Error(`Função "${x.v}" não existe. Use Sum, Avg, Min, Max ou Count.`);
        if (inAgg) throw new Error('Não dá para colocar uma agregação dentro de outra.');
        take('(');
        let f = fn;
        if (peek() && peek().k === 'id' && /^(distinct|distintos?)$/i.test(peek().v)) {
          take();
          if (fn !== 'count') throw new Error('Distinct só funciona com Count.');
          f = 'distinct';
        }
        const arg = expr(true);
        take(')');
        return { t: 'agg', fn: f, arg };
      }
      if (!inAgg) throw new Error(`"${x.v}" precisa estar dentro de uma agregação, por exemplo Sum([${x.v}]).`);
      return { t: 'field', name: colByName(x.v) };
    }
    throw new Error(`Não entendi "${x.k}" na posição ${x.at + 1}.`);
  }

  if (!toks.length) throw new Error('Escreva uma fórmula, por exemplo Sum([Valor]).');
  const ast = expr(false);
  if (p < toks.length) throw new Error(`Sobrou "${toks[p].v ?? toks[p].k}" no fim da fórmula.`);
  return ast;
}

// G(nomeDoCampo) devolve uma função posição -> valor (ColTable.getter)
function rowFn(n, G) {
  switch (n.t) {
    case 'num': return () => n.v;
    case 'field': return G(n.name);
    case 'neg': { const a = rowFn(n.a, G); return r => { const v = a(r); return typeof v === 'number' ? -v : null; }; }
    case 'bin': {
      const a = rowFn(n.a, G), b = rowFn(n.b, G);
      return r => {
        const x = a(r), y = b(r);
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        return n.op === '+' ? x + y : n.op === '-' ? x - y : n.op === '*' ? x * y : (y === 0 ? null : x / y);
      };
    }
  }
}

function aggFn(n, G) {
  const f = rowFn(n.arg, G);
  switch (n.fn) {
    case 'sum': return rows => { let s = 0; for (const r of rows) { const v = f(r); if (typeof v === 'number') s += v; } return s; };
    case 'avg': return rows => { let s = 0, c = 0; for (const r of rows) { const v = f(r); if (typeof v === 'number') { s += v; c++; } } return c ? s / c : null; };
    case 'min': return rows => { let m = null; for (const r of rows) { const v = f(r); if (typeof v === 'number' && (m === null || v < m)) m = v; } return m; };
    case 'max': return rows => { let m = null; for (const r of rows) { const v = f(r); if (typeof v === 'number' && (m === null || v > m)) m = v; } return m; };
    case 'count': return rows => { let c = 0; for (const r of rows) { const v = f(r); if (v !== null && v !== undefined && v !== '') c++; } return c; };
    case 'distinct': return rows => { const s = new Set(); for (const r of rows) { const v = f(r); if (v !== null && v !== undefined && v !== '') s.add(v); } return s.size; };
  }
}

function topFn(n, G) {
  switch (n.t) {
    case 'num': return () => n.v;
    case 'agg': return aggFn(n, G);
    case 'neg': { const a = topFn(n.a, G); return rows => { const v = a(rows); return v === null ? null : -v; }; }
    case 'bin': {
      const a = topFn(n.a, G), b = topFn(n.b, G);
      return rows => {
        const x = a(rows), y = b(rows);
        if (x === null || y === null) return null;
        return n.op === '+' ? x + y : n.op === '-' ? x - y : n.op === '*' ? x * y : (y === 0 ? null : x / y);
      };
    }
  }
}

// soma de partes faz sentido? (para % do total e "Outros" na pizza)
function additive(n) {
  if (n.t === 'agg') return n.fn === 'sum' || n.fn === 'count';
  if (n.t === 'bin') return (n.op === '+' || n.op === '-') && additive(n.a) && additive(n.b);
  if (n.t === 'neg') return additive(n.a);
  return n.t === 'num' ? false : false;
}

const cache = new Map();
// devolve { bind(tabela) -> fn(posições) -> número|null, additive, fields } ou { error }
// (tabela = ColTable; posições = lista de linhas)
export function compile(expr, columns) {
  const key = expr + '\u0000' + columns.map(c => c.name).join('|');
  if (cache.has(key)) return cache.get(key);
  let out;
  try {
    const used = new Set();
    const ast = parse(String(expr || ''), columns, used);
    if (ast.t !== 'agg' && !JSON.stringify(ast).includes('"agg"')) throw new Error('A fórmula precisa de pelo menos uma agregação, por exemplo Sum([Valor]).');
    const bound = new WeakMap();
    out = {
      additive: additive(ast), fields: [...used],
      bind(table) {
        let f = bound.get(table);
        if (!f) { f = topFn(ast, name => table.getter(name)); bound.set(table, f); }
        return f;
      }
    };
  } catch (e) {
    out = { error: e.message };
  }
  cache.set(key, out);
  return out;
}

// ---------- formatos ----------
export const FORMATS = { auto: 'Automático', number: 'Número', currency: 'Moeda (R$)', percent: 'Percentual (%)', integer: 'Número inteiro' };
const nf2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nfc = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const cur = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 });

// full = valor completo (tooltip, tabela); short = abreviado (KPI, rótulos, eixos)
export function formatValue(v, format = 'number', short = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (format === 'percent') return pct.format(v);
  if (format === 'currency') return short && Math.abs(v) >= 1e4 ? 'R$ ' + nfc.format(v) : cur.format(v);
  if (format === 'integer') return short && Math.abs(v) >= 1e5 ? nfc.format(v) : nf0.format(v);
  return short && Math.abs(v) >= 1e4 ? nfc.format(v) : nf2.format(v);
}
