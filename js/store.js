// =============================================================
//  Camada de dados — empresas (workspaces), usuários, convites,
//  painéis e links de compartilhamento.
//
//  Firestore:
//    orgs/{org}                         { name, ownerUid, createdAt }
//    orgs/{org}/members/{uid}           { email, role: admin|editor|viewer, addedAt }
//    orgs/{org}/datasets/{id}           metadados + painel (+ shareId quando compartilhado)
//    orgs/{org}/datasets/{id}/chunks/n  linhas em blocos
//    invites/{email__org}               { email, orgId, orgName, role, invitedBy, createdAt }
//    shares/{token}                     { orgId, datasetId, name, createdBy, createdAt }
//    users/{uid}                        { orgs: { orgId: name } }  (índice das empresas do usuário)
//    users/{uid}/datasets/...           formato antigo (migrado na 1ª entrada)
//
//  O modo demo (sem Firebase) simula tudo isso no IndexedDB do navegador.
// =============================================================

import { ColTable, pack, unpack } from './coltable.js?v=24';

const FB = '10.12.2';
const BIN = 900_000;   // bytes por documento (limite do Firestore: 1 MB)
const CHUNK_BYTES = 700_000;
export const ROLES = { admin: 'Administrador', editor: 'Editor', viewer: 'Visualizador' };
const ORG_KEY = 'nuvembi_org';

export async function createStore(config) {
  return config && config.apiKey ? createFirebaseStore(config) : createLocalStore();
}

function chunkRows(rows) {
  const chunks = [];
  let cur = [], size = 0;
  for (const r of rows) {
    const s = JSON.stringify(r).length + 1;
    if (cur.length && size + s > CHUNK_BYTES) { chunks.push(cur); cur = []; size = 0; }
    cur.push(r); size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
const token = (n = 22) => {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map(b => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
};
const lower = e => String(e || '').trim().toLowerCase();
const inviteId = (email, orgId) => `${lower(email)}__${orgId}`;
const getSavedOrg = () => { try { return localStorage.getItem(ORG_KEY); } catch { return null; } };
const setSavedOrg = id => { try { localStorage.setItem(ORG_KEY, id); } catch {} };

// =============================================================
//  Firebase
// =============================================================
async function createFirebaseStore(config) {
  const appMod = await import(`https://www.gstatic.com/firebasejs/${FB}/firebase-app.js`);
  const A = await import(`https://www.gstatic.com/firebasejs/${FB}/firebase-auth.js`);
  const F = await import(`https://www.gstatic.com/firebasejs/${FB}/firebase-firestore.js`);
  const app = appMod.initializeApp(config);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  let me = null;      // { uid, email }
  let org = null;     // { id, name, role }

  const d = (...p) => F.doc(db, ...p);
  const c = (...p) => F.collection(db, ...p);
  const dsCol = () => c('orgs', org.id, 'datasets');
  const dsDoc = id => d('orgs', org.id, 'datasets', id);
  const chunkCol = (orgId, id) => c('orgs', orgId, 'datasets', id, 'chunks');
  const now = () => new Date().toISOString();

  // grava a tabela colunar comprimida em blocos de uma "geração"; o painel só passa a usar a geração nova no fim
  let lastBytes = 0;
  async function writeChunks(orgId, dsId, table, gen, onProgress, tid = 'main') {
    const { bytes, gz } = await pack(table);
    const n = Math.max(1, Math.ceil(bytes.length / BIN));
    for (let i = 0; i < n; i++) {
      const cid = `${tid === 'main' ? '' : tid + '_'}${gen}_${String(i).padStart(4, '0')}`;
      await F.setDoc(d('orgs', orgId, 'datasets', dsId, 'chunks', cid),
        { index: i, gen, table: tid, fmt: 'col1', gz, bin: F.Bytes.fromUint8Array(bytes.subarray(i * BIN, (i + 1) * BIN)) });
      onProgress && onProgress((i + 1) / n);
    }
    lastBytes = bytes.length;
    return n;
  }
  async function writeDataset(orgId, ref, meta, table, onProgress) {
    const gen = token(6);
    const n = await writeChunks(orgId, ref.id, table, gen, onProgress);
    await F.setDoc(ref, { ...meta, rowCount: table.n, chunkCount: n, gen, format: 'col1', bytes: lastBytes });
  }

  const tableOf = x => x.table || 'main';
  // monta a ColTable de uma tabela: formato colunar (bin) ou linhas JSON dos painéis antigos
  async function pick(docs, table, gen, columns) {
    const mine = docs.filter(x => tableOf(x) === table && (x.gen || null) === (gen || null))   // painéis antigos não têm geração
      .sort((a, b) => a.index - b.index);
    if (mine.length && mine[0].fmt === 'col1') {
      const parts = mine.map(x => x.bin.toUint8Array());
      const all = new Uint8Array(parts.reduce((t2, p2) => t2 + p2.length, 0));
      let off = 0; for (const p2 of parts) { all.set(p2, off); off += p2.length; }
      return unpack(all, mine[0].gz);
    }
    return ColTable.fromRows(columns || [], mine.flatMap(x => JSON.parse(x.data)));
  }
  async function loadChunks(orgId, id, meta) {
    const snap = await F.getDocs(chunkCol(orgId, id));
    return pick(snap.docs.map(x => x.data()), 'main', meta.gen, meta.columns);
  }
  // todas as tabelas do painel: { main: ColTable, <id>: ColTable }
  async function loadAllChunks(orgId, id, meta) {
    const docs = (await F.getDocs(chunkCol(orgId, id))).docs.map(x => x.data());
    const out = { main: await pick(docs, 'main', meta.gen, meta.columns) };
    for (const t of meta.tables || []) out[t.id] = await pick(docs, t.id, t.gen, t.columns);
    return out;
  }
  async function deleteChunks(orgId, id, keep) {
    const old = await F.getDocs(chunkCol(orgId, id));
    await Promise.all(old.docs.filter(x => !keep(x.data())).map(x => F.deleteDoc(x.ref)));
  }

  return {
    mode: 'firebase',
    get me() { return me; },
    get org() { return org; },
    onAuth(cb) {
      A.onAuthStateChanged(auth, u => { me = u ? { uid: u.uid, email: lower(u.email) } : null; org = null; cb(me); });
    },
    signIn: (e, p) => A.signInWithEmailAndPassword(auth, e, p),
    signUp: (e, p) => A.createUserWithEmailAndPassword(auth, e, p),
    resetPassword: e => A.sendPasswordResetEmail(auth, e),
    signOut: () => A.signOut(auth),

    // ---------- empresas ----------
    async loadWorkspace() {
      const u = await F.getDoc(d('users', me.uid));
      const index = u.exists() ? (u.data().orgs || {}) : {};
      const orgs = [];
      for (const [id, cachedName] of Object.entries(index)) {
        const m = await F.getDoc(d('orgs', id, 'members', me.uid)).catch(() => null);
        if (!m || !m.exists()) continue;
        // o nome oficial fica no documento da empresa (o admin pode ter renomeado)
        const o = await F.getDoc(d('orgs', id)).catch(() => null);
        const name = (o && o.exists() && o.data().name) || cachedName;
        if (name !== cachedName) F.setDoc(d('users', me.uid), { orgs: { [id]: name } }, { merge: true }).catch(() => {});
        orgs.push({ id, name, role: m.data().role });
      }
      const inv = await F.getDocs(F.query(c('invites'), F.where('email', '==', me.email)));
      const invites = inv.docs.map(x => ({ id: x.id, ...x.data() }));
      return { orgs, invites };
    },
    useOrg(o) { org = o; setSavedOrg(o.id); },
    savedOrgId: getSavedOrg,
    async createOrg(name) {
      const ref = F.doc(c('orgs'));
      await F.setDoc(ref, { name, ownerUid: me.uid, createdAt: now() });
      await F.setDoc(d('orgs', ref.id, 'members', me.uid), { email: me.email, role: 'admin', addedAt: now() });
      await F.setDoc(d('users', me.uid), { orgs: { [ref.id]: name } }, { merge: true });
      return { id: ref.id, name, role: 'admin' };
    },
    async renameOrg(name) {
      await F.updateDoc(d('orgs', org.id), { name });
      await F.setDoc(d('users', me.uid), { orgs: { [org.id]: name } }, { merge: true });
      // convites pendentes passam a mostrar o nome novo
      const inv = await F.getDocs(F.query(c('invites'), F.where('orgId', '==', org.id)));
      await Promise.all(inv.docs.map(x => F.updateDoc(x.ref, { orgName: name }).catch(() => {})));
      org = { ...org, name };
    },
    async acceptInvite(inv) {
      await F.setDoc(d('orgs', inv.orgId, 'members', me.uid), { email: me.email, role: inv.role, addedAt: now() });
      await F.setDoc(d('users', me.uid), { orgs: { [inv.orgId]: inv.orgName } }, { merge: true });
      await F.deleteDoc(d('invites', inv.id));
      return { id: inv.orgId, name: inv.orgName, role: inv.role };
    },
    async declineInvite(inv) { await F.deleteDoc(d('invites', inv.id)); },
    async leaveOrg(orgId) {
      await F.deleteDoc(d('orgs', orgId, 'members', me.uid));
      await F.setDoc(d('users', me.uid), { orgs: { [orgId]: F.deleteField() } }, { merge: true });
    },

    // ---------- equipe (admin) ----------
    async listMembers() {
      const s = await F.getDocs(c('orgs', org.id, 'members'));
      return s.docs.map(x => ({ uid: x.id, ...x.data() }));
    },
    async listInvites() {
      const s = await F.getDocs(F.query(c('invites'), F.where('orgId', '==', org.id)));
      return s.docs.map(x => ({ id: x.id, ...x.data() }));
    },
    async invite(email, role) {
      email = lower(email);
      await F.setDoc(d('invites', inviteId(email, org.id)), { email, orgId: org.id, orgName: org.name, role, invitedBy: me.email, createdAt: now() });
    },
    async cancelInvite(id) { await F.deleteDoc(d('invites', id)); },
    async setRole(uid, role) { await F.updateDoc(d('orgs', org.id, 'members', uid), { role }); },
    async removeMember(uid) { await F.deleteDoc(d('orgs', org.id, 'members', uid)); },

    // ---------- painéis ----------
    async listDatasets() {
      const snap = await F.getDocs(F.query(dsCol(), F.orderBy('createdAt', 'desc')));
      return snap.docs.map(x => ({ id: x.id, ...x.data() }));
    },
    // app vazio: as tabelas entram depois pelo Gerenciador de dados
    async createApp(name) {
      const ref = F.doc(dsCol());
      await F.setDoc(ref, { name, source: 'app', columns: [], rowCount: 0, tables: [], createdAt: now(), createdBy: me.email });
      return ref.id;
    },
    async renameTable(dsId, tid, name) {
      if (tid === 'main') { await F.updateDoc(dsDoc(dsId), { mainName: name }); return; }
      const meta = (await F.getDoc(dsDoc(dsId))).data();
      await F.updateDoc(dsDoc(dsId), { tables: (meta.tables || []).map(t => t.id === tid ? { ...t, name } : t) });
    },
    async clearMain(dsId) {   // remove os dados da tabela principal (o app continua com as outras tabelas)
      await F.updateDoc(dsDoc(dsId), { columns: [], rowCount: 0, gen: null, updatedAt: now(), updatedBy: me.email });
      await deleteChunks(org.id, dsId, x => tableOf(x) !== 'main');
    },
    async saveDataset(meta, rows, onProgress) {
      const ref = F.doc(dsCol());
      await writeDataset(org.id, ref, { ...meta, createdAt: now(), createdBy: me.email }, rows, onProgress);
      return ref.id;
    },
    async loadRows(id) {   // tabela principal (ColTable)
      const m = await F.getDoc(dsDoc(id));
      return loadChunks(org.id, id, m.exists() ? m.data() : {});
    },
    // troca as linhas mantendo painel, filtros e link (novos blocos -> aponta -> apaga os velhos)
    async replaceData(id, metaPatch, table, onProgress) {
      const gen = token(6);
      const n = await writeChunks(org.id, id, table, gen, onProgress);
      await F.updateDoc(dsDoc(id), { ...metaPatch, rowCount: table.n, chunkCount: n, gen, format: 'col1', bytes: lastBytes, updatedAt: now(), updatedBy: me.email });
      await deleteChunks(org.id, id, x => tableOf(x) !== 'main' || x.gen === gen);
    },
    async loadAll(id) {
      const m = await F.getDoc(dsDoc(id));
      return loadAllChunks(org.id, id, m.exists() ? m.data() : {});
    },
    // ---------- tabelas extras (modelo com várias tabelas) ----------
    async addTable(dsId, { name, columns }, table, onProgress) {
      const tid = 't' + token(7), gen = token(6);
      const n = await writeChunks(org.id, dsId, table, gen, onProgress, tid);
      const meta = (await F.getDoc(dsDoc(dsId))).data();
      const tables = [...(meta.tables || []), { id: tid, name, columns, rowCount: table.n, gen, chunkCount: n, bytes: lastBytes, addedAt: now(), addedBy: me.email }];
      await F.updateDoc(dsDoc(dsId), { tables, updatedAt: now(), updatedBy: me.email });
      return tables;
    },
    async replaceTable(dsId, tid, { name, columns }, table, onProgress) {
      const gen = token(6);
      const n = await writeChunks(org.id, dsId, table, gen, onProgress, tid);
      const meta = (await F.getDoc(dsDoc(dsId))).data();
      const tables = (meta.tables || []).map(t => t.id === tid ? { ...t, name: name || t.name, columns, rowCount: table.n, gen, chunkCount: n, bytes: lastBytes, updatedAt: now() } : t);
      await F.updateDoc(dsDoc(dsId), { tables, updatedAt: now(), updatedBy: me.email });
      await deleteChunks(org.id, dsId, x => tableOf(x) !== tid || x.gen === gen);
      return tables;
    },
    async removeTable(dsId, tid) {
      const meta = (await F.getDoc(dsDoc(dsId))).data();
      const tables = (meta.tables || []).filter(t => t.id !== tid);
      await F.updateDoc(dsDoc(dsId), { tables, updatedAt: now(), updatedBy: me.email });
      await deleteChunks(org.id, dsId, x => tableOf(x) !== tid);
      return tables;
    },
    async updateDashboard(id, dashboard) { await F.updateDoc(dsDoc(id), { dashboard }); },
    // patch: { script } = texto salvo no editor; { loadedScript } = script usado pelo app (última carga)
    async saveScript(id, patch) { await F.updateDoc(dsDoc(id), { ...patch, updatedAt: now(), updatedBy: me.email }); },
    async deleteDataset(id) {
      const ds = await F.getDoc(dsDoc(id));
      const shareId = ds.exists() ? ds.data().shareId : null;
      if (shareId) await F.deleteDoc(d('shares', shareId)).catch(() => {});
      const snap = await F.getDocs(chunkCol(org.id, id));
      await Promise.all(snap.docs.map(x => F.deleteDoc(x.ref)));
      await F.deleteDoc(dsDoc(id));
    },

    // ---------- compartilhar por link ----------
    async createShare(ds) {
      const t = token();
      await F.setDoc(d('shares', t), { orgId: org.id, datasetId: ds.id, name: ds.name, createdBy: me.email, createdAt: now() });
      await F.updateDoc(dsDoc(ds.id), { shareId: t });
      return t;
    },
    async revokeShare(ds) {
      if (ds.shareId) await F.deleteDoc(d('shares', ds.shareId)).catch(() => {});
      await F.updateDoc(dsDoc(ds.id), { shareId: F.deleteField() });
    },
    async loadShared(t) {
      const s = await F.getDoc(d('shares', t));
      if (!s.exists()) return null;
      const { orgId, datasetId } = s.data();
      const ds = await F.getDoc(d('orgs', orgId, 'datasets', datasetId));
      if (!ds.exists() || ds.data().shareId !== t) return null;
      return { ds: { id: ds.id, ...ds.data() }, data: await loadAllChunks(orgId, datasetId, ds.data()) };
    },

    // ---------- migração do formato antigo (users/{uid}/datasets) ----------
    async migrateLegacy() {
      const old = await F.getDocs(c('users', me.uid, 'datasets'));
      let n = 0;
      for (const x of old.docs) {
        const meta = x.data();
        const rows = (await F.getDocs(F.query(c('users', me.uid, 'datasets', x.id, 'chunks'), F.orderBy('index'))))
          .docs.flatMap(ch => JSON.parse(ch.data().data));
        const ref = F.doc(dsCol());
        const { chunkCount, ...rest } = meta;
        await writeDataset(org.id, ref, { ...rest, createdBy: me.email }, ColTable.fromRows(meta.columns || [], rows));
        n++;
      }
      await F.setDoc(d('users', me.uid), { migrated: true }, { merge: true });
      return n;
    },
    async needsMigration() {
      const u = await F.getDoc(d('users', me.uid));
      if (u.exists() && u.data().migrated) return false;
      const old = await F.getDocs(F.query(c('users', me.uid, 'datasets'), F.limit(1)));
      return !old.empty;
    }
  };
}

// =============================================================
//  Modo demo: mesmo comportamento, tudo no IndexedDB
// =============================================================
function createLocalStore() {
  const SESSION = 'nuvembi_session';
  const listeners = [];
  let me = null, org = null;
  try { me = JSON.parse(localStorage.getItem(SESSION)); } catch { me = null; }

  let dbp;
  const db = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('nuvembi', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const x = await db();
    return new Promise((res, rej) => {
      const req = fn(x.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  };
  const get = k => tx('readonly', s => s.get(k));
  const set = (k, v) => tx('readwrite', s => s.put(v, k));
  const del = k => tx('readwrite', s => s.delete(k));
  const getMap = async k => (await get(k)) || {};
  const emit = () => listeners.forEach(cb => cb(me));
  const now = () => new Date().toISOString();
  const deny = () => { throw Object.assign(new Error('Sem permissão'), { code: 'permission-denied' }); };
  // tabelas guardadas comprimidas no IndexedDB (formato novo) ou como linhas (antigo)
  const putTable = async (key, table) => { const { bytes, gz } = await pack(table); await set(key, { fmt: 'col1', gz, bin: bytes }); };
  const getTable = async (key, columns) => {
    const v = await get(key);
    if (v && v.fmt === 'col1') return unpack(v.bin, v.gz);
    return ColTable.fromRows(columns || [], v || []);
  };
  const myRole = async orgId => (await getMap('members:' + orgId))[me.uid]?.role;
  const needEdit = async () => { if (!['admin', 'editor'].includes(await myRole(org.id))) deny(); };
  const needAdmin = async () => { if ((await myRole(org.id)) !== 'admin') deny(); };

  const login = email => {
    me = { uid: lower(email), email: lower(email) }; org = null;
    try { localStorage.setItem(SESSION, JSON.stringify(me)); } catch {}
    emit();
  };

  return {
    mode: 'local',
    get me() { return me; },
    get org() { return org; },
    onAuth(cb) { listeners.push(cb); cb(me); },
    async signIn(e, p) { if (!p || p.length < 6) throw { code: 'auth/weak-password' }; login(e); },
    async signUp(e, p) { if (!p || p.length < 6) throw { code: 'auth/weak-password' }; login(e); },
    async resetPassword() {},
    async signOut() { me = null; org = null; try { localStorage.removeItem(SESSION); } catch {} emit(); },

    async loadWorkspace() {
      const index = (await getMap('user:' + me.uid)).orgs || {};
      const orgs = [];
      const allOrgs = await getMap('orgs');
      for (const [id, cachedName] of Object.entries(index)) {
        const role = await myRole(id);
        if (role) orgs.push({ id, name: allOrgs[id]?.name || cachedName, role });
      }
      const invites = Object.entries(await getMap('invites')).filter(([, v]) => v.email === me.email).map(([id, v]) => ({ id, ...v }));
      return { orgs, invites };
    },
    useOrg(o) { org = o; setSavedOrg(o.id); },
    savedOrgId: getSavedOrg,
    async createOrg(name) {
      const id = 'org_' + token(8);
      const orgs = await getMap('orgs'); orgs[id] = { name, ownerUid: me.uid, createdAt: now() }; await set('orgs', orgs);
      await set('members:' + id, { [me.uid]: { email: me.email, role: 'admin', addedAt: now() } });
      const u = await getMap('user:' + me.uid); u.orgs = { ...(u.orgs || {}), [id]: name }; await set('user:' + me.uid, u);
      return { id, name, role: 'admin' };
    },
    async renameOrg(name) {
      await needAdmin();
      const orgs = await getMap('orgs'); orgs[org.id].name = name; await set('orgs', orgs);
      const u = await getMap('user:' + me.uid); u.orgs[org.id] = name; await set('user:' + me.uid, u);
      const inv = await getMap('invites');
      for (const k of Object.keys(inv)) if (inv[k].orgId === org.id) inv[k].orgName = name;
      await set('invites', inv);
      org = { ...org, name };
    },
    async acceptInvite(inv) {
      const invites = await getMap('invites');
      if (!invites[inv.id] || invites[inv.id].email !== me.email) deny();
      const m = await getMap('members:' + inv.orgId); m[me.uid] = { email: me.email, role: inv.role, addedAt: now() }; await set('members:' + inv.orgId, m);
      const u = await getMap('user:' + me.uid); u.orgs = { ...(u.orgs || {}), [inv.orgId]: inv.orgName }; await set('user:' + me.uid, u);
      delete invites[inv.id]; await set('invites', invites);
      return { id: inv.orgId, name: inv.orgName, role: inv.role };
    },
    async declineInvite(inv) { const i = await getMap('invites'); delete i[inv.id]; await set('invites', i); },
    async leaveOrg(orgId) {
      const m = await getMap('members:' + orgId); delete m[me.uid]; await set('members:' + orgId, m);
      const u = await getMap('user:' + me.uid); delete u.orgs[orgId]; await set('user:' + me.uid, u);
    },

    async listMembers() { return Object.entries(await getMap('members:' + org.id)).map(([uid, v]) => ({ uid, ...v })); },
    async listInvites() { await needAdmin(); return Object.entries(await getMap('invites')).filter(([, v]) => v.orgId === org.id).map(([id, v]) => ({ id, ...v })); },
    async invite(email, role) {
      await needAdmin();
      email = lower(email);
      const i = await getMap('invites'); i[inviteId(email, org.id)] = { email, orgId: org.id, orgName: org.name, role, invitedBy: me.email, createdAt: now() }; await set('invites', i);
    },
    async cancelInvite(id) { await needAdmin(); const i = await getMap('invites'); delete i[id]; await set('invites', i); },
    async setRole(uid, role) { await needAdmin(); const m = await getMap('members:' + org.id); m[uid].role = role; await set('members:' + org.id, m); },
    async removeMember(uid) { await needAdmin(); const m = await getMap('members:' + org.id); delete m[uid]; await set('members:' + org.id, m); },

    async listDatasets() {
      const list = (await get('datasets:' + org.id)) || [];
      return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async createApp(name) {
      await needEdit();
      const id = 'ds_' + Date.now().toString(36);
      const list = (await get('datasets:' + org.id)) || [];
      list.push({ id, name, source: 'app', columns: [], rowCount: 0, tables: [], createdAt: now(), createdBy: me.email });
      await set('datasets:' + org.id, list);
      return id;
    },
    async renameTable(dsId, tid, name) {
      await needEdit();
      const list = (await get('datasets:' + org.id)) || [];
      const ds = list.find(x => x.id === dsId);
      if (tid === 'main') ds.mainName = name; else ds.tables = (ds.tables || []).map(t => t.id === tid ? { ...t, name } : t);
      await set('datasets:' + org.id, list);
    },
    async clearMain(dsId) {
      await needEdit();
      await del(`rows:${org.id}:${dsId}`);
      const list = (await get('datasets:' + org.id)) || [];
      Object.assign(list.find(x => x.id === dsId), { columns: [], rowCount: 0, updatedAt: now() });
      await set('datasets:' + org.id, list);
    },
    async saveDataset(meta, table, onProgress) {
      await needEdit();
      const id = 'ds_' + Date.now().toString(36);
      await putTable(`rows:${org.id}:${id}`, table);
      const list = (await get('datasets:' + org.id)) || [];
      list.push({ id, ...meta, rowCount: table.n, format: 'col1', createdAt: now(), createdBy: me.email });
      await set('datasets:' + org.id, list);
      onProgress && onProgress(1);
      return id;
    },
    async loadRows(id) {
      const ds = ((await get('datasets:' + org.id)) || []).find(x => x.id === id) || {};
      return getTable(`rows:${org.id}:${id}`, ds.columns);
    },
    async loadAll(id) {
      const ds = ((await get('datasets:' + org.id)) || []).find(x => x.id === id) || {};
      const out = { main: await getTable(`rows:${org.id}:${id}`, ds.columns) };
      for (const t of ds.tables || []) out[t.id] = await getTable(`rows:${org.id}:${id}:${t.id}`, t.columns);
      return out;
    },
    async addTable(dsId, { name, columns }, table, onProgress) {
      await needEdit();
      const tid = 't' + token(7);
      await putTable(`rows:${org.id}:${dsId}:${tid}`, table);
      const list = (await get('datasets:' + org.id)) || [];
      const ds = list.find(x => x.id === dsId);
      ds.tables = [...(ds.tables || []), { id: tid, name, columns, rowCount: table.n, addedAt: now(), addedBy: me.email }];
      await set('datasets:' + org.id, list); onProgress && onProgress(1);
      return ds.tables;
    },
    async replaceTable(dsId, tid, { name, columns }, table, onProgress) {
      await needEdit();
      await putTable(`rows:${org.id}:${dsId}:${tid}`, table);
      const list = (await get('datasets:' + org.id)) || [];
      const ds = list.find(x => x.id === dsId);
      ds.tables = (ds.tables || []).map(t => t.id === tid ? { ...t, name: name || t.name, columns, rowCount: table.n, updatedAt: now() } : t);
      await set('datasets:' + org.id, list); onProgress && onProgress(1);
      return ds.tables;
    },
    async removeTable(dsId, tid) {
      await needEdit();
      await del(`rows:${org.id}:${dsId}:${tid}`);
      const list = (await get('datasets:' + org.id)) || [];
      const ds = list.find(x => x.id === dsId);
      ds.tables = (ds.tables || []).filter(t => t.id !== tid);
      await set('datasets:' + org.id, list);
      return ds.tables;
    },
    async replaceData(id, metaPatch, table, onProgress) {
      await needEdit();
      await putTable(`rows:${org.id}:${id}`, table);
      const list = (await get('datasets:' + org.id)) || [];
      Object.assign(list.find(x => x.id === id), metaPatch, { rowCount: table.n, format: 'col1', updatedAt: now(), updatedBy: me.email });
      await set('datasets:' + org.id, list);
      onProgress && onProgress(1);
    },
    async saveScript(id, patch) {
      await needEdit();
      const list = (await get('datasets:' + org.id)) || [];
      const ds = list.find(x => x.id === id);
      if (ds) { Object.assign(ds, patch); ds.updatedAt = now(); await set('datasets:' + org.id, list); }
    },
    async updateDashboard(id, dashboard) {
      await needEdit();
      const list = (await get('datasets:' + org.id)) || [];
      const ds = list.find(x => x.id === id);
      if (ds) { ds.dashboard = dashboard; await set('datasets:' + org.id, list); }
    },
    async deleteDataset(id) {
      await needEdit();
      const list = (await get('datasets:' + org.id)) || [];
      const ds = list.find(x => x.id === id);
      if (ds?.shareId) { const s = await getMap('shares'); delete s[ds.shareId]; await set('shares', s); }
      await del(`rows:${org.id}:${id}`);
      for (const t of ds?.tables || []) await del(`rows:${org.id}:${id}:${t.id}`);
      await set('datasets:' + org.id, list.filter(x => x.id !== id));
    },

    async createShare(ds) {
      await needEdit();
      const t = token();
      const s = await getMap('shares'); s[t] = { orgId: org.id, datasetId: ds.id, name: ds.name, createdBy: me.email, createdAt: now() }; await set('shares', s);
      const list = (await get('datasets:' + org.id)) || [];
      list.find(x => x.id === ds.id).shareId = t; await set('datasets:' + org.id, list);
      return t;
    },
    async revokeShare(ds) {
      await needEdit();
      const s = await getMap('shares'); delete s[ds.shareId]; await set('shares', s);
      const list = (await get('datasets:' + org.id)) || [];
      delete list.find(x => x.id === ds.id).shareId; await set('datasets:' + org.id, list);
    },
    async loadShared(t) {
      const s = (await getMap('shares'))[t];
      if (!s) return null;
      const ds = ((await get('datasets:' + s.orgId)) || []).find(x => x.id === s.datasetId);
      if (!ds || ds.shareId !== t) return null;
      const data = { main: await getTable(`rows:${s.orgId}:${s.datasetId}`, ds.columns) };
      for (const t of ds.tables || []) data[t.id] = await getTable(`rows:${s.orgId}:${s.datasetId}:${t.id}`, t.columns);
      return { ds, data };
    },

    async needsMigration() {
      const u = await getMap('user:' + me.uid);
      return !u.migrated && !!(await get(`${me.uid}:index`))?.length;
    },
    async migrateLegacy() {
      const old = (await get(`${me.uid}:index`)) || [];
      const list = (await get('datasets:' + org.id)) || [];
      for (const m of old) {
        const rows = (await get(`${me.uid}:rows:${m.id}`)) || [];
        const id = 'ds_' + token(8);
        await set(`rows:${org.id}:${id}`, rows);
        list.push({ ...m, id, createdBy: me.email });
      }
      await set('datasets:' + org.id, list);
      const u = await getMap('user:' + me.uid); u.migrated = true; await set('user:' + me.uid, u);
      return old.length;
    }
  };
}
