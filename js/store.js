// =============================================================
//  Camada de dados
//  - FirebaseStore: Auth (e-mail/senha) + Firestore
//      users/{uid}/datasets/{id}            -> metadados + painel
//      users/{uid}/datasets/{id}/chunks/{n} -> linhas em blocos
//  - LocalStore: modo demo, tudo no IndexedDB do navegador
//  As duas têm exatamente os mesmos métodos.
// =============================================================

const FB = '10.12.2';
const CHUNK_BYTES = 700_000; // Firestore aceita até ~1 MB por documento

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

// ---------------- Firebase ----------------
async function createFirebaseStore(config) {
  const appMod = await import(`https://www.gstatic.com/firebasejs/${FB}/firebase-app.js`);
  const A = await import(`https://www.gstatic.com/firebasejs/${FB}/firebase-auth.js`);
  const F = await import(`https://www.gstatic.com/firebasejs/${FB}/firebase-firestore.js`);
  const app = appMod.initializeApp(config);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  let current = null;

  const dsCol = () => F.collection(db, 'users', current.uid, 'datasets');
  const dsDoc = id => F.doc(db, 'users', current.uid, 'datasets', id);
  const chunkCol = id => F.collection(db, 'users', current.uid, 'datasets', id, 'chunks');

  return {
    mode: 'firebase',
    onAuth(cb) {
      A.onAuthStateChanged(auth, u => {
        current = u ? { uid: u.uid, email: u.email } : null;
        cb(current);
      });
    },
    signIn: (e, p) => A.signInWithEmailAndPassword(auth, e, p),
    signUp: (e, p) => A.createUserWithEmailAndPassword(auth, e, p),
    resetPassword: e => A.sendPasswordResetEmail(auth, e),
    signOut: () => A.signOut(auth),

    async listDatasets() {
      const snap = await F.getDocs(F.query(dsCol(), F.orderBy('createdAt', 'desc')));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async saveDataset(meta, rows, onProgress) {
      const ref = F.doc(dsCol());
      const chunks = chunkRows(rows);
      for (let i = 0; i < chunks.length; i++) {
        await F.setDoc(F.doc(chunkCol(ref.id), String(i).padStart(4, '0')),
          { index: i, data: JSON.stringify(chunks[i]) });
        onProgress && onProgress((i + 1) / chunks.length);
      }
      // metadados por último: o conjunto só aparece quando estiver completo
      await F.setDoc(ref, { ...meta, chunkCount: chunks.length, createdAt: new Date().toISOString() });
      return ref.id;
    },
    async loadRows(id) {
      const snap = await F.getDocs(F.query(chunkCol(id), F.orderBy('index')));
      return snap.docs.flatMap(d => JSON.parse(d.data().data));
    },
    async updateDashboard(id, dashboard) {
      await F.updateDoc(dsDoc(id), { dashboard });
    },
    async deleteDataset(id) {
      const snap = await F.getDocs(chunkCol(id));
      await Promise.all(snap.docs.map(d => F.deleteDoc(d.ref)));
      await F.deleteDoc(dsDoc(id));
    }
  };
}

// ---------------- Modo demo (IndexedDB) ----------------
function createLocalStore() {
  const SESSION = 'nuvembi_session';
  const listeners = [];
  let current = null;
  try { current = JSON.parse(localStorage.getItem(SESSION)); } catch { current = null; }

  let dbp;
  const db = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('nuvembi', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const req = fn(d.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  };
  const get = k => tx('readonly', s => s.get(k));
  const set = (k, v) => tx('readwrite', s => s.put(v, k));
  const del = k => tx('readwrite', s => s.delete(k));
  const key = s => `${current.uid}:${s}`;
  const emit = () => listeners.forEach(cb => cb(current));

  const login = email => {
    current = { uid: email.toLowerCase(), email };
    try { localStorage.setItem(SESSION, JSON.stringify(current)); } catch {}
    emit();
  };

  return {
    mode: 'local',
    onAuth(cb) { listeners.push(cb); cb(current); },
    async signIn(e, p) { if (!p || p.length < 6) throw { code: 'auth/weak-password' }; login(e); },
    async signUp(e, p) { if (!p || p.length < 6) throw { code: 'auth/weak-password' }; login(e); },
    async resetPassword() {},
    async signOut() { current = null; try { localStorage.removeItem(SESSION); } catch {} emit(); },

    async listDatasets() {
      const list = (await get(key('index'))) || [];
      return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async saveDataset(meta, rows, onProgress) {
      const id = 'ds_' + Date.now().toString(36);
      await set(key('rows:' + id), rows);
      const list = (await get(key('index'))) || [];
      list.push({ id, ...meta, createdAt: new Date().toISOString() });
      await set(key('index'), list);
      onProgress && onProgress(1);
      return id;
    },
    async loadRows(id) { return (await get(key('rows:' + id))) || []; },
    async updateDashboard(id, dashboard) {
      const list = (await get(key('index'))) || [];
      const ds = list.find(d => d.id === id);
      if (ds) { ds.dashboard = dashboard; await set(key('index'), list); }
    },
    async deleteDataset(id) {
      await del(key('rows:' + id));
      const list = ((await get(key('index'))) || []).filter(d => d.id !== id);
      await set(key('index'), list);
    }
  };
}
