// =============================================================
//  Leitor de arquivos .qvd — roda no navegador
//
//  Estrutura do arquivo:
//   1) cabeçalho XML <QvdTableHeader> terminado por \r\n\0
//   2) tabela de símbolos de cada campo (valores distintos)
//   3) tabela de índices: um registro de RecordByteSize bytes por linha,
//      com o índice do símbolo de cada campo compactado em bits
//
//  Tipos de símbolo: 1 = inteiro 4 bytes | 2 = double 8 bytes | 4 = texto
//                    5 = inteiro + texto (dual) | 6 = double + texto (dual)
//  Datas no QVD são números (dias desde 30/12/1899) e viram aaaa-mm-dd.
// =============================================================

const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? unescapeXml(m[1].trim()) : ''; };
const num = (xml, name) => Number(tag(xml, name) || 0);

const DATE_TYPES = new Set(['DATE', 'TIMESTAMP']);
const NUM_TYPES = new Set(['INTEGER', 'REAL', 'FIX', 'MONEY']);

function serialToISO(n) {
  const d = new Date(Math.round((n - 25569) * 86400000));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function parseHeader(bytes) {
  // o cabeçalho termina no primeiro byte 0 depois de </QvdTableHeader>
  const probe = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)));
  const endTag = probe.indexOf('</QvdTableHeader>');
  if (endTag < 0) throw new Error('Este arquivo não parece ser um QVD (cabeçalho não encontrado).');
  const endBytes = new TextEncoder().encode(probe.slice(0, endTag + '</QvdTableHeader>'.length)).length;
  let dataStart = endBytes;
  while (dataStart < bytes.length && bytes[dataStart] !== 0) dataStart++;
  dataStart++; // pula o \0
  const xml = probe.slice(0, endTag);
  const fieldsXml = [...xml.matchAll(/<QvdFieldHeader>([\s\S]*?)<\/QvdFieldHeader>/g)].map(m => m[1]);
  const fields = fieldsXml.map(fx => ({
    name: tag(fx, 'FieldName'),
    bitOffset: num(fx, 'BitOffset'),
    bitWidth: num(fx, 'BitWidth'),
    bias: num(fx, 'Bias'),
    symbols: num(fx, 'NoOfSymbols'),
    offset: num(fx, 'Offset'),
    length: num(fx, 'Length'),
    numType: (tag(fx.match(/<NumberFormat>[\s\S]*?<\/NumberFormat>/)?.[0] || '', 'Type') || 'UNKNOWN').toUpperCase()
  }));
  // Offset/Length da tabela ficam DEPOIS do bloco <Fields>
  const tail = xml.slice(xml.lastIndexOf('</Fields>') >= 0 ? xml.lastIndexOf('</Fields>') : 0);
  return {
    tableName: tag(xml, 'TableName') || 'Tabela',
    fields,
    recordSize: num(xml, 'RecordByteSize'),
    records: num(xml, 'NoOfRecords'),
    offset: num(tail, 'Offset'),
    length: num(tail, 'Length'),
    dataStart
  };
}

function readSymbols(bytes, view, start, length, count, numType) {
  const out = new Array(count);
  const dec = new TextDecoder('utf-8');
  const readStr = p => { let e = p; while (e < start + length && bytes[e] !== 0) e++; return [dec.decode(bytes.subarray(p, e)), e + 1]; };
  const asDate = DATE_TYPES.has(numType), asNum = NUM_TYPES.has(numType);
  let p = start;
  for (let i = 0; i < count && p < start + length; i++) {
    const t = bytes[p++];
    if (t === 1) { const n = view.getInt32(p, true); p += 4; out[i] = asDate ? serialToISO(n) : n; }
    else if (t === 2) { const n = view.getFloat64(p, true); p += 8; out[i] = asDate ? serialToISO(n) : n; }
    else if (t === 4) { const [s, np] = readStr(p); p = np; out[i] = s; }
    else if (t === 5 || t === 6) {
      // dual: número + texto. Datas e números usam o número; o resto usa o texto (preserva "000123")
      const n = t === 5 ? view.getInt32(p, true) : view.getFloat64(p, true);
      p += t === 5 ? 4 : 8;
      const [s, np] = readStr(p); p = np;
      out[i] = asDate ? serialToISO(n) : asNum ? n : s;
    } else throw new Error(`Tipo de símbolo desconhecido (${t}) no QVD.`);
  }
  return out;
}

// devolve { name, header: [campos], rows: [[...]], total }
// com onRow(linha) percorre o arquivo inteiro sem guardar as linhas (para resumir arquivos grandes)
export function parseQVD(buffer, { maxRows = Infinity, onRow = null } = {}) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const h = parseHeader(bytes);
  const symbols = h.fields.map(f => f.symbols ? readSymbols(bytes, view, h.dataStart + f.offset, f.length, f.symbols, f.numType) : []);
  const n = Math.min(h.records, maxRows);
  const base = h.dataStart + h.offset;
  const rs = h.recordSize;
  const rows = onRow ? [] : new Array(n);
  const plan = h.fields.map((f, i) => ({
    sym: symbols[i], bias: f.bias, width: f.bitWidth,
    byte: f.bitOffset >> 3, shift: f.bitOffset & 7,
    nbytes: f.bitWidth ? ((f.bitOffset & 7) + f.bitWidth + 7) >> 3 : 0,
    div: 2 ** (f.bitOffset & 7), mod: 2 ** f.bitWidth
  }));
  for (let r = 0; r < n; r++) {
    const rec = base + r * rs;
    const row = new Array(plan.length);
    for (let i = 0; i < plan.length; i++) {
      const f = plan[i];
      let idx;
      if (!f.width) idx = f.bias;
      else {
        // registro em little-endian: lê os bytes que cobrem o campo e recorta os bits
        let v = 0, mul = 1;
        for (let b = 0; b < f.nbytes; b++) { v += bytes[rec + f.byte + b] * mul; mul *= 256; }
        idx = (Math.floor(v / f.div) % f.mod) + f.bias;
      }
      row[i] = idx < 0 ? null : (f.sym[idx] ?? null);   // bias negativo = valor nulo
    }
    if (onRow) onRow(row); else rows[r] = row;
  }
  return { name: h.tableName, header: h.fields.map(f => f.name), rows, total: h.records };
}
