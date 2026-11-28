// =============================================================
//  Modelo associativo (várias tabelas ligadas pelos campos de mesmo nome)
//  — versão colunar: cada tabela é uma ColTable e as seleções são
//  listas de posições de linha (Uint32Array).
//
//  - Tabelas se ligam pelos campos com o MESMO NOME (campos-chave).
//  - Seleções filtram a tabela do campo e se propagam pelas chaves.
//  - Um gráfico pode usar a dimensão de uma tabela e a medida de
//    outra: o valor da dimensão é encontrado seguindo as ligações.
// =============================================================
import { ColTable } from './coltable.js?v=31';

export const keyOf = v => (v === null || v === undefined) ? '' : String(v);

// filtra posições com um teste por linha
function filterIdx(idx, test) {
  const out = new Uint32Array(idx.length);
  let k = 0;
  for (let j = 0; j < idx.length; j++) { const i = idx[j]; if (test(i)) out[k++] = i; }
  return k === idx.length ? idx : out.slice(0, k);
}

// teste "o valor do campo está no conjunto?" usando o dicionário (rápido)
function memberTest(t, field, accept /* (valor) => bool */) {
  const c = t.col(field);
  if (!c) return () => false;
  if (c.dict) {
    const mask = new Uint8Array(c.dict.length);
    for (let k = 0; k < c.dict.length; k++) mask[k] = accept(c.dict[k]) ? 1 : 0;
    const codes = c.codes;
    return i => mask[codes[i]] === 1;
  }
  const a = c.num;
  return i => { const v = a[i]; return accept(v !== v ? null : v); };
}

// valores distintos de um campo nas posições dadas (como texto, para casar chaves entre tabelas)
function keysIn(t, field, idx) {
  const c = t.col(field);
  const out = new Set();
  if (c.dict) {
    const seen = new Uint8Array(c.dict.length), codes = c.codes;
    for (let j = 0; j < idx.length; j++) seen[codes[idx[j]]] = 1;
    for (let k = 0; k < seen.length; k++) if (seen[k]) out.add(keyOf(c.dict[k]));
  } else {
    const a = c.num;
    for (let j = 0; j < idx.length; j++) { const v = a[idx[j]]; out.add(keyOf(v !== v ? null : v)); }
  }
  return out;
}

// data: { main: ColTable | linhas[], <id>: ... }
export function buildModel(ds, data) {
  const dataMap = Array.isArray(data) || data instanceof ColTable ? { main: data } : (data || {});
  const asTable = (v, columns) => v instanceof ColTable ? v : ColTable.fromRows(columns, v || []);
  const tables = [
    { id: 'main', name: ds.mainName || ds.name || 'Principal', columns: ds.columns || [] },
    ...(ds.tables || []).map(t => ({ id: t.id, name: t.name, columns: t.columns || [] }))
  ].map(t => { const ct = asTable(dataMap[t.id], t.columns); return { ...t, t: ct, n: ct.n }; })
   .filter(t => t.columns.length);   // app pode não ter tabela principal (app vazio + tabelas adicionadas)
  const byId = Object.fromEntries(tables.map(t => [t.id, t]));

  const fieldMap = new Map();
  for (const t of tables) for (const c of t.columns) {
    if (!fieldMap.has(c.name)) fieldMap.set(c.name, { name: c.name, type: c.type, tables: [] });
    fieldMap.get(c.name).tables.push(t.id);
  }
  const fields = [...fieldMap.values()];
  const keys = fields.filter(f => f.tables.length > 1).map(f => f.name);
  const tablesOf = f => fieldMap.get(f)?.tables || [];
  const has = (tid, f) => tablesOf(f).includes(tid);

  // ---------- seleções associativas -> { tabela: Uint32Array de posições } ----------
  function select(filters, dateCol) {
    const preds = [];
    for (const [f, vals] of Object.entries(filters || {})) {
      if (!vals || !vals.length) continue;
      const set = new Set(vals.map(String));
      if (f === '__year' || f === '__month') {
        if (!dateCol) continue;
        const cut = f === '__year' ? (d => (d || '').slice(0, 4)) : (d => (d || '').slice(5, 7));
        preds.push({ field: dateCol, accept: v => set.has(cut(v)) });
      } else {
        preds.push({ field: f, accept: v => set.has(v === null || v === undefined ? '(vazio)' : String(v)) });
      }
    }
    const cur = {};
    const restricted = new Set();
    for (const t of tables) {
      let idx = t.t.allIdx();
      for (const p of preds) if (has(t.id, p.field)) { idx = filterIdx(idx, memberTest(t.t, p.field, p.accept)); restricted.add(t.id); }
      cur[t.id] = idx;
    }
    // propaga pelas chaves até estabilizar (só tabelas já reduzidas restringem as outras)
    for (let loop = 0, changed = true; changed && loop < 25; loop++) {
      changed = false;
      for (const k of keys) {
        const rt = tablesOf(k).filter(id => restricted.has(id));
        if (!rt.length) continue;
        let allowed = null;
        for (const id of rt) {
          const s = keysIn(byId[id].t, k, cur[id]);
          allowed = allowed ? new Set([...allowed].filter(v => s.has(v))) : s;
        }
        for (const id of tablesOf(k)) {
          const next = filterIdx(cur[id], memberTest(byId[id].t, k, v => allowed.has(keyOf(v))));
          if (next.length !== cur[id].length) { cur[id] = next; restricted.add(id); changed = true; }
        }
      }
    }
    return cur;
  }

  function pathTo(fromId, field) {
    if (has(fromId, field)) return [{ table: fromId }];
    const seen = new Set([fromId]);
    let frontier = [[{ table: fromId }]];
    while (frontier.length) {
      const next = [];
      for (const path of frontier) {
        const last = path[path.length - 1].table;
        for (const k of keys) {
          if (!has(last, k)) continue;
          for (const other of tablesOf(k)) {
            if (seen.has(other)) continue;
            seen.add(other);
            const np = [...path, { table: other, via: k }];
            if (has(other, field)) return np;
            next.push(np);
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  // valores do campo associados a uma posição da tabela `fromId` (sempre uma lista)
  function resolver(state, fromId, field) {
    const path = pathTo(fromId, field);
    if (!path) return () => [];
    if (path.length === 1) { const g = byId[fromId].t.getter(field); return i => [g(i)]; }
    let map = null;
    for (let s = path.length - 1; s >= 1; s--) {
      const { table, via } = path[s];
      const t = byId[table].t;
      const outKey = s < path.length - 1 ? path[s + 1].via : null;
      const gVia = t.getter(via), gOut = outKey ? t.getter(outKey) : t.getter(field);
      const m = new Map();
      for (const i of state[table]) {
        const vals = outKey ? (map.get(keyOf(gOut(i))) || []) : [gOut(i)];
        const k = keyOf(gVia(i));
        let set = m.get(k);
        if (!set) { set = new Set(); m.set(k, set); }
        for (const v of vals) set.add(v);
      }
      map = new Map([...m].map(([k, set]) => [k, [...set]]));
    }
    const gFirst = byId[fromId].t.getter(path[1].via);
    const EMPTY = [];
    return i => map.get(keyOf(gFirst(i))) || EMPTY;
  }

  function measureTable(usedFields, dimField) {
    const cands = tables.filter(t => usedFields.every(f => has(t.id, f)));
    if (!cands.length) return null;
    return (dimField && cands.find(t => has(t.id, dimField))) || cands[0];
  }

  function distinctValues(field) {
    const s = new Set();
    for (const id of tablesOf(field)) for (const v of byId[id].t.distinct(field)) s.add(v);
    return s;
  }
  const cardinality = field => tablesOf(field).reduce((m, id) => Math.max(m, byId[id].t.cardinality(field)), 0);

  // primeira tabela do app: usada na contagem de linhas, exportação e painel automático
  const primary = tables[0] || { id: 'main', name: ds.name || 'App', columns: [], t: ColTable.fromRows([], []), n: 0 };
  return { tables, byId, primary, empty: !tables.length, fields, keys, tablesOf, has, select, resolver, pathTo, measureTable, distinctValues, cardinality, multi: tables.length > 1 };
}
