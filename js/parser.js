// =============================================================
//  Leitura de Excel/CSV e detecção automática de tipos
//  - Entende números no formato brasileiro (1.234,56 / R$ 10,00)
//  - Entende datas dd/mm/aaaa, aaaa-mm-dd e o formato do
//    Protheus aaaammdd (ex.: D2_EMISSAO = 20241115)
//  - Mantém códigos com zero à esquerda como texto (000123)
//  - Remove os espaços que o Protheus deixa nos campos char
// =============================================================

const DATE_HINT = /(^|_)(data|dt|emis|emissao|venc|vencto|vencimento|dtdigit|entrega)|data|^dt/i;
// nomes de campos que são códigos (nunca somados): Protheus, fiscais (NF-e, CFOP, CST…) e chaves com % no início (%Chave)
const CODE_WORDS = new Set(['cod', 'codigo', 'id', 'cnpj', 'cpf', 'cep', 'filial', 'fil', 'nota', 'doc', 'documento', 'nf', 'nfe', 'serie',
  'pedido', 'num', 'numero', 'nro', 'nr', 'no', 'docto', 'dcto', 'titulo', 'parcela', 'prefixo', 'matricula', 'registro', 'protocolo', 'loja', 'tel', 'fone', 'chave', 'cfop', 'ncm', 'cst', 'csosn', 'sit', 'situacao', 'tes', 'cest', 'ean', 'gtin', 'sku', 'lote', 'item', 'conta', 'cc']);
export const isCodeName = name => {
  if (/^\s*%/.test(name)) return true;
  const words = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some(w => CODE_WORDS.has(w));
};

import { parseQVD } from './qvd.js?v=21';

// ---------- leitura do arquivo ----------
export async function readFile(file, { maxRows = Infinity } = {}) {
  const name = file.name.toLowerCase();
  if (file.size > 600 * 1024 * 1024) throw new Error('Arquivo maior que 600 MB — grande demais para abrir no navegador.');
  const buf = await file.arrayBuffer();

  // QVD: já vem com tipos (números, datas e textos)
  if (name.endsWith('.qvd')) {
    const q = parseQVD(buf, { maxRows });
    const t = buildTable([q.header, ...q.rows]);
    return [{ name: q.name, ...t, total: q.total, qvd: buf }];
  }

  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = decodeText(buf);
    return [{ name: 'CSV', ...buildTable(parseCSV(text)) }];
  }

  if (!window.XLSX) throw new Error('Biblioteca de Excel não carregou. Verifique sua internet.');
  const wb = window.XLSX.read(buf, { type: 'array', cellDates: true });
  return wb.SheetNames.map(sheetName => {
    const arrays = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1, defval: null, raw: true, blankrows: false
    });
    return { name: sheetName, ...buildTable(arrays) };
  }).filter(s => s.columns.length);
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); } // CSV salvo pelo Excel em PT-BR
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = [';', ',', '\t', '|']
    .map(d => [d, firstLine.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// ---------- montagem da tabela ----------
export function buildTable(arrays) {
  if (!arrays || !arrays.length) return { columns: [], data: [] };
  const width = Math.max(...arrays.slice(0, 50).map(r => r.length));
  const used = new Set();
  const columns = [];
  for (let i = 0; i < width; i++) {
    let name = cleanHeader(arrays[0][i], i);
    let base = name, n = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${n++}`;
    used.add(name.toLowerCase());
    columns.push({ name, index: i, type: 'text' });
  }
  const data = arrays.slice(1);
  for (const col of columns) {
    col.type = inferType(col.name, data.map(r => r[col.index]));
  }
  return { columns, data };
}

function cleanHeader(h, i) {
  let s = h instanceof Date ? toISODate(h) : String(h ?? '').trim();
  s = s.replace(/[.\[\]\/]/g, '_').replace(/\s+/g, ' ').replace(/^_+|_+$/g, '');
  return s || `Coluna_${i + 1}`;
}

// ---------- tipos ----------
export function inferType(name, values) {
  const vals = [];
  for (const v of values) {
    const t = typeof v === 'string' ? v.trim() : v;
    if (t !== null && t !== undefined && t !== '') vals.push(t);
    if (vals.length >= 500) break;
  }
  if (!vals.length) return 'text';
  const hintDate = DATE_HINT.test(name);
  let d = 0, n = 0, longDigits = 0;
  for (const v of vals) {
    // mais de 15 dígitos não cabe num número sem perder precisão (ex.: chave da NF-e com 44 dígitos)
    if (typeof v === 'string' && /^\d{16,}$/.test(v)) { longDigits++; continue; }
    if (toISODate(v, hintDate)) d++;
    else if (!Number.isNaN(toNumber(v))) n++;
  }
  if (longDigits) return 'text';
  if (d / vals.length >= 0.9) return 'date';
  if (isCodeName(name)) return 'text'; // códigos nunca são somados
  if (n / vals.length >= 0.9) return 'number';
  return 'text';
}

export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  let s = v.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } // (1.234,00) = negativo
  if (/^-?0\d+$/.test(s)) return NaN;                         // 000123 é código
  let out = NaN;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) out = Number(s.replace(/\./g, '').replace(',', '.'));
  else if (/^-?\d+,\d+$/.test(s)) out = Number(s.replace(',', '.'));
  else if (/^-?\d+(\.\d+)?$/.test(s)) out = Number(s);
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) out = Number(s.replace(/,/g, ''));
  return neg ? -out : out;
}

export function toISODate(v, allowCompact = false) {
  const fmt = (y, m, d) => {
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : fmt(v.getFullYear(), v.getMonth() + 1, v.getDate());
  const s = String(v ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return fmt(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})( .*)?$/))) return fmt(+m[3], +m[2], +m[1]);
  if (allowCompact && (m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return fmt(+m[1], +m[2], +m[3]);
  return null;
}

// ---------- normalização final (usa os tipos escolhidos) ----------
export function normalizeValue(type, v) {
  if (typeof v === 'string') v = v.trim();
  if (v === '' || v === undefined || v === null) return null;
  if (type === 'number') { v = toNumber(v); return Number.isNaN(v) ? null : v; }
  if (type === 'date') return toISODate(v, true);
  return v instanceof Date ? toISODate(v) : String(v);
}
export function normalizeRows(columns, data) {
  return data.map(arr => {
    const row = {};
    for (const col of columns) row[col.name] = normalizeValue(col.type, arr[col.index]);
    return row;
  });
}
