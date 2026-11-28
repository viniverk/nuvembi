// =============================================================
//  Resumir na importação (para arquivos grandes)
//  Agrupa pelas colunas de texto/data mantidas, soma as numéricas
//  e cria Qtd_Registros com a quantidade de linhas originais.
//  Datas podem ser agrupadas por mês ou ano; dá para importar só
//  a partir de uma data.
// =============================================================
import { parseQVD } from './qvd.js?v=35';
import { normalizeValue } from './parser.js?v=35';
import { ColTable } from './coltable.js?v=35';

// percorre todas as linhas do arquivo (QVD em fluxo, sem carregar tudo; Excel/CSV da memória)
function eachRow(sheet, visit) {
  if (sheet.qvd) parseQVD(sheet.qvd, { onRow: visit });
  else sheet.data.forEach(visit);
}

// importa o arquivo inteiro direto para tabela colunar (sem resumir)
// columns: [{ index, name, type }] · limit: máximo de linhas
export function ingest(sheet, columns, { limit = Infinity } = {}) {
  const b = ColTable.builder(columns.map(({ name, type }) => ({ name, type })));
  const vals = new Array(columns.length);
  let read = 0;
  eachRow(sheet, arr => {
    read++;
    if (b.size >= limit) return;
    for (let j = 0; j < columns.length; j++) vals[j] = normalizeValue(columns[j].type, arr[columns[j].index]);
    b.push(vals);
  });
  return { table: b.finish(), read };
}

export const COUNT_FIELD = 'Qtd_Registros';
export const SUM_GRAINS = { day: 'Dia', month: 'Mês', year: 'Ano' };

// columns: [{ index, name, type }] (nomes finais) · opts: { keep: [nomes], grains: { nome: 'month' }, from: 'aaaa-mm-dd', dateCol }
export function summarize(sheet, columns, opts) {
  const keep = new Set(opts.keep);
  const kept = columns.filter(c => keep.has(c.name));
  const dims = kept.filter(c => c.type !== 'number');
  const meas = kept.filter(c => c.type === 'number');
  const fromCol = opts.from && opts.dateCol ? columns.find(c => c.name === opts.dateCol) : null;
  const grains = opts.grains || {};
  const groups = new Map();
  let read = 0, used = 0;

  const visit = arr => {
    read++;
    if (fromCol) { const d = normalizeValue('date', arr[fromCol.index]); if (!d || d < opts.from) return; }
    used++;
    const dv = dims.map(c => {
      let v = normalizeValue(c.type, arr[c.index]);
      if (c.type === 'date' && v) {
        const g = grains[c.name] || 'day';
        if (g === 'month') v = v.slice(0, 7) + '-01'; else if (g === 'year') v = v.slice(0, 4) + '-01-01';
      }
      return v;
    });
    const key = dv.map(v => v === null ? '\u0000' : v).join('\u0001');
    let g = groups.get(key);
    if (!g) { g = { dv, sums: new Array(meas.length).fill(null), n: 0 }; groups.set(key, g); }
    g.n++;
    for (let i = 0; i < meas.length; i++) {
      const v = normalizeValue('number', arr[meas[i].index]);
      if (typeof v === 'number') g.sums[i] = (g.sums[i] || 0) + v;
    }
  };
  eachRow(sheet, visit);

  let countName = COUNT_FIELD;
  while (kept.some(c => c.name === countName)) countName += '_';
  const columnsOut = [...dims, ...meas].map(({ name, type }) => ({ name, type })).concat({ name: countName, type: 'number' });
  const b = ColTable.builder(columnsOut);
  for (const g of groups.values()) {
    b.push([...g.dv, ...g.sums.map(v => v === null ? null : Math.round(v * 1e6) / 1e6), g.n]);
  }
  const table = b.finish();
  return { table, rowCount: table.n, read, used, columns: columnsOut };
}
