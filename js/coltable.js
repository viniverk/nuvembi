// =============================================================
//  Tabela colunar (como o QVD / o motor do Qlik)
//
//  Em memória:
//   - texto e data: dicionário de valores distintos + códigos por linha
//     (Uint8/16/32). Código 0 = nulo.
//   - número: Float64Array (NaN = nulo)
//  Linhas são só posições (0..n-1); seleções são listas de posições.
//
//  Gravado (serialize): cabeçalho JSON + blocos binários, comprimido
//  com gzip. Números com até 2 casas viram centavos em Int32 (metade
//  do tamanho); números com poucos valores distintos viram dicionário.
// =============================================================

const MAGIC = 0x3143424e; // "NBC1"
const INT32_NULL = -2147483648;

function codeArray(n, dictSize) {
  return dictSize <= 0xff ? new Uint8Array(n) : dictSize <= 0xffff ? new Uint16Array(n) : new Uint32Array(n);
}
function grow(arr, need) {
  if (need <= arr.length) return arr;
  let cap = Math.max(1024, arr.length * 2);
  while (cap < need) cap *= 2;
  const out = new arr.constructor(cap);
  out.set(arr);
  if (arr instanceof Float64Array) out.fill(NaN, arr.length);
  return out;
}

export class ColTable {
  // cols: [{ name, type, num?: Float64Array, dict?: [null, ...valores], codes?: TypedArray }]
  constructor(n, cols) {
    this.n = n;
    this.cols = cols;
    this.byName = new Map(cols.map(c => [c.name, c]));
    this.columns = cols.map(c => ({ name: c.name, type: c.type }));
  }
  has(name) { return this.byName.has(name); }
  col(name) { return this.byName.get(name); }
  // função de leitura rápida de uma coluna: i -> valor (null se vazio)
  getter(name) {
    const c = this.byName.get(name);
    if (!c) return () => null;
    if (c.num) { const a = c.num; return i => { const v = a[i]; return v !== v ? null : v; }; }
    const d = c.dict, k = c.codes;
    return i => d[k[i]];
  }
  get(name, i) { return this.getter(name)(i); }
  cardinality(name) { const c = this.byName.get(name); if (!c) return 0; if (c.dict) return c.dict.length - 1; return new Set(c.num.subarray(0, this.n)).size; }
  distinct(name) {
    const c = this.byName.get(name);
    if (!c) return [];
    if (c.dict) return c.dict.slice(1);
    const s = new Set(); for (let i = 0; i < this.n; i++) { const v = c.num[i]; s.add(v !== v ? null : v); } return [...s];
  }
  row(i) { const o = {}; for (const c of this.cols) o[c.name] = this.get(c.name, i); return o; }
  allIdx() {
    if (!this._all) { this._all = new Uint32Array(this.n); for (let i = 0; i < this.n; i++) this._all[i] = i; }
    return this._all;
  }

  // ---------- construção ----------
  // columns: [{ name, type }] ; push(valores na mesma ordem, já normalizados)
  static builder(columns) {
    const bs = columns.map(c => c.type === 'number'
      ? { ...c, num: new Float64Array(1024).fill(NaN) }
      : { ...c, map: new Map(), dict: [null], codes: new Uint32Array(1024) });
    let n = 0;
    return {
      push(values) {
        for (let j = 0; j < bs.length; j++) {
          const b = bs[j], v = values[j];
          if (b.num) { b.num = grow(b.num, n + 1); b.num[n] = (typeof v === 'number') ? v : NaN; }
          else {
            b.codes = grow(b.codes, n + 1);
            if (v === null || v === undefined) b.codes[n] = 0;
            else { let k = b.map.get(v); if (k === undefined) { k = b.dict.length; b.dict.push(v); b.map.set(v, k); } b.codes[n] = k; }
          }
        }
        n++;
      },
      get size() { return n; },
      finish() {
        return new ColTable(n, bs.map(b => {
          if (b.num) return { name: b.name, type: b.type, num: b.num.slice(0, n) };
          const codes = codeArray(n, b.dict.length);
          codes.set(b.codes.subarray(0, n));
          return { name: b.name, type: b.type, dict: b.dict, codes };
        }));
      }
    };
  }
  static fromRows(columns, rows) {
    const b = ColTable.builder(columns);
    const names = columns.map(c => c.name);
    for (const r of rows) b.push(names.map(nm => r[nm] ?? null));
    return b.finish();
  }
  // junta duas tabelas (Atualizar dados > Acrescentar); colunas = união
  static concat(a, b, columns) {
    const out = ColTable.builder(columns);
    for (const t of [a, b]) {
      const gs = columns.map(c => t.has(c.name) ? t.getter(c.name) : () => null);
      for (let i = 0; i < t.n; i++) out.push(gs.map(g => g(i)));
    }
    return out.finish();
  }
  slice(limit) {
    if (this.n <= limit) return this;
    const b = ColTable.builder(this.columns);
    const gs = this.columns.map(c => this.getter(c.name));
    for (let i = 0; i < limit; i++) b.push(gs.map(g => g(i)));
    return b.finish();
  }
}

// ---------- gravação ----------
export function serialize(t) {
  const head = { n: t.n, cols: [] };
  const parts = [];
  for (const c of t.cols) {
    if (c.num) {
      const a = c.num.subarray(0, t.n);
      const distinct = new Set(a);
      if (distinct.size <= 0xffff) {
        // poucos valores distintos: dicionário (quantidades, preços de tabela…)
        const dict = [...distinct].map(v => v !== v ? null : v);
        const pos = new Map(dict.map((v, i) => [v === null ? 'n' : v, i]));
        const codes = codeArray(t.n, dict.length);
        for (let i = 0; i < t.n; i++) { const v = a[i]; codes[i] = pos.get(v !== v ? 'n' : v); }
        head.cols.push({ name: c.name, type: c.type, mode: 'ndict', dict, w: codes.BYTES_PER_ELEMENT });
        parts.push(new Uint8Array(codes.buffer, codes.byteOffset, codes.byteLength));
        continue;
      }
      let cents = true;
      for (let i = 0; i < t.n && cents; i++) {
        const v = a[i];
        if (v !== v) continue;
        const k = Math.round(v * 100);
        if (Math.abs(k) >= 2147483647 || Math.abs(k - v * 100) > 1e-6) cents = false;
      }
      if (cents) {
        const ints = new Int32Array(t.n);
        for (let i = 0; i < t.n; i++) { const v = a[i]; ints[i] = v !== v ? INT32_NULL : Math.round(v * 100); }
        head.cols.push({ name: c.name, type: c.type, mode: 'cents' });
        parts.push(new Uint8Array(ints.buffer));
      } else {
        const f = a.slice();
        head.cols.push({ name: c.name, type: c.type, mode: 'f64' });
        parts.push(new Uint8Array(f.buffer));
      }
    } else {
      head.cols.push({ name: c.name, type: c.type, mode: 'dict', dict: c.dict.slice(1), w: c.codes.BYTES_PER_ELEMENT });
      parts.push(new Uint8Array(c.codes.buffer, c.codes.byteOffset, c.codes.byteLength));
    }
  }
  const hb = new TextEncoder().encode(JSON.stringify(head));
  const total = 8 + hb.length + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, hb.length, true);
  out.set(hb, 8);
  let off = 8 + hb.length;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function deserialize(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Formato de dados desconhecido.');
  const hl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  let off = 8 + hl;
  const n = head.n;
  const take = bytes => { const b = u8.slice(off, off + bytes); off += bytes; return b.buffer; };  // cópia alinhada
  const Arr = w => w === 1 ? Uint8Array : w === 2 ? Uint16Array : Uint32Array;
  const cols = head.cols.map(h => {
    if (h.mode === 'dict') {
      const codes = new (Arr(h.w))(take(n * h.w));
      return { name: h.name, type: h.type, dict: [null, ...h.dict], codes };
    }
    const num = new Float64Array(n);
    if (h.mode === 'ndict') {
      const codes = new (Arr(h.w))(take(n * h.w));
      const d = h.dict.map(v => v === null ? NaN : v);
      for (let i = 0; i < n; i++) num[i] = d[codes[i]];
    } else if (h.mode === 'cents') {
      const ints = new Int32Array(take(n * 4));
      for (let i = 0; i < n; i++) num[i] = ints[i] === INT32_NULL ? NaN : ints[i] / 100;
    } else num.set(new Float64Array(take(n * 8)));
    return { name: h.name, type: h.type, num };
  });
  return new ColTable(n, cols);
}

// gzip nativo do navegador (CompressionStream); sem suporte, grava sem comprimir
export async function gzip(u8) {
  if (typeof CompressionStream === 'undefined') return { bytes: u8, gz: false };
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return { bytes: new Uint8Array(await new Response(s).arrayBuffer()), gz: true };
}
export async function gunzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function pack(t) { return gzip(serialize(t)); }
export async function unpack(bytes, gz = true) { return deserialize(gz ? await gunzip(bytes) : bytes); }
