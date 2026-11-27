// =============================================================
//  Modelo associativo (várias tabelas ligadas, como no Qlik)
//
//  - Tabelas se ligam pelos campos com o MESMO NOME (campos-chave).
//  - Seleções em qualquer campo filtram a tabela dele e se propagam
//    pelas chaves para as outras tabelas.
//  - Um gráfico pode usar a dimensão de uma tabela e a medida de
//    outra: o valor da dimensão é encontrado seguindo as ligações.
// =============================================================

export const keyOf = v => (v === null || v === undefined) ? '' : String(v);

// data: array (só a tabela principal) ou { main: [...], <id>: [...] }
export function buildModel(ds, data) {
  const dataMap = Array.isArray(data) ? { main: data } : (data || {});
  const tables = [
    { id: 'main', name: ds.mainName || ds.name || 'Principal', columns: ds.columns || [], rows: dataMap.main || [] },
    ...(ds.tables || []).map(t => ({ id: t.id, name: t.name, columns: t.columns || [], rows: dataMap[t.id] || [] }))
  ];
  const byId = Object.fromEntries(tables.map(t => [t.id, t]));

  // campos: união das colunas; o tipo vem da primeira tabela que tem o campo
  const fieldMap = new Map();
  for (const t of tables) for (const c of t.columns) {
    if (!fieldMap.has(c.name)) fieldMap.set(c.name, { name: c.name, type: c.type, tables: [] });
    fieldMap.get(c.name).tables.push(t.id);
  }
  const fields = [...fieldMap.values()];
  const keys = fields.filter(f => f.tables.length > 1).map(f => f.name);
  const tablesOf = f => fieldMap.get(f)?.tables || [];
  const has = (tid, f) => tablesOf(f).includes(tid);

  // ---------- seleções associativas ----------
  // filters: { campo: [valores] } (+ __year/__month aplicados à coluna de data)
  function select(filters, dateCol) {
    const preds = [];
    for (const [f, vals] of Object.entries(filters || {})) {
      if (!vals || !vals.length) continue;
      const set = new Set(vals.map(String));
      if (f === '__year' || f === '__month') {
        if (!dateCol) continue;
        const cut = f === '__year' ? (d => (d || '').slice(0, 4)) : (d => (d || '').slice(5, 7));
        preds.push({ field: dateCol, test: r => set.has(cut(r[dateCol])) });
      } else {
        preds.push({ field: f, test: r => set.has(r[f] === null || r[f] === undefined ? '(vazio)' : String(r[f])) });
      }
    }
    const cur = {};
    const restricted = new Set();
    for (const t of tables) {
      const mine = preds.filter(p => has(t.id, p.field));
      cur[t.id] = mine.length ? t.rows.filter(r => mine.every(p => p.test(r))) : t.rows;
      if (mine.length) restricted.add(t.id);
    }
    // propaga pelas chaves até estabilizar (só tabelas já reduzidas restringem as outras)
    for (let loop = 0, changed = true; changed && loop < 25; loop++) {
      changed = false;
      for (const k of keys) {
        const rt = tablesOf(k).filter(id => restricted.has(id));
        if (!rt.length) continue;
        let allowed = null;
        for (const id of rt) {
          const s = new Set(cur[id].map(r => keyOf(r[k])));
          allowed = allowed ? new Set([...allowed].filter(v => s.has(v))) : s;
        }
        for (const id of tablesOf(k)) {
          const before = cur[id].length;
          const next = cur[id].filter(r => allowed.has(keyOf(r[k])));
          if (next.length !== before) { cur[id] = next; restricted.add(id); changed = true; }
        }
      }
    }
    return cur;
  }

  // ---------- caminho entre tabelas pelas chaves ----------
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

  // valores do campo `field` associados a uma linha da tabela `fromId` (lista; pode ser vazia)
  function resolver(state, fromId, field) {
    const path = pathTo(fromId, field);
    if (!path) return () => [];
    if (path.length === 1) return r => [r[field]];
    // de trás para frente: chave de entrada -> conjunto de valores do campo
    let map = null;
    for (let i = path.length - 1; i >= 1; i--) {
      const { table, via } = path[i];
      const outKey = i < path.length - 1 ? path[i + 1].via : null;
      const m = new Map();
      for (const r of state[table]) {
        const vals = outKey ? (map.get(keyOf(r[outKey])) || []) : [r[field]];
        const k = keyOf(r[via]);
        if (!m.has(k)) m.set(k, new Set());
        for (const v of vals) m.get(k).add(v);
      }
      map = m;
    }
    const first = path[1].via;
    return r => [...(map.get(keyOf(r[first])) || [])];
  }

  // tabela onde a medida é calculada: a que tem todos os campos usados
  function measureTable(usedFields, dimField) {
    const cands = tables.filter(t => usedFields.every(f => has(t.id, f)));
    if (!cands.length) return null;
    return (dimField && cands.find(t => has(t.id, dimField))) || cands[0];
  }

  function distinctValues(field) {
    const s = new Set();
    for (const id of tablesOf(field)) for (const r of byId[id].rows) s.add(r[field]);
    return s;
  }

  return { tables, byId, fields, keys, tablesOf, has, select, resolver, pathTo, measureTable, distinctValues, multi: tables.length > 1 };
}
