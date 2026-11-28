// =============================================================
//  Editor de script (script de carga do app)
//
//  As tabelas adicionadas no Gerenciador de dados são as FONTES.
//  O script lê as fontes e monta as tabelas do modelo:
//
//    Vendas:
//    LOAD Nota, Cliente, Valor_Total AS Faturamento,
//         Year(Data) AS Ano, Month(Data) AS Mes
//    FROM [vendas-exemplo]
//    WHERE Valor_Total > 0;
//
//  Comandos: LOAD [DISTINCT] … FROM fonte | RESIDENT tabela | INLINE [...]
//            [WHERE cond] [GROUP BY campos];
//            prefixos Rótulo:, MAPPING, NOCONCATENATE, CONCATENATE (T),
//            LEFT/RIGHT/INNER/OUTER JOIN (T);
//            DROP TABLE(S), DROP FIELD(S) … [FROM …], RENAME FIELD/TABLE … TO …,
//            SET/LET variável = …, $(variável), TRACE, EXIT SCRIPT,
//            comentários //, /* */ e REM.
//  Roda inteiro no navegador sobre as tabelas colunares (ColTable).
// =============================================================
import { ColTable } from './coltable.js?v=30';
import { toNumber, toISODate } from './parser.js?v=30';

export class ScriptError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

// ---------------- tokens ----------------
const ID_START = /[A-Za-z_%À-ÿ]/;
const ID_CHAR = /[A-Za-z0-9_%#.$À-ÿ]/;

export function tokenize(src) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const push = (type, v, start) => toks.push({ type, v, line: tokLine, start, end: i });
  let tokLine = 1;
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    tokLine = line;
    const start = i;
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (ch === '$' && src[i + 1] === '(') {
      const e = src.indexOf(')', i);
      if (e < 0) throw new ScriptError('Variável $( sem o ")" de fechamento.', line);
      i = e + 1; push('expand', src.slice(start + 2, e).trim(), start); continue;
    }
    if (ch === '[') {
      let j = i + 1;
      while (j < n && src[j] !== ']') { if (src[j] === '\n') line++; j++; }
      if (j >= n) throw new ScriptError('Colchete [ sem o ] de fechamento.', tokLine);
      i = j + 1; push('name', src.slice(start + 1, j), start); continue;
    }
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      if (j < 0) throw new ScriptError('Aspas " sem fechamento.', line);
      i = j + 1; push('name', src.slice(start + 1, j), start); continue;
    }
    if (ch === "'") {
      let s = ''; i++;
      while (true) {
        if (i >= n) throw new ScriptError("Texto entre aspas simples ' sem fechamento.", tokLine);
        if (src[i] === "'") { if (src[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; }
        if (src[i] === '\n') line++;
        s += src[i++];
      }
      push('str', s, start); continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1]))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      if (j < n && /[eE]/.test(src[j]) && /[-+0-9]/.test(src[j + 1])) { j += 2; while (j < n && /[0-9]/.test(src[j])) j++; }
      i = j; push('num', Number(src.slice(start, j)), start); continue;
    }
    if (ID_START.test(ch)) {
      let j = i;
      while (j < n && ID_CHAR.test(src[j])) j++;
      i = j; push('id', src.slice(start, j), start); continue;
    }
    const two = src.slice(i, i + 2);
    if (['<>', '<=', '>=', '!='].includes(two)) { i += 2; push('op', two === '!=' ? '<>' : two, start); continue; }
    if ('&+-*/=<>(),;:'.includes(ch)) { i++; push('op', ch, start); continue; }
    throw new ScriptError(`Caractere inesperado "${ch}".`, line);
  }
  toks.push({ type: 'eof', v: null, line, start: n, end: n });
  return toks;
}

// ---------------- datas ----------------
const DAY = 86400000;
const pad = (x, w = 2) => String(x).padStart(w, '0');
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function serialToParts(s) { const dt = new Date(Math.round((s - 25569) * DAY)); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
const partsToSerial = p => Date.UTC(p.y, p.m - 1, p.d) / DAY + 25569;
function dateParts(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? serialToParts(v) : null;
  const iso = toISODate(v, true);
  if (!iso) return null;
  return { y: +iso.slice(0, 4), m: +iso.slice(5, 7), d: +iso.slice(8, 10) };
}
const partsToISO = p => p ? isoOf(p.y, p.m, p.d) : null;
function normParts(y, m, d) {   // corrige mês/dia fora do intervalo (ex.: AddMonths)
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
// Date#('20260315', 'YYYYMMDD'), Date#('15/03/2026', 'DD/MM/YYYY')
function parseDateFmt(s, fmt) {
  if (s === null || s === undefined) return null;
  s = String(s).trim();
  if (!fmt) return dateParts(s);
  const order = [];
  const re = fmt.replace(/[.*+?^${}()|\\]/g, '\\$&').replace(/YYYY|YY|MM|M|DD|D|hh|mm|ss/g, t => {
    order.push(t);
    return { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{2})', M: '(\\d{1,2})', DD: '(\\d{2})', D: '(\\d{1,2})' }[t] || '\\d{1,2}';
  });
  const m = s.match(new RegExp('^' + re));
  if (!m) return null;
  const p = { y: 1900, m: 1, d: 1 };
  order.filter(t => /Y|M|D/.test(t[0]) && t !== 'mm').forEach((t, k) => {
    const v = +m[k + 1];
    if (t[0] === 'Y') p.y = t === 'YY' ? 2000 + v : v; else if (t[0] === 'M') p.m = v; else p.d = v;
  });
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return null;
  return p;
}

// ---------------- valores ----------------
const TRUE = -1, FALSE = 0;
const truthy = v => v !== null && v !== undefined && v !== 0 && v !== false && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const p = dateParts(v); return p ? partsToSerial(p) : null; }
    const x = Number(v.trim());
    if (Number.isFinite(x)) return x;
    const y = toNumber(v);
    return Number.isFinite(y) ? y : null;
  }
  return null;
}
const str = v => v === null || v === undefined ? '' : typeof v === 'number' ? fmtNum(v) : String(v);
function fmtNum(v) { return Number.isInteger(v) ? String(v) : String(+v.toFixed(10)); }
function cmp(a, b) {
  const na = typeof a === 'number' ? a : (typeof a === 'string' && a.trim() !== '' && Number.isFinite(Number(a)) ? Number(a) : null);
  const nb = typeof b === 'number' ? b : (typeof b === 'string' && b.trim() !== '' && Number.isFinite(Number(b)) ? Number(b) : null);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  const sa = str(a), sb = str(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function wild(pattern, caseInsensitive = true) {
  const re = '^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(re, caseInsensitive ? 'is' : 's');
}
const keyOf = v => v === null || v === undefined ? '\u0000' : typeof v === 'number' ? 'n' + v : 's' + v;

// ---------------- funções de linha ----------------
// t: tipo do resultado ('number' | 'text' | 'date' | 'same' = tipo do 1º argumento | 'branch')
const F = {
  year: { t: 'number', f: v => dateParts(v)?.y ?? null },
  month: { t: 'number', f: v => dateParts(v)?.m ?? null },
  day: { t: 'number', f: v => dateParts(v)?.d ?? null },
  weekday: { t: 'number', f: v => { const p = dateParts(v); return p ? (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7 : null; } },
  week: { t: 'number', f: v => { const p = dateParts(v); if (!p) return null; const d = new Date(Date.UTC(p.y, p.m - 1, p.d)); const dn = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dn + 3); const f = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - f) / DAY - 3 + ((f.getUTCDay() + 6) % 7)) / 7); } },
  quarter: { t: 'number', f: v => { const p = dateParts(v); return p ? Math.ceil(p.m / 3) : null; } },
  monthname: { t: 'text', f: v => { const p = dateParts(v); return p ? `${p.y}-${pad(p.m)}` : null; } },
  yearmonth: { t: 'text', f: v => { const p = dateParts(v); return p ? `${p.y}-${pad(p.m)}` : null; } },
  monthstart: { t: 'date', f: v => { const p = dateParts(v); return p ? isoOf(p.y, p.m, 1) : null; } },
  monthend: { t: 'date', f: v => { const p = dateParts(v); return p ? partsToISO(normParts(p.y, p.m + 1, 0)) : null; } },
  yearstart: { t: 'date', f: v => { const p = dateParts(v); return p ? isoOf(p.y, 1, 1) : null; } },
  addmonths: { t: 'date', f: (v, k) => { const p = dateParts(v); if (!p) return null; const e = normParts(p.y, p.m + (num(k) || 0) + 1, 0); return partsToISO({ ...e, d: Math.min(p.d, e.d) }); } },
  adddays: { t: 'date', f: (v, k) => { const p = dateParts(v); return p ? partsToISO(serialToParts(partsToSerial(p) + (num(k) || 0))) : null; } },
  makedate: { t: 'date', f: (y, m = 1, d = 1) => { y = num(y); if (y === null) return null; return partsToISO(normParts(y, num(m) || 1, num(d) || 1)); } },
  today: { t: 'date', f: () => { const d = new Date(); return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate()); } },
  date: { t: 'date', f: v => partsToISO(dateParts(v)) },
  'date#': { t: 'date', f: (v, fmt) => partsToISO(parseDateFmt(v, fmt)) },
  num: { t: 'number', f: v => num(v) },
  'num#': { t: 'number', f: v => { if (typeof v === 'number') return v; const x = toNumber(String(v ?? '')); return Number.isFinite(x) ? x : num(v); } },
  text: { t: 'text', f: v => v === null || v === undefined ? null : str(v) },
  left: { t: 'text', f: (s, k) => s === null ? null : str(s).slice(0, Math.max(0, num(k) || 0)) },
  right: { t: 'text', f: (s, k) => { if (s === null) return null; s = str(s); k = Math.max(0, num(k) || 0); return k ? s.slice(-k) : ''; } },
  mid: { t: 'text', f: (s, a, k) => { if (s === null) return null; s = str(s); const st = Math.max(1, num(a) || 1) - 1; return k === undefined ? s.slice(st) : s.substr(st, Math.max(0, num(k) || 0)); } },
  len: { t: 'number', f: s => s === null ? 0 : str(s).length },
  upper: { t: 'text', f: s => s === null ? null : str(s).toUpperCase() },
  lower: { t: 'text', f: s => s === null ? null : str(s).toLowerCase() },
  capitalize: { t: 'text', f: s => s === null ? null : str(s).toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) },
  trim: { t: 'text', f: s => s === null ? null : str(s).trim() },
  ltrim: { t: 'text', f: s => s === null ? null : str(s).replace(/^\s+/, '') },
  rtrim: { t: 'text', f: s => s === null ? null : str(s).replace(/\s+$/, '') },
  replace: { t: 'text', f: (s, a, b) => s === null ? null : str(s).split(str(a)).join(str(b)) },
  index: { t: 'number', f: (s, sub, k = 1) => { s = str(s); sub = str(sub); k = num(k) || 1; if (!sub) return 0; let pos = -1; if (k > 0) { for (let c = 0; c < k; c++) { pos = s.indexOf(sub, pos + 1); if (pos < 0) return 0; } } else { pos = s.length; for (let c = 0; c < -k; c++) { pos = s.lastIndexOf(sub, pos - 1); if (pos < 0) return 0; } } return pos + 1; } },
  subfield: { t: 'text', f: (s, d, k) => { if (s === null) return null; if (k === undefined) throw new ScriptError('SubField precisa do 3º argumento (qual parte). Ex.: SubField(Campo, \'-\', 1)'); const parts = str(s).split(str(d)); k = num(k) || 0; const v = k > 0 ? parts[k - 1] : parts[parts.length + k]; return v === undefined ? null : v; } },
  textbetween: { t: 'text', f: (s, a, b) => { s = str(s); const i = s.indexOf(str(a)); if (i < 0) return null; const st = i + str(a).length; const j = s.indexOf(str(b), st); return j < 0 ? null : s.slice(st, j); } },
  purgechar: { t: 'text', f: (s, c) => s === null ? null : [...str(s)].filter(x => !str(c).includes(x)).join('') },
  keepchar: { t: 'text', f: (s, c) => s === null ? null : [...str(s)].filter(x => str(c).includes(x)).join('') },
  repeat: { t: 'text', f: (s, k = 1) => str(s).repeat(Math.max(0, num(k) || 0)) },
  if: { t: 'branch', f: null },
  alt: { t: 'branch', f: (...a) => { for (const v of a) if (v !== null && v !== undefined && v !== '') return v; return null; } },
  coalesce: { t: 'branch', f: (...a) => { for (const v of a) if (v !== null && v !== undefined && v !== '') return v; return null; } },
  isnull: { t: 'number', f: v => (v === null || v === undefined || v === '') ? TRUE : FALSE },
  isnum: { t: 'number', f: v => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim()))) ? TRUE : FALSE },
  null: { t: 'text', f: () => null },
  pick: { t: 'branch', f: (k, ...a) => { k = num(k); return k >= 1 && k <= a.length ? a[k - 1] : null; } },
  match: { t: 'number', f: (v, ...a) => { const s = str(v); const k = a.findIndex(x => str(x) === s); return k + 1; } },
  mixmatch: { t: 'number', f: (v, ...a) => { const s = str(v).toLowerCase(); const k = a.findIndex(x => str(x).toLowerCase() === s); return k + 1; } },
  wildmatch: { t: 'number', f: (v, ...a) => { const s = str(v); const k = a.findIndex(x => wild(x).test(s)); return k + 1; } },
  round: { t: 'number', f: (v, st = 1) => { v = num(v); st = num(st) || 1; return v === null ? null : +(Math.round(v / st) * st).toFixed(10); } },
  floor: { t: 'number', f: (v, st = 1) => { v = num(v); st = num(st) || 1; return v === null ? null : +(Math.floor(v / st + 1e-12) * st).toFixed(10); } },
  ceil: { t: 'number', f: (v, st = 1) => { v = num(v); st = num(st) || 1; return v === null ? null : +(Math.ceil(v / st - 1e-12) * st).toFixed(10); } },
  abs: { t: 'number', f: v => { v = num(v); return v === null ? null : Math.abs(v); } },
  fabs: { t: 'number', f: v => { v = num(v); return v === null ? null : Math.abs(v); } },
  sqrt: { t: 'number', f: v => { v = num(v); return v === null || v < 0 ? null : Math.sqrt(v); } },
  pow: { t: 'number', f: (a, b) => { a = num(a); b = num(b); return a === null || b === null ? null : Math.pow(a, b); } },
  mod: { t: 'number', f: (a, b) => { a = num(a); b = num(b); return a === null || !b ? null : ((a % b) + b) % b; } },
  div: { t: 'number', f: (a, b) => { a = num(a); b = num(b); return a === null || !b ? null : Math.trunc(a / b); } },
  rangesum: { t: 'number', f: (...a) => a.reduce((s, v) => s + (num(v) || 0), 0) },
  rangemax: { t: 'number', f: (...a) => { const x = a.map(num).filter(v => v !== null); return x.length ? Math.max(...x) : null; } },
  rangemin: { t: 'number', f: (...a) => { const x = a.map(num).filter(v => v !== null); return x.length ? Math.min(...x) : null; } },
  rangeavg: { t: 'number', f: (...a) => { const x = a.map(num).filter(v => v !== null); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; } },
};
// nomes em português também valem
const ALIAS = { ano: 'year', mes: 'month', mês: 'month', dia: 'day', esquerda: 'left', direita: 'right', maiusculo: 'upper', minusculo: 'lower', se: 'if', arredondar: 'round' };
const AGG = new Set(['sum', 'count', 'avg', 'min', 'max', 'only', 'concat', 'firstvalue', 'lastvalue', 'soma', 'media', 'média', 'contar']);
const AGG_ALIAS = { soma: 'sum', media: 'avg', média: 'avg', contar: 'count' };
const SPECIAL = new Set(['applymap', 'exists', 'recno', 'rowno', 'autonumber']);

export const FUNCTION_NAMES = [
  'Year', 'Month', 'Day', 'WeekDay', 'Week', 'Quarter', 'MonthName', 'MonthStart', 'MonthEnd', 'YearStart', 'AddMonths', 'AddDays',
  'MakeDate', 'Today', 'Date', 'Date#', 'Num', 'Num#', 'Text', 'Left', 'Right', 'Mid', 'Len', 'Upper', 'Lower', 'Capitalize', 'Trim',
  'Replace', 'Index', 'SubField', 'TextBetween', 'PurgeChar', 'KeepChar', 'If', 'Alt', 'IsNull', 'Null', 'Pick', 'Match', 'WildMatch',
  'Round', 'Floor', 'Ceil', 'Abs', 'Mod', 'Div', 'RangeSum', 'ApplyMap', 'Exists', 'AutoNumber', 'RecNo', 'RowNo',
  'Sum', 'Count', 'Avg', 'Min', 'Max', 'Only', 'Concat'
];

// ---------------- cores do editor (realce de sintaxe) ----------------
const HL_KW = new Set(['load', 'from', 'resident', 'inline', 'where', 'group', 'by', 'order', 'as', 'distinct', 'mapping', 'noconcatenate',
  'concatenate', 'left', 'right', 'inner', 'outer', 'join', 'keep', 'drop', 'table', 'tables', 'field', 'fields', 'rename', 'to', 'set', 'let',
  'trace', 'exit', 'script', 'and', 'or', 'not', 'like', 'asc', 'desc', 'store', 'select', 'sql', 'while', 'autogenerate']);
const HL_FN = new Set([...Object.keys(F), ...AGG, ...Object.keys(ALIAS), ...SPECIAL]);
const hesc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function highlightScript(src) {
  let out = '', i = 0, stmtStart = true;
  const n = src.length;
  const span = (cls, t) => { out += `<span class="hl-${cls}">${hesc(t)}</span>`; };
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; span('com', src.slice(i, j)); i = j; continue; }
    if (ch === '/' && src[i + 1] === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; span('com', src.slice(i, j)); i = j; continue; }
    if (ch === "'") { let j = i + 1; while (j < n && !(src[j] === "'" && src[j + 1] !== "'")) j += src[j] === "'" ? 2 : 1; j = Math.min(n, j + 1); span('str', src.slice(i, j)); i = j; stmtStart = false; continue; }
    if (ch === '[') { let j = src.indexOf(']', i); j = j < 0 ? n : j + 1; const after = src.slice(j).match(/^\s*:/); span(after && stmtStart ? 'lbl' : 'fld', src.slice(i, j)); i = j; stmtStart = false; continue; }
    if (ch === '"') { let j = src.indexOf('"', i + 1); j = j < 0 ? n : j + 1; span('fld', src.slice(i, j)); i = j; stmtStart = false; continue; }
    if (ch === '$' && src[i + 1] === '(') { let j = src.indexOf(')', i); j = j < 0 ? n : j + 1; span('var', src.slice(i, j)); i = j; continue; }
    if (/[0-9]/.test(ch) && !/[A-Za-z_À-ÿ]/.test(src[i - 1] || '')) { let j = i; while (j < n && /[0-9.]/.test(src[j])) j++; span('num', src.slice(i, j)); i = j; stmtStart = false; continue; }
    if (ID_START.test(ch)) {
      let j = i; while (j < n && ID_CHAR.test(src[j])) j++;
      const w = src.slice(i, j), lw = w.toLowerCase();
      if (lw === 'rem' && stmtStart) { let k = src.indexOf(';', j); k = k < 0 ? n : k + 1; span('com', src.slice(i, k)); i = k; continue; }
      const rest = src.slice(j);
      if (stmtStart && /^\s*:/.test(rest) && !HL_KW.has(lw)) span('lbl', w);
      else if (HL_KW.has(lw)) span('kw', w);
      else if (/^\s*\(/.test(rest) && HL_FN.has(lw)) span('fn', w);
      else out += hesc(w);
      i = j; stmtStart = false; continue;
    }
    if (ch === ';') { span('op', ';'); i++; stmtStart = true; continue; }
    if (ch === ':') { out += ':'; i++; continue; }
    out += hesc(ch); i++;
  }
  return out + '\n';   // linha extra: mantém a última linha alinhada com a caixa de texto
}

// explicação de cada função (aparece ao passar o mouse no editor)
export const FUNCTION_HELP = {
  Year: ['Year(data)', 'Ano da data.', "Year(Data_Emissao) AS Ano → 2026"],
  Month: ['Month(data)', 'Mês da data, de 1 a 12.', 'Month(Data_Emissao) AS Mes → 3'],
  Day: ['Day(data)', 'Dia do mês, de 1 a 31.', 'Day(Data_Emissao) AS Dia → 15'],
  WeekDay: ['WeekDay(data)', 'Dia da semana: 0 = segunda … 6 = domingo.', 'WeekDay(Data) AS DiaSemana'],
  Week: ['Week(data)', 'Número da semana no ano (padrão ISO).', 'Week(Data) AS Semana → 11'],
  Quarter: ['Quarter(data)', 'Trimestre da data, de 1 a 4.', "'T' & Quarter(Data) AS Trimestre → T1"],
  MonthName: ['MonthName(data)', 'Ano e mês como texto aaaa-mm (ordena certo).', 'MonthName(Data) AS AnoMes → 2026-03'],
  MonthStart: ['MonthStart(data)', 'Primeiro dia do mês da data.', 'MonthStart(Data) → 2026-03-01'],
  MonthEnd: ['MonthEnd(data)', 'Último dia do mês da data.', 'MonthEnd(Data) → 2026-03-31'],
  YearStart: ['YearStart(data)', 'Primeiro dia do ano da data.', 'YearStart(Data) → 2026-01-01'],
  AddMonths: ['AddMonths(data, n)', 'Soma (ou subtrai, com n negativo) meses à data.', 'AddMonths(Data, -12) AS DataAnoAnterior'],
  AddDays: ['AddDays(data, n)', 'Soma (ou subtrai) dias à data.', 'AddDays(Vencimento, 30)'],
  MakeDate: ['MakeDate(ano, mês, dia)', 'Monta uma data a partir de números.', 'MakeDate(Ano, Mes, 1) AS Competencia'],
  Today: ['Today()', 'Data de hoje, no momento da carga.', 'Today() - Vencimento AS DiasAtraso'],
  Date: ['Date(valor)', 'Converte para data (aceita aaaa-mm-dd, dd/mm/aaaa, aaaammdd ou número).', "Date('15/03/2026')"],
  'Date#': ['Date#(texto, formato)', 'Lê uma data num formato específico. Ideal para datas do Protheus (texto aaaammdd).', "Date#(D2_EMISSAO, 'YYYYMMDD') AS Emissao"],
  Num: ['Num(valor)', 'Converte para número.', 'Num(Quantidade)'],
  'Num#': ['Num#(texto)', 'Lê número escrito em texto, inclusive no formato brasileiro (1.234,56).', "Num#('1.234,56') → 1234.56"],
  Text: ['Text(valor)', 'Converte para texto (mantém zeros à esquerda).', 'Text(Codigo)'],
  Left: ['Left(texto, n)', 'Primeiros n caracteres.', "Left(Cod_Produto, 3) AS Grupo"],
  Right: ['Right(texto, n)', 'Últimos n caracteres.', 'Right(Nota, 4)'],
  Mid: ['Mid(texto, início, n)', 'Pedaço do texto a partir da posição início (a 1ª é 1), com n caracteres.', 'Mid(CNPJ, 1, 8) AS Raiz_CNPJ'],
  Len: ['Len(texto)', 'Quantidade de caracteres.', 'Len(Descricao)'],
  Upper: ['Upper(texto)', 'Tudo em MAIÚSCULAS.', 'Upper(Cliente)'],
  Lower: ['Lower(texto)', 'Tudo em minúsculas.', 'Lower(Email)'],
  Capitalize: ['Capitalize(texto)', 'Primeira Letra De Cada Palavra Em Maiúscula.', 'Capitalize(Nome)'],
  Trim: ['Trim(texto)', 'Tira espaços do começo e do fim (comum em campos do Protheus).', 'Trim(B1_DESC) AS Produto'],
  Replace: ['Replace(texto, de, para)', 'Troca todas as ocorrências de um trecho.', "Replace(Telefone, '-', '')"],
  Index: ['Index(texto, trecho)', 'Posição onde o trecho aparece (0 se não aparece).', "Index(Email, '@')"],
  SubField: ['SubField(texto, separador, n)', 'n-ésima parte do texto separado (n negativo conta do fim).', "SubField('SC-Joinville', '-', 2) → Joinville"],
  TextBetween: ['TextBetween(texto, início, fim)', 'Texto entre dois marcadores.', "TextBetween(Obs, '[', ']')"],
  PurgeChar: ['PurgeChar(texto, caracteres)', 'Remove os caracteres informados.', "PurgeChar(CNPJ, './-') AS CNPJ_Num"],
  KeepChar: ['KeepChar(texto, caracteres)', 'Mantém só os caracteres informados.', "KeepChar(Telefone, '0123456789')"],
  If: ['If(condição, se_sim, se_não)', 'Escolhe um valor conforme a condição.', "If(Valor_Total >= 1000, 'Grande', 'Pequena') AS Porte"],
  Alt: ['Alt(valor1, valor2, …)', 'Primeiro valor que não está vazio.', "Alt(Apelido, Nome, 'Sem nome')"],
  IsNull: ['IsNull(valor)', 'Verdadeiro se o valor está vazio.', "If(IsNull(Vendedor), 'Sem vendedor', Vendedor)"],
  Null: ['Null()', 'Valor vazio.', 'If(Valor < 0, Null(), Valor)'],
  Pick: ['Pick(n, valor1, valor2, …)', 'Devolve o valor da posição n.', "Pick(Quarter(Data), 'Verão', 'Outono', 'Inverno', 'Primavera')"],
  Match: ['Match(valor, a, b, …)', 'Posição do valor na lista (0 se não está). Use em WHERE.', "WHERE Match(Filial, '0101', '0201')"],
  WildMatch: ['WildMatch(valor, padrão, …)', 'Como Match, mas aceita * e ? e ignora maiúsculas.', "WHERE WildMatch(Produto, 'parafuso*')"],
  Round: ['Round(número, passo)', 'Arredonda (passo 0.01 = 2 casas; 10 = dezena).', 'Round(Valor_Total, 0.01)'],
  Floor: ['Floor(número, passo)', 'Arredonda para baixo.', 'Floor(Idade, 10) AS FaixaEtaria'],
  Ceil: ['Ceil(número, passo)', 'Arredonda para cima.', 'Ceil(Peso)'],
  Abs: ['Abs(número)', 'Valor sem sinal (absoluto).', 'Abs(Diferenca)'],
  Mod: ['Mod(a, b)', 'Resto da divisão de a por b.', 'Mod(Numero, 2) AS Par_Impar'],
  Div: ['Div(a, b)', 'Parte inteira da divisão.', 'Div(Minutos, 60) AS Horas'],
  RangeSum: ['RangeSum(a, b, …)', 'Soma os valores tratando vazio como zero.', 'RangeSum(Frete, Seguro, Despesas) AS Custos'],
  ApplyMap: ['ApplyMap(\'Mapa\', chave, padrão)', 'Busca a chave num MAPPING LOAD (de-para). Se não achar, devolve o padrão.', "ApplyMap('MapaUF', Cliente, 'Sem UF') AS UF"],
  Exists: ['Exists(campo, valor)', 'Verdadeiro se o valor já foi carregado no campo. Use em WHERE.', 'WHERE Exists(Cliente)  ·  WHERE NOT Exists(Nota)'],
  AutoNumber: ['AutoNumber(valor)', 'Troca o valor por um número sequencial (chaves menores).', "AutoNumber(Filial & '|' & Nota) AS ChaveNota"],
  RecNo: ['RecNo()', 'Número da linha na fonte lida.', 'RecNo() AS LinhaOrigem'],
  RowNo: ['RowNo()', 'Número da linha na tabela gerada.', 'RowNo() AS Seq'],
  Sum: ['Sum(campo)', 'Soma — use com GROUP BY.', 'LOAD Cliente, Sum(Valor) AS Total RESIDENT Vendas GROUP BY Cliente;'],
  Count: ['Count(campo) · Count(DISTINCT campo) · Count(*)', 'Conta linhas ou valores distintos — use com GROUP BY.', 'Count(DISTINCT Nota) AS Notas'],
  Avg: ['Avg(campo)', 'Média — use com GROUP BY.', 'Avg(Preco) AS PrecoMedio'],
  Min: ['Min(campo)', 'Menor valor (ou primeira data) — use com GROUP BY.', 'Min(Data) AS PrimeiraCompra'],
  Max: ['Max(campo)', 'Maior valor (ou última data) — use com GROUP BY.', 'Max(Data) AS UltimaCompra'],
  Only: ['Only(campo)', 'O valor, se for único no grupo; vazio se houver mais de um.', 'Only(Vendedor)'],
  Concat: ['Concat(campo, separador)', 'Junta os valores distintos do grupo num texto.', "Concat(Produto, ', ') AS Produtos"],
};

// ---------------- leitor de expressões ----------------
const KW_STOP = new Set(['as', 'from', 'resident', 'inline', 'where', 'group', 'order', 'and', 'or', 'not', 'like', 'to', 'while', 'autogenerate']);

class Cursor {
  constructor(toks) { this.t = toks; this.p = 0; }
  peek(k = 0) { return this.t[this.p + k]; }
  next() { return this.t[this.p++]; }
  isKw(w, k = 0) { const t = this.peek(k); return t.type === 'id' && t.v.toLowerCase() === w; }
  isOp(o, k = 0) { const t = this.peek(k); return t.type === 'op' && t.v === o; }
  eatKw(w) { if (this.isKw(w)) { this.p++; return true; } return false; }
  eatOp(o) { if (this.isOp(o)) { this.p++; return true; } return false; }
  expectOp(o, what) { if (!this.eatOp(o)) throw new ScriptError(`Esperava "${o}"${what ? ' ' + what : ''} e encontrou ${desc(this.peek())}.`, this.peek().line); }
  expectKw(w) { if (!this.eatKw(w)) throw new ScriptError(`Esperava ${w.toUpperCase()} e encontrou ${desc(this.peek())}.`, this.peek().line); }
}
function desc(t) {
  if (t.type === 'eof') return 'o fim do script';
  if (t.type === 'op' && t.v === ';') return '";" (fim do comando)';
  if (t.type === 'str') return `'${t.v}'`;
  if (t.type === 'name') return `[${t.v}]`;
  return `"${t.v}"`;
}

function parseExpr(c) { return parseOr(c); }
function parseOr(c) { let a = parseAnd(c); while (c.isKw('or')) { c.next(); a = { k: 'bin', op: 'or', a, b: parseAnd(c) }; } return a; }
function parseAnd(c) { let a = parseNot(c); while (c.isKw('and')) { c.next(); a = { k: 'bin', op: 'and', a, b: parseNot(c) }; } return a; }
function parseNot(c) { if (c.isKw('not')) { c.next(); return { k: 'un', op: 'not', a: parseNot(c) }; } return parseCmp(c); }
function parseCmp(c) {
  const a = parseConcat(c);
  const t = c.peek();
  if (t.type === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) { c.next(); return { k: 'bin', op: t.v, a, b: parseConcat(c) }; }
  if (c.isKw('like')) { c.next(); return { k: 'bin', op: 'like', a, b: parseConcat(c) }; }
  return a;
}
function parseConcat(c) { let a = parseAdd(c); while (c.isOp('&')) { c.next(); a = { k: 'bin', op: '&', a, b: parseAdd(c) }; } return a; }
function parseAdd(c) { let a = parseMul(c); while (c.isOp('+') || c.isOp('-')) { const op = c.next().v; a = { k: 'bin', op, a, b: parseMul(c) }; } return a; }
function parseMul(c) { let a = parseUnary(c); while (c.isOp('*') || c.isOp('/')) { const op = c.next().v; a = { k: 'bin', op, a, b: parseUnary(c) }; } return a; }
function parseUnary(c) {
  if (c.isOp('-')) { c.next(); return { k: 'un', op: '-', a: parseUnary(c) }; }
  if (c.isOp('+')) { c.next(); return parseUnary(c); }
  return parsePrimary(c);
}
function parsePrimary(c) {
  const t = c.peek();
  if (t.type === 'num') { c.next(); return { k: 'lit', v: t.v }; }
  if (t.type === 'str') { c.next(); return { k: 'lit', v: t.v }; }
  if (t.type === 'name') { c.next(); return { k: 'field', name: t.v, line: t.line }; }
  if (t.type === 'op' && t.v === '(') { c.next(); const e = parseExpr(c); c.expectOp(')', 'para fechar o parêntese'); return e; }
  if (t.type === 'id') {
    if (c.isOp('(', 1)) {
      c.next(); c.next();
      let name = t.v.toLowerCase();
      name = ALIAS[name] || AGG_ALIAS[name] || name;
      const args = [];
      let distinct = false;
      if (AGG.has(name) || name in AGG_ALIAS) {
        if (c.eatKw('distinct')) distinct = true;
        if (name === 'count' && c.isOp('*') && c.isOp(')', 1)) { c.next(); c.next(); return { k: 'agg', fn: 'count', star: true, args: [], line: t.line }; }
      }
      if (!c.isOp(')')) { do { args.push(parseExpr(c)); } while (c.eatOp(',')); }
      c.expectOp(')', `para fechar ${t.v}(`);
      if (AGG.has(name)) return { k: 'agg', fn: name, distinct, args, line: t.line };
      if (!F[name] && !SPECIAL.has(name)) throw new ScriptError(`Função desconhecida: ${t.v}().`, t.line);
      return { k: 'fn', name, args, line: t.line, label: t.v };
    }
    const lw = t.v.toLowerCase();
    if (KW_STOP.has(lw)) throw new ScriptError(`Esperava um campo ou valor e encontrou ${t.v.toUpperCase()}.`, t.line);
    if (lw === 'true') { c.next(); return { k: 'lit', v: TRUE }; }
    if (lw === 'false') { c.next(); return { k: 'lit', v: FALSE }; }
    c.next(); return { k: 'field', name: t.v, line: t.line };
  }
  throw new ScriptError(`Esperava um campo ou valor e encontrou ${desc(t)}.`, t.line);
}
const hasAgg = n => !n ? false : n.k === 'agg' ? true : n.k === 'bin' ? hasAgg(n.a) || hasAgg(n.b) : n.k === 'un' ? hasAgg(n.a) : n.k === 'fn' ? n.args.some(hasAgg) : false;
function exprText(n) {
  switch (n.k) {
    case 'lit': return typeof n.v === 'string' ? `'${n.v}'` : String(n.v);
    case 'field': return n.name;
    case 'fn': return `${n.label}(${n.args.map(exprText).join(', ')})`;
    case 'agg': return `${n.fn[0].toUpperCase() + n.fn.slice(1)}(${n.star ? '*' : (n.distinct ? 'DISTINCT ' : '') + n.args.map(exprText).join(', ')})`;
    case 'un': return n.op === 'not' ? `NOT ${exprText(n.a)}` : `-${exprText(n.a)}`;
    default: return `${exprText(n.a)} ${n.op} ${exprText(n.b)}`;
  }
}

// ---------------- compilação de expressões ----------------
// ctx: { field(name, line) -> getter | null, types: tipo de campo, run (estado do script) }
function compile(n, ctx) {
  switch (n.k) {
    case 'lit': { const v = n.v; return () => v; }
    case 'field': {
      const g = ctx.field(n.name);
      if (!g) throw new ScriptError(`Campo não encontrado: ${n.name}. Campos disponíveis: ${ctx.fieldNames().slice(0, 25).join(', ')}${ctx.fieldNames().length > 25 ? '…' : ''}`, n.line);
      return g;
    }
    case 'agg': {
      const g = ctx.agg && ctx.agg(n);
      if (!g) throw new ScriptError(`${exprText(n)}: funções de agregação (Sum, Count…) só valem num LOAD com GROUP BY ou num LOAD que só tenha agregações.`, n.line);
      return g;
    }
    case 'un': {
      const a = compile(n.a, ctx);
      if (n.op === 'not') return i => truthy(a(i)) ? FALSE : TRUE;
      return i => { const v = num(a(i)); return v === null ? null : -v; };
    }
    case 'bin': {
      const a = compile(n.a, ctx), b = compile(n.b, ctx);
      switch (n.op) {
        case 'or': return i => truthy(a(i)) || truthy(b(i)) ? TRUE : FALSE;
        case 'and': return i => truthy(a(i)) && truthy(b(i)) ? TRUE : FALSE;
        case '&': return i => str(a(i)) + str(b(i));
        case '+': return i => { const x = num(a(i)), y = num(b(i)); return x === null || y === null ? null : x + y; };
        case '-': return i => { const x = num(a(i)), y = num(b(i)); return x === null || y === null ? null : x - y; };
        case '*': return i => { const x = num(a(i)), y = num(b(i)); return x === null || y === null ? null : x * y; };
        case '/': return i => { const x = num(a(i)), y = num(b(i)); return x === null || y === null || y === 0 ? null : x / y; };
        case 'like': return i => { const x = a(i); return x === null ? FALSE : wild(str(b(i))).test(str(x)) ? TRUE : FALSE; };
        default: {
          const test = { '=': r => r === 0, '<>': r => r !== 0, '<': r => r < 0, '>': r => r > 0, '<=': r => r <= 0, '>=': r => r >= 0 }[n.op];
          // com vazio: "=" e "<" ">" são falsos; "<>" é verdadeiro se só um lado for vazio
          return i => {
            const x = a(i), y = b(i);
            if (x == null || y == null) return n.op === '<>' && (x == null) !== (y == null) ? TRUE : FALSE;
            return test(cmp(x, y)) ? TRUE : FALSE;
          };
        }
      }
    }
    case 'fn': return compileFn(n, ctx);
  }
}
function compileFn(n, ctx) {
  const run = ctx.run;
  const argc = n.args.length;
  if (n.name === 'if') {
    if (argc < 2) throw new ScriptError('If precisa de pelo menos 2 argumentos: If(condição, valor_se_sim, valor_se_não).', n.line);
    const [c, a, b] = n.args.map(x => compile(x, ctx));
    return b ? i => truthy(c(i)) ? a(i) : b(i) : i => truthy(c(i)) ? a(i) : null;
  }
  if (n.name === 'applymap') {
    if (argc < 2 || n.args[0].k !== 'lit') throw new ScriptError("ApplyMap precisa do nome do mapa entre aspas: ApplyMap('MapaNome', Campo, 'padrão').", n.line);
    const mp = run.maps.get(String(n.args[0].v)) || run.maps.get(String(n.args[0].v).toLowerCase());
    if (!mp) throw new ScriptError(`Mapa "${n.args[0].v}" não existe. Crie antes com: ${n.args[0].v}: MAPPING LOAD chave, valor FROM ...;`, n.line);
    const k = compile(n.args[1], ctx), d = argc > 2 ? compile(n.args[2], ctx) : null;
    return i => { const key = k(i); const v = mp.m.get(keyOf(key)) ?? mp.m.get(keyOf(num(key) ?? key)); return v !== undefined ? v : d ? d(i) : key; };
  }
  if (n.name === 'exists') {
    if (!argc || argc > 2) throw new ScriptError('Exists(campo) ou Exists(campo, valor).', n.line);
    const fname = n.args[0].k === 'field' ? n.args[0].name : n.args[0].k === 'lit' ? String(n.args[0].v) : null;
    if (!fname) throw new ScriptError('O 1º argumento de Exists deve ser o nome de um campo.', n.line);
    const set = run.existsSet(fname);
    const v = argc === 2 ? compile(n.args[1], ctx) : (ctx.field(fname) || (() => { throw new ScriptError(`Exists(${fname}): o campo não está nesta tabela; use Exists(${fname}, valor).`, n.line); })());
    return i => set.has(keyOf(v(i))) ? TRUE : FALSE;
  }
  if (n.name === 'recno') return i => i + 1;
  if (n.name === 'rowno') return () => ctx.rowNo();
  if (n.name === 'autonumber') {
    const v = compile(n.args[0], ctx);
    const id = argc > 1 && n.args[1].k === 'lit' ? String(n.args[1].v) : '__' + exprText(n.args[0]);
    if (!run.autonum.has(id)) run.autonum.set(id, new Map());
    const m = run.autonum.get(id);
    return i => { const k = keyOf(v(i)); let x = m.get(k); if (x === undefined) { x = m.size + 1; m.set(k, x); } return x; };
  }
  const def = F[n.name];
  const fs = n.args.map(x => compile(x, ctx));
  const f = def.f;
  if (argc === 0) return () => f();
  if (argc === 1) { const a = fs[0]; return i => f(a(i)); }
  if (argc === 2) { const a = fs[0], b = fs[1]; return i => f(a(i), b(i)); }
  if (argc === 3) { const a = fs[0], b = fs[1], c = fs[2]; return i => f(a(i), b(i), c(i)); }
  return i => f(...fs.map(g => g(i)));
}
// tipo do resultado de uma expressão
function typeOf(n, ctx) {
  switch (n.k) {
    case 'lit': return typeof n.v === 'number' ? 'number' : 'text';
    case 'field': return ctx.typeOfField(n.name) || 'text';
    case 'un': return 'number';
    case 'bin': return n.op === '&' ? 'text' : 'number';
    case 'agg': return ['min', 'max', 'only', 'firstvalue', 'lastvalue'].includes(n.fn) && n.args[0] ? typeOf(n.args[0], ctx) : n.fn === 'concat' ? 'text' : 'number';
    case 'fn': {
      if (n.name === 'applymap') { const mp = ctx.run.maps.get(String(n.args[0].v)); return mp ? mp.type : 'text'; }
      if (n.name === 'exists' || n.name === 'recno' || n.name === 'rowno' || n.name === 'autonumber') return 'number';
      const t = F[n.name].t;
      if (t !== 'branch') return t;
      const branches = n.name === 'if' ? n.args.slice(1) : n.name === 'pick' ? n.args.slice(1) : n.args;
      const ts = branches.filter(b => !(b.k === 'fn' && b.name === 'null')).map(b => typeOf(b, ctx));
      return ts.length && ts.every(x => x === ts[0]) ? ts[0] : 'text';
    }
  }
  return 'text';
}

// campos usados por uma expressão (null = usa algo que muda por linha, como RowNo)
function fieldsOf(n, out = new Set()) {
  if (!n) return out;
  if (n.k === 'field') out.add(n.name);
  else if (n.k === 'bin') { fieldsOf(n.a, out); fieldsOf(n.b, out); }
  else if (n.k === 'un') fieldsOf(n.a, out);
  else if (n.k === 'fn') {
    if (['rowno', 'recno', 'autonumber', 'exists', 'today'].includes(n.name)) { out.add('\u0000linha'); return out; }
    n.args.forEach(a => fieldsOf(a, out));
  } else if (n.k === 'agg') out.add('\u0000linha');
  return out;
}

// ---------------- colunas ----------------
function coerce(type, v) {
  if (v === null || v === undefined) return null;
  if (type === 'number') return typeof v === 'number' ? (Number.isFinite(v) ? v : null) : num(v);
  if (type === 'date') return typeof v === 'number' ? partsToISO(serialToParts(v)) : (toISODate(v, true) || null);
  return typeof v === 'number' ? fmtNum(v) : String(v);
}
function buildColumn(name, type, count, valueAt) {
  const b = ColTable.builder([{ name, type }]);
  const row = [null];
  for (let r = 0; r < count; r++) { row[0] = coerce(type, valueAt(r)); b.push(row); }
  return b.finish().cols[0];
}
// pega as linhas idx (Int32Array; -1 = vazio) de uma coluna, compactando o dicionário
function gather(col, idx, name = col.name) {
  const len = idx.length;
  if (col.num) {
    const a = col.num, out = new Float64Array(len);
    for (let j = 0; j < len; j++) { const i = idx[j]; out[j] = i < 0 ? NaN : a[i]; }
    return { name, type: col.type, num: out };
  }
  const codes = col.codes, d = col.dict;
  const remap = new Int32Array(d.length).fill(-1);
  remap[0] = 0;
  const dict = [null];
  const out = d.length < 256 ? new Uint8Array(len) : d.length < 65536 ? new Uint16Array(len) : new Uint32Array(len);
  for (let j = 0; j < len; j++) {
    const i = idx[j];
    if (i < 0) { out[j] = 0; continue; }
    const c = codes[i];
    let r = remap[c];
    if (r < 0) { r = remap[c] = dict.length; dict.push(d[c]); }
    out[j] = r;
  }
  const codes2 = dict.length < 256 && !(out instanceof Uint8Array) ? Uint8Array.from(out) : out;
  return { name, type: col.type, dict, codes: codes2 };
}
const renameCol = (c, name) => ({ ...c, name });
// valor da expressão quando o campo está vazio
function fn0(node, fctx) { return compile(node, { ...fctx, field: nm => { const g = fctx.field(nm); return g ? () => null : null; } })(0); }
// monta a coluna a partir do valor calculado para cada código do dicionário da fonte
function columnFromCodes(name, type, vals, codes, idx, count) {
  if (type === 'number') {
    const out = new Float64Array(count);
    for (let r = 0; r < count; r++) { const v = vals[codes[idx ? idx[r] : r]]; out[r] = v === null ? NaN : v; }
    return { name, type, num: out };
  }
  const map = new Map(), dict = [null];
  const remap = vals.map(v => { if (v === null) return 0; let k = map.get(v); if (k === undefined) { k = dict.length; dict.push(v); map.set(v, k); } return k; });
  const out = dict.length < 256 ? new Uint8Array(count) : dict.length < 65536 ? new Uint16Array(count) : new Uint32Array(count);
  for (let r = 0; r < count; r++) out[r] = remap[codes[idx ? idx[r] : r]];
  // tira do dicionário valores que não aparecem nas linhas escolhidas
  if (idx) { const tmp = { dict, codes: out }; return gather({ name, type, ...tmp }, Int32Array.from({ length: count }, (_, r) => r)); }
  return { name, type, dict, codes: out };
}

function uniqueNames(specs) {
  const seen = new Map();
  for (const s of specs) {
    const k = s.name.toLowerCase();
    if (seen.has(k)) throw new ScriptError(`O campo "${s.name}" aparece duas vezes no mesmo LOAD. Use AS para dar outro nome.`, s.line);
    seen.set(k, 1);
  }
}

// ---------------- execução ----------------
export function runScript(src, sources /* { nome: ColTable } */, opts = {}) {
  const t0 = performance.now();
  const log = [];
  const tables = new Map();   // nome -> ColTable (ordem de criação)
  const run = {
    maps: new Map(), vars: new Map(), autonum: new Map(), _exists: null,
    existsSet(field) {
      if (!this._exists) this._exists = new Map();
      if (!this._exists.has(field)) {
        const set = new Set();
        for (const t of tables.values()) {
          const c = t.col(field);
          if (!c) continue;
          if (c.dict) for (let k = 1; k < c.dict.length; k++) set.add(keyOf(c.dict[k]));
          else for (let i = 0; i < t.n; i++) { const v = c.num[i]; if (v === v) set.add(keyOf(v)); }
        }
        this._exists.set(field, set);
      }
      return this._exists.get(field);
    }
  };
  // depuração: lê só as primeiras N linhas de cada fonte
  const limitCache = new Map();
  const limited = s => {
    if (!opts.limit || s.t.n <= opts.limit) return s.t;
    if (!limitCache.has(s.name)) limitCache.set(s.name, s.t.slice(opts.limit));
    return limitCache.get(s.name);
  };
  const srcByName = new Map();
  for (const [name, t] of Object.entries(sources || {})) {
    srcByName.set(name.toLowerCase(), { name, t });
    srcByName.set(name.toLowerCase().replace(/\.(qvd|csv|xlsx?|txt)$/, ''), { name, t });
  }
  const findSource = (raw, line) => {
    let s = String(raw).trim().replace(/\\/g, '/');
    const base = s.split('/').pop();
    const keys = [s, base, base.replace(/\.(qvd|csv|xlsx?|txt)$/i, '')].map(x => x.toLowerCase());
    for (const k of keys) if (srcByName.has(k)) return srcByName.get(k);
    const avail = Object.keys(sources || {});
    throw new ScriptError(`Fonte "${raw}" não encontrada. ${avail.length ? 'Fontes do app: ' + avail.map(x => `[${x}]`).join(', ') + '.' : 'Adicione a tabela no Gerenciador de dados.'}`, line);
  };
  const findTable = (name, line) => {
    if (tables.has(name)) return name;
    const k = [...tables.keys()].find(x => x.toLowerCase() === String(name).toLowerCase());
    if (k) return k;
    throw new ScriptError(`Tabela "${name}" não existe neste ponto do script. Tabelas carregadas: ${[...tables.keys()].join(', ') || 'nenhuma'}.`, line);
  };
  const logT = (name, t, ms, extra = '') => log.push({ kind: 'table', text: `${name}: ${t.n.toLocaleString('pt-BR')} linhas, ${t.cols.length} campos${extra} (${ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1).replace('.', ',') + ' s'})` });

  let toks;
  try { toks = tokenize(src || ''); } catch (e) { return fail(e); }
  const c = new Cursor(toks);
  let anon = 0;
  let lastLine = 1;

  function fail(e) {
    const line = e.line || lastLine;
    log.push({ kind: 'error', line, text: (e instanceof ScriptError ? '' : 'Erro interno: ') + e.message + (line ? ` (linha ${line})` : '') });
    if (!(e instanceof ScriptError)) console.error(e);
    return { ok: false, error: e.message, line, log, tables: [...tables].map(([name, t]) => ({ name, t })), ms: performance.now() - t0 };
  }

  // troca $(var) pelo valor da variável até o fim do comando
  function expandUntilSemicolon() {
    let p = c.p;
    while (p < c.t.length && !(c.t[p].type === 'op' && c.t[p].v === ';') && c.t[p].type !== 'eof') {
      const t = c.t[p];
      if (t.type === 'expand') {
        const v = run.vars.get(t.v.toLowerCase());
        if (v === undefined) throw new ScriptError(`Variável $(${t.v}) não foi definida (use SET ou LET antes).`, t.line);
        const sub = tokenize(String(v)).slice(0, -1).map(x => ({ ...x, line: t.line }));
        c.t.splice(p, 1, ...sub);
        p += sub.length;
        continue;
      }
      p++;
    }
  }
  const restText = () => {   // texto bruto até o ';'
    const st = c.peek().start;
    while (!c.isOp(';') && c.peek().type !== 'eof') c.next();
    return src.slice(st, c.peek().start).trim();
  };
  const endStmt = () => {
    if (c.peek().type === 'eof') return;
    if (!c.eatOp(';')) throw new ScriptError(`Esperava ";" no fim do comando e encontrou ${desc(c.peek())}.`, c.peek().line);
  };
  const nameTok = what => {
    const t = c.next();
    if (t.type === 'name' || t.type === 'id' || t.type === 'str') return t.v;
    throw new ScriptError(`Esperava ${what} e encontrou ${desc(t)}.`, t.line);
  };
  const nameList = what => { const out = [nameTok(what)]; while (c.eatOp(',')) out.push(nameTok(what)); return out; };

  try {
    while (c.peek().type !== 'eof') {
      run._exists = null;
      if (c.eatOp(';')) continue;
      lastLine = c.peek().line;
      // depuração: para antes do comando que começa depois da linha escolhida
      if (opts.stopLine && c.peek().line > opts.stopLine) { log.push({ kind: 'info', text: `Depuração parada na linha ${opts.stopLine}: os comandos seguintes não foram executados.` }); break; }
      expandUntilSemicolon();
      const line = c.peek().line;
      const st = performance.now();

      // REM ... ;
      if (c.isKw('rem')) { restText(); endStmt(); continue; }
      if (c.isKw('trace')) { c.next(); log.push({ kind: 'trace', text: restText() }); endStmt(); continue; }
      if (c.isKw('exit')) { c.next(); c.eatKw('script'); log.push({ kind: 'info', text: `EXIT SCRIPT na linha ${line}.` }); break; }
      if (c.isKw('set') || c.isKw('let')) {
        const isLet = c.next().v.toLowerCase() === 'let';
        const vname = nameTok('o nome da variável');
        c.expectOp('=', 'depois do nome da variável');
        if (isLet) {
          const e = parseExpr(c);
          const fn = compile(e, { run, field: () => null, fieldNames: () => [], typeOfField: () => null, rowNo: () => 0 });
          run.vars.set(vname.toLowerCase(), str(fn(0)));
        } else run.vars.set(vname.toLowerCase(), restText().replace(/^'(.*)'$/s, '$1'));
        endStmt(); continue;
      }
      if (c.isKw('drop')) {
        c.next();
        if (c.eatKw('table') || c.eatKw('tables')) {
          for (const nm of nameList('o nome da tabela')) tables.delete(findTable(nm, line));
          endStmt(); continue;
        }
        if (c.eatKw('field') || c.eatKw('fields')) {
          const fields = nameList('o nome do campo');
          const from = c.eatKw('from') ? nameList('o nome da tabela').map(x => findTable(x, line)) : [...tables.keys()];
          let found = false;
          for (const tn of from) {
            const t = tables.get(tn);
            const keep = t.cols.filter(col => !fields.some(f => f.toLowerCase() === col.name.toLowerCase()));
            if (keep.length !== t.cols.length) { found = true; tables.set(tn, new ColTable(t.n, keep)); }
          }
          if (!found) throw new ScriptError(`DROP FIELD: campo ${fields.join(', ')} não encontrado.`, line);
          for (const [tn, t] of [...tables]) if (!t.cols.length) tables.delete(tn);
          endStmt(); continue;
        }
        throw new ScriptError('Use DROP TABLE nome; ou DROP FIELD campo [FROM tabela];', line);
      }
      if (c.isKw('rename')) {
        c.next();
        const isField = c.eatKw('field') || c.eatKw('fields');
        const isTable = !isField && (c.eatKw('table') || c.eatKw('tables'));
        if (!isField && !isTable) throw new ScriptError('Use RENAME FIELD a TO b; ou RENAME TABLE a TO b;', line);
        do {
          const a = nameTok('o nome atual'); c.expectKw('to'); const b = nameTok('o nome novo');
          if (isTable) {
            const k = findTable(a, line);
            const entries = [...tables].map(([nm, t]) => nm === k ? [b, t] : [nm, t]);
            tables.clear(); entries.forEach(([nm, t]) => tables.set(nm, t));
          } else {
            let found = false;
            for (const [tn, t] of tables) {
              if (!t.has(a)) continue;
              if (t.has(b)) throw new ScriptError(`RENAME FIELD: a tabela ${tn} já tem um campo "${b}".`, line);
              found = true;
              tables.set(tn, new ColTable(t.n, t.cols.map(col => col.name === a ? renameCol(col, b) : col)));
            }
            if (!found) throw new ScriptError(`RENAME FIELD: campo "${a}" não encontrado.`, line);
          }
        } while (c.eatOp(','));
        endStmt(); continue;
      }
      if (c.isKw('select') || c.isKw('sql')) throw new ScriptError('SQL SELECT ainda não está disponível (virá com o conector Protheus). Use LOAD … FROM [tabela do Gerenciador].', line);
      if (c.isKw('store')) throw new ScriptError('STORE não é necessário aqui: as tabelas do script já ficam no app.', line);

      // ---------- LOAD com prefixos ----------
      let label = null;
      if ((c.peek().type === 'id' || c.peek().type === 'name') && c.isOp(':', 1) && !c.isKw('load')) { label = c.next().v; c.next(); }
      let mapping = false, noconcat = false, concatTo = undefined, join = null, joinTo = undefined, keep = false;
      for (;;) {
        if (c.eatKw('mapping')) { mapping = true; continue; }
        if (c.eatKw('noconcatenate')) { noconcat = true; continue; }
        if (c.eatKw('concatenate')) {
          concatTo = null;
          if (c.isOp('(')) { c.next(); concatTo = nameTok('o nome da tabela'); c.expectOp(')'); }
          continue;
        }
        const jk = ['left', 'right', 'inner', 'outer'].find(w => c.isKw(w) && (c.isKw('join', 1) || c.isKw('keep', 1)));
        if (jk || c.isKw('join')) {
          join = jk || 'outer'; if (jk) c.next();
          if (c.eatKw('keep')) keep = true; else c.next();
          joinTo = null;
          if (c.isOp('(')) { c.next(); joinTo = nameTok('o nome da tabela'); c.expectOp(')'); }
          continue;
        }
        break;
      }
      if (!c.isKw('load')) {
        const t = c.peek();
        throw new ScriptError(label ? `Depois do rótulo "${label}:" esperava LOAD e encontrou ${desc(t)}.` : `Comando desconhecido: ${desc(t)}. Esperava LOAD, DROP, RENAME, SET, LET ou um rótulo "Tabela:".`, t.line);
      }
      if (keep) throw new ScriptError('KEEP ainda não é suportado; use JOIN ou WHERE Exists(...).', line);
      c.next();
      const distinct = c.eatKw('distinct');

      // lista de campos
      const items = [];
      {
        do {
          if (c.isOp('*')) { c.next(); items.push({ star: true }); continue; }
          const tline = c.peek().line;
          const node = parseExpr(c);
          let alias = null;
          if (c.eatKw('as')) alias = nameTok('o nome do campo depois de AS');
          if (!alias && node.k !== 'field') throw new ScriptError(`Dê um nome ao campo calculado com AS: ${exprText(node)} AS NomeDoCampo`, tline);
          items.push({ node, name: alias || node.name, line: tline });
        } while (c.eatOp(','));
      }

      // de onde
      let input, inputName, inlineCols = null;
      if (c.eatKw('from')) {
        const t = c.next();
        if (!['name', 'id', 'str'].includes(t.type)) throw new ScriptError(`Depois de FROM esperava o nome da fonte entre colchetes, ex.: FROM [vendas]. Encontrou ${desc(t)}.`, t.line);
        let raw = t.v;
        // FROM lib://pasta/arquivo.qvd (qvd) — junta o caminho e ignora as opções
        while (c.isOp(':') || c.isOp('/') || (c.peek().type === 'id' && c.peek().start === c.t[c.p - 1].end)) raw += c.next().v;
        if (c.isOp('(')) { let depth = 0; do { if (c.isOp('(')) depth++; if (c.isOp(')')) depth--; c.next(); } while (depth > 0 && c.peek().type !== 'eof'); }
        const s = findSource(raw, t.line);
        input = limited(s); inputName = s.name;
      } else if (c.eatKw('resident')) {
        const nm = findTable(nameTok('o nome da tabela'), line);
        input = tables.get(nm); inputName = nm;
      } else if (c.eatKw('inline')) {
        const t = c.next();
        if (t.type !== 'name') throw new ScriptError('INLINE precisa do conteúdo entre colchetes: INLINE [ campo1, campo2 \n valor1, valor2 ].', t.line);
        input = parseInline(t.v, t.line); inputName = label || 'Inline';
        if (c.isOp('(')) { let depth = 0; do { if (c.isOp('(')) depth++; if (c.isOp(')')) depth--; c.next(); } while (depth > 0 && c.peek().type !== 'eof'); }
      } else if (c.isKw('autogenerate')) {
        throw new ScriptError('AUTOGENERATE ainda não é suportado.', line);
      } else {
        throw new ScriptError(`Esperava FROM, RESIDENT ou INLINE e encontrou ${desc(c.peek())}. Ex.: LOAD * FROM [vendas];`, c.peek().line);
      }
      let whereNode = null, groupBy = null;
      if (c.eatKw('where')) whereNode = parseExpr(c);
      else if (c.eatKw('while')) throw new ScriptError('WHILE ainda não é suportado.', line);
      if (c.isKw('group')) { c.next(); c.expectKw('by'); groupBy = []; do { groupBy.push(parseExpr(c)); } while (c.eatOp(',')); }
      if (c.isKw('order')) { c.next(); c.expectKw('by'); do { parseExpr(c); c.eatKw('asc') || c.eatKw('desc'); } while (c.eatOp(',')); }
      endStmt();

      // ---------- avaliação ----------
      const inCols = new Map(input.cols.map(col => [col.name, col]));
      const inLower = new Map(input.cols.map(col => [col.name.toLowerCase(), col.name]));
      const resolveName = nm => inCols.has(nm) ? nm : inLower.get(String(nm).toLowerCase());
      let rowNoVal = 0;
      const ctx = {
        run,
        field: nm => { const r = resolveName(nm); return r ? input.getter(r) : null; },
        fieldNames: () => input.cols.map(x => x.name),
        typeOfField: nm => { const r = resolveName(nm); return r ? inCols.get(r).type : null; },
        rowNo: () => rowNoVal,
      };
      // * vira a lista de campos
      const specs = [];
      for (const it of items) {
        if (it.star) { for (const col of input.cols) specs.push({ name: col.name, node: { k: 'field', name: col.name }, plain: col.name }); continue; }
        const plain = it.node.k === 'field' ? resolveName(it.node.name) : null;
        specs.push({ ...it, plain });
      }
      uniqueNames(specs);
      const isAgg = !!groupBy || specs.some(s => hasAgg(s.node));
      let out;

      if (!isAgg) {
        const fns = specs.map(s => s.plain ? null : compile(s.node, ctx));
        // linhas que passam no WHERE
        let idx = null;
        if (whereNode) {
          const w = compile(whereNode, ctx);
          // Exists(campo) enxerga também as linhas que acabaram de ser lidas neste LOAD (padrão WHERE NOT Exists)
          const track = [];
          if (run._exists) for (const [f, set] of run._exists) {
            const s = specs.find(x => x.name.toLowerCase() === f.toLowerCase());
            if (s) track.push({ set, fn: s.plain ? input.getter(s.plain) : fns[specs.indexOf(s)] });
          }
          const tmp = new Int32Array(input.n);
          let k = 0;
          for (let i = 0; i < input.n; i++) {
            rowNoVal = k + 1;
            if (truthy(w(i))) { tmp[k++] = i; for (const tr of track) tr.set.add(keyOf(tr.fn(i))); }
          }
          idx = tmp.slice(0, k);
        }
        const count = idx ? idx.length : input.n;
        const cols = specs.map((s, j) => {
          if (s.plain) {
            const col = inCols.get(s.plain);
            return idx ? gather(col, idx, s.name) : renameCol(col, s.name);
          }
          const fn = fns[j];
          const type = typeOf(s.node, ctx);
          // atalho: expressão de um só campo de texto -> calcula uma vez por valor distinto
          const used = [...fieldsOf(s.node)];
          const src = used.length === 1 && inCols.get(resolveName(used[0]) || '');
          if (src && src.dict && src.dict.length < count) {
            const fctx = { ...ctx, field: nm => resolveName(nm) === src.name ? (k => src.dict[k]) : ctx.field(nm) };
            const f = compile(s.node, fctx);
            const vals = src.dict.map((_, k) => coerce(type, k === 0 ? fn0(s.node, fctx) : f(k)));
            return columnFromCodes(s.name, type, vals, src.codes, idx, count);
          }
          return buildColumn(s.name, type, count, idx ? r => { rowNoVal = r + 1; return fn(idx[r]); } : r => { rowNoVal = r + 1; return fn(r); });
        });
        out = new ColTable(count, cols);
      } else {
        out = groupLoad(input, specs, whereNode, groupBy, ctx);
      }
      if (distinct) out = distinctRows(out);

      // ---------- destino ----------
      const ms = () => performance.now() - st;
      if (mapping) {
        if (out.cols.length < 2) throw new ScriptError('MAPPING LOAD precisa de 2 campos: a chave e o valor.', line);
        const k = out.getter(out.cols[0].name), v = out.getter(out.cols[1].name);
        const m = new Map();
        for (let i = 0; i < out.n; i++) { const key = keyOf(k(i)); if (!m.has(key)) m.set(key, v(i)); }
        const mname = label || `Mapa${++anon}`;
        run.maps.set(mname, { m, type: out.cols[1].type });
        run.maps.set(mname.toLowerCase(), { m, type: out.cols[1].type });
        log.push({ kind: 'map', text: `${mname} (mapa): ${m.size.toLocaleString('pt-BR')} valores` });
        continue;
      }
      if (join) {
        const target = joinTo ? findTable(joinTo, line) : [...tables.keys()].pop();
        if (!target) throw new ScriptError('JOIN sem tabela anterior. Use LEFT JOIN (Tabela) LOAD …', line);
        const res = doJoin(tables.get(target), out, join, line);
        tables.set(target, res);
        logT(`${target} ← ${join.toUpperCase()} JOIN`, res, ms());
        continue;
      }
      if (concatTo !== undefined) {
        const target = concatTo ? findTable(concatTo, line) : [...tables.keys()].pop();
        if (!target) throw new ScriptError('CONCATENATE sem tabela anterior.', line);
        const res = concatTables(tables.get(target), out);
        tables.set(target, res);
        logT(`${target} ← CONCATENATE`, res, ms());
        continue;
      }
      // concatenação automática (mesmos campos de uma tabela já carregada)
      if (!noconcat) {
        const sig = out.cols.map(x => x.name).sort().join('\u0001');
        const same = [...tables].find(([, t]) => t.cols.map(x => x.name).sort().join('\u0001') === sig);
        if (same) {
          const res = concatTables(same[1], out);
          tables.set(same[0], res);
          logT(`${same[0]} ← mesmos campos, concatenada automaticamente`, res, ms());
          continue;
        }
      }
      let name = label || (inputName && !tables.has(inputName) ? inputName : `Tabela${++anon}`);
      if (tables.has(name)) { let k = 1; while (tables.has(`${name}-${k}`)) k++; name = `${name}-${k}`; }
      if (!out.cols.length) throw new ScriptError('O LOAD não gerou nenhum campo.', line);
      tables.set(name, out);
      logT(name, out, ms());
    }
  } catch (e) { return fail(e); }

  // avisos de modelo (campos em comum = ligações)
  const list = [...tables].map(([name, t]) => ({ name, t }));
  for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    const common = list[a].t.cols.map(x => x.name).filter(nm => list[b].t.has(nm));
    if (common.length > 1) log.push({ kind: 'warn', text: `${list[a].name} e ${list[b].name} se ligam por ${common.length} campos (${common.join(', ')}) — isso vira uma chave sintética. Renomeie ou crie uma chave única (ex.: A & '|' & B AS Chave).` });
  }
  if (!list.length) log.push({ kind: 'warn', text: 'O script terminou sem nenhuma tabela.' });
  const total = performance.now() - t0;
  if (opts.limit) log.unshift({ kind: 'info', text: `Depuração: lendo no máximo ${opts.limit.toLocaleString('pt-BR')} linhas de cada fonte. Nada é salvo no app.` });
  log.push({ kind: 'done', text: `${opts.limit || opts.stopLine ? 'Depuração concluída' : 'Carga concluída'}: ${list.length} tabela(s) em ${total < 1000 ? Math.round(total) + ' ms' : (total / 1000).toFixed(1).replace('.', ',') + ' s'}.` });
  return { ok: true, tables: list, log, ms: total };
}

// INLINE [ a, b \n 1, 2 ]
function parseInline(text, line) {
  const rows = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!rows.length) throw new ScriptError('INLINE vazio.', line);
  const split = l => l.split(',').map(x => x.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'));
  const head = split(rows[0]);
  const data = rows.slice(1).map(split);
  const columns = head.map((name, j) => {
    const vals = data.map(r => r[j]).filter(v => v !== undefined && v !== '');
    const isNum = vals.length && vals.every(v => /^-?\d+(\.\d+)?$/.test(v) && !/^-?0\d/.test(v));
    return { name, type: isNum ? 'number' : 'text' };
  });
  return ColTable.fromRows(columns, data.map(r => Object.fromEntries(columns.map((col, j) => {
    const v = r[j];
    return [col.name, v === undefined || v === '' ? null : col.type === 'number' ? Number(v) : v];
  }))));
}

function distinctRows(t) {
  const gs = t.cols.map(col => col.num ? (a => i => a[i])(col.num) : (k => i => k[i])(col.codes));
  const seen = new Set();
  const keep = new Int32Array(t.n);
  let k = 0;
  for (let i = 0; i < t.n; i++) {
    let key = '';
    for (const g of gs) key += g(i) + '\u0001';
    if (!seen.has(key)) { seen.add(key); keep[k++] = i; }
  }
  if (k === t.n) return t;
  const idx = keep.slice(0, k);
  return new ColTable(k, t.cols.map(col => gather(col, idx)));
}

function concatTables(a, b) {
  const names = [...a.cols.map(x => x.name), ...b.cols.map(x => x.name).filter(nm => !a.has(nm))];
  const columns = names.map(nm => {
    const ta = a.col(nm)?.type, tb = b.col(nm)?.type;
    return { name: nm, type: ta && tb && ta !== tb ? 'text' : (ta || tb) };
  });
  const out = ColTable.builder(columns);
  for (const t of [a, b]) {
    const gs = columns.map(col => t.has(col.name) ? (g => i => coerce(col.type, g(i)))(t.getter(col.name)) : () => null);
    const row = new Array(gs.length);
    for (let i = 0; i < t.n; i++) { for (let j = 0; j < gs.length; j++) row[j] = gs[j](i); out.push(row); }
  }
  return out.finish();
}

function doJoin(A, B, kind, line) {
  const common = A.cols.map(x => x.name).filter(nm => B.has(nm));
  if (!common.length) throw new ScriptError(`JOIN sem campos em comum entre as tabelas. O JOIN liga pelos campos de mesmo nome (campos de A: ${A.cols.slice(0, 8).map(x => x.name).join(', ')}…).`, line);
  const ka = common.map(nm => A.getter(nm)), kb = common.map(nm => B.getter(nm));
  const keyA = i => { let s = ''; for (const g of ka) { const v = g(i); if (v === null) return null; s += keyOf(v) + '\u0001'; } return s; };
  const keyB = i => { let s = ''; for (const g of kb) { const v = g(i); if (v === null) return null; s += keyOf(v) + '\u0001'; } return s; };
  const map = new Map();
  for (let i = 0; i < B.n; i++) { const k = keyB(i); if (k === null) continue; const l = map.get(k); if (l) l.push(i); else map.set(k, [i]); }
  const ia = [], ib = [];
  const usedB = kind === 'outer' || kind === 'right' ? new Uint8Array(B.n) : null;
  for (let i = 0; i < A.n; i++) {
    const k = keyA(i);
    const l = k === null ? null : map.get(k);
    if (l) { for (const j of l) { ia.push(i); ib.push(j); if (usedB) usedB[j] = 1; } }
    else if (kind === 'left' || kind === 'outer') { ia.push(i); ib.push(-1); }
  }
  if (kind === 'right') {   // right: tira as linhas de A sem par (já não entraram) e junta as de B sem par
    for (let j = 0; j < B.n; j++) if (!usedB[j]) { ia.push(-1); ib.push(j); }
  }
  if (kind === 'outer') for (let j = 0; j < B.n; j++) if (!usedB[j]) { ia.push(-1); ib.push(j); }
  const IA = Int32Array.from(ia), IB = Int32Array.from(ib);
  const cols = [];
  for (const col of A.cols) {
    if (common.includes(col.name) && (kind === 'outer' || kind === 'right')) {
      const ga = A.getter(col.name), gb = B.getter(col.name);
      cols.push(buildColumn(col.name, col.type, IA.length, r => IA[r] >= 0 ? ga(IA[r]) : gb(IB[r])));
    } else cols.push(gather(col, IA));
  }
  for (const col of B.cols) if (!common.includes(col.name)) cols.push(gather(col, IB));
  return new ColTable(IA.length, cols);
}

// LOAD com agregação (GROUP BY)
function groupLoad(input, specs, whereNode, groupBy, ctx) {
  // linhas
  let idx;
  if (whereNode) {
    const w = compile(whereNode, ctx);
    const tmp = new Int32Array(input.n); let k = 0;
    for (let i = 0; i < input.n; i++) if (truthy(w(i))) tmp[k++] = i;
    idx = tmp.slice(0, k);
  } else { idx = new Int32Array(input.n); for (let i = 0; i < input.n; i++) idx[i] = i; }
  // grupos
  const gfns = (groupBy || []).map(g => compile(g, ctx));
  const groupOf = new Int32Array(idx.length);
  const first = [];
  if (!gfns.length) { first.push(idx[0] ?? -1); }
  else {
    const map = new Map();
    for (let r = 0; r < idx.length; r++) {
      const i = idx[r];
      let key = '';
      for (const g of gfns) key += keyOf(g(i)) + '\u0001';
      let gid = map.get(key);
      if (gid === undefined) { gid = first.length; map.set(key, gid); first.push(i); }
      groupOf[r] = gid;
    }
  }
  const G = first.length;
  const groupTexts = (groupBy || []).map(exprText).map(s => s.toLowerCase());
  // agregações: calcula um valor por grupo
  const aggCache = new Map();
  const aggValues = node => {
    const key = exprText(node);
    if (aggCache.has(key)) return aggCache.get(key);
    const arg = node.args[0] ? compile(node.args[0], ctx) : null;
    if (!node.star && !arg && node.fn !== 'count') throw new ScriptError(`${node.fn}() precisa de um argumento.`, node.line);
    const vals = new Array(G).fill(null);
    const fn = node.fn;
    if (fn === 'count') {
      const cnt = new Float64Array(G);
      if (node.star || !arg) for (let r = 0; r < idx.length; r++) cnt[groupOf[r]]++;
      else if (node.distinct) {
        const sets = Array.from({ length: G }, () => new Set());
        for (let r = 0; r < idx.length; r++) { const v = arg(idx[r]); if (v !== null && v !== undefined) sets[groupOf[r]].add(keyOf(v)); }
        sets.forEach((s, g) => { cnt[g] = s.size; });
      } else for (let r = 0; r < idx.length; r++) { const v = arg(idx[r]); if (v !== null && v !== undefined) cnt[groupOf[r]]++; }
      for (let g = 0; g < G; g++) vals[g] = cnt[g];
    } else if (fn === 'sum' || fn === 'avg') {
      const s = new Float64Array(G), n = new Float64Array(G);
      const seen = node.distinct ? Array.from({ length: G }, () => new Set()) : null;
      for (let r = 0; r < idx.length; r++) {
        const v = num(arg(idx[r]));
        if (v === null) continue;
        const g = groupOf[r];
        if (seen) { if (seen[g].has(v)) continue; seen[g].add(v); }
        s[g] += v; n[g]++;
      }
      for (let g = 0; g < G; g++) vals[g] = fn === 'sum' ? +s[g].toFixed(8) : n[g] ? s[g] / n[g] : null;
    } else if (fn === 'min' || fn === 'max') {
      const isNum = typeOf(node.args[0], ctx) === 'number';
      for (let r = 0; r < idx.length; r++) {
        const raw = arg(idx[r]);
        const v = isNum ? num(raw) : raw;
        if (v === null || v === undefined) continue;
        const g = groupOf[r], cur = vals[g];
        if (cur === null || (fn === 'min' ? cmp(v, cur) < 0 : cmp(v, cur) > 0)) vals[g] = v;
      }
    } else if (fn === 'only') {
      const multi = new Uint8Array(G);
      for (let r = 0; r < idx.length; r++) {
        const v = arg(idx[r]); if (v === null) continue;
        const g = groupOf[r];
        if (vals[g] === null) vals[g] = v; else if (keyOf(vals[g]) !== keyOf(v)) multi[g] = 1;
      }
      for (let g = 0; g < G; g++) if (multi[g]) vals[g] = null;
    } else if (fn === 'firstvalue' || fn === 'lastvalue') {
      for (let r = 0; r < idx.length; r++) { const v = arg(idx[r]); if (v === null) continue; const g = groupOf[r]; if (fn === 'lastvalue' || vals[g] === null) vals[g] = v; }
    } else if (fn === 'concat') {
      const sep = node.args[1] ? str(compile(node.args[1], ctx)(0)) : '';
      const sets = Array.from({ length: G }, () => new Set());
      for (let r = 0; r < idx.length; r++) { const v = arg(idx[r]); if (v !== null && v !== '') sets[groupOf[r]].add(str(v)); }
      sets.forEach((s, g) => { vals[g] = s.size ? [...s].sort().join(sep) : null; });
    }
    aggCache.set(key, vals);
    return vals;
  };
  // campos fora de agregação: precisam estar no GROUP BY
  const checkGrouped = (n, s) => {
    if (n.k === 'agg' || n.k === 'lit') return;
    if (groupTexts.includes(exprText(n).toLowerCase())) return;
    if (n.k === 'field') throw new ScriptError(`O campo "${n.name}" precisa estar no GROUP BY ou dentro de uma agregação (Sum, Count, Max…).`, s.line || n.line);
    if (n.k === 'bin') { checkGrouped(n.a, s); checkGrouped(n.b, s); }
    if (n.k === 'un') checkGrouped(n.a, s);
    if (n.k === 'fn') n.args.forEach(a => checkGrouped(a, s));
  };
  const gctx = {
    ...ctx,
    field: nm => { const g = ctx.field(nm); return g ? (gid => first[gid] < 0 ? null : g(first[gid])) : null; },
    agg: node => { const v = aggValues(node); return gid => v[gid]; },
  };
  const cols = specs.map(s => {
    checkGrouped(s.node, s);
    const fn = compile(s.node, gctx);
    return buildColumn(s.name, typeOf(s.node, ctx), G, fn);
  });
  // LOAD só com agregações e sem linhas: devolve 1 linha
  return new ColTable(G, cols);
}

// script inicial a partir das fontes do app
export function defaultScript(sources /* [{ name, columns }] */) {
  const q = s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `[${s}]`;
  const lines = [
    '// Script de carga do app — cada LOAD cria uma tabela do modelo.',
    '// As tabelas se ligam pelos campos com o mesmo nome.',
    '// Clique em ▶ Carregar dados para rodar.',
    ''
  ];
  for (const s of sources) {
    lines.push(`${q(s.name.replace(/[^\p{L}\p{N}_ -]/gu, '').trim() || 'Tabela')}:`);
    lines.push('LOAD');
    lines.push(s.columns.map((col, j) => `    ${q(col.name)}${j < s.columns.length - 1 ? ',' : ''}`).join('\n'));
    lines.push(`FROM [${s.name}];`, '');
  }
  return lines.join('\n');
}
