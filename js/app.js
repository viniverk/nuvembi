// =============================================================
//  NuvemBI — aplicação principal (telas e navegação)
// =============================================================
import { firebaseConfig, APP_NAME, MAX_ROWS } from './firebase-config.js?v=6';
import { createStore } from './store.js?v=6';
import { readFile, normalizeRows } from './parser.js?v=6';
import { mountDashboard, suggestConfig } from './dashboard.js?v=6';

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('pt-BR');
const TYPE_LABEL = { text: 'Texto', number: 'Número', date: 'Data' };

let store, user;
const rowsCache = new Map();

init();

async function init() {
  try {
    store = await createStore(firebaseConfig);
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="loading">Não foi possível conectar ao Firebase. Confira o arquivo js/firebase-config.js.</div>`;
    return;
  }
  store.onAuth(u => {
    user = u;
    rowsCache.clear();
    if (!u) showLogin(); else route();
  });
  window.addEventListener('hashchange', () => user && route());
}

function route() {
  const [view, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'importar') return showUpload();
  if (view === 'conectores') return showConnectors();
  if (view === 'painel' && id) return showDashboard(id);
  return showHome();
}

function toast(msg, kind = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3500);
}

function authError(e) {
  const map = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
    'auth/email-already-in-use': 'Este e-mail já tem conta. Use "Entrar".',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/user-not-found': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.'
  };
  return map[e?.code] || 'Não foi possível entrar. Tente novamente.';
}

// ---------------- Login ----------------
function showLogin() {
  $app.innerHTML = `
  <div class="login">
    <section class="login-hero">
      <div class="brand big"><span class="logo">◆</span> ${APP_NAME}</div>
      <h1>Seus dados do ERP e do Excel em painéis prontos, na nuvem.</h1>
      <ul class="bullets">
        <li>Importe planilhas Excel e CSV em segundos</li>
        <li>Painéis gerados automaticamente, com filtros</li>
        <li>Protheus e SAP: conectores em desenvolvimento</li>
      </ul>
    </section>
    <section class="login-box card">
      <h2>Acesse sua conta</h2>
      ${store.mode === 'local' ? `<p class="demo-note">Modo demonstração: os dados ficam só neste navegador. Use qualquer e-mail e uma senha de 6+ caracteres.</p>` : ''}
      <form id="login-form">
        <label class="field"><span>E-mail</span><input type="email" name="email" required autocomplete="email"></label>
        <label class="field"><span>Senha</span><input type="password" name="password" required minlength="6" autocomplete="current-password"></label>
        <p class="error" id="login-error"></p>
        <button class="btn full" type="submit" data-mode="in">Entrar</button>
        <button class="btn ghost full" type="button" id="btn-signup">Criar conta grátis</button>
        ${store.mode === 'firebase' ? `<button class="btn link" type="button" id="btn-reset">Esqueci minha senha</button>` : ''}
      </form>
    </section>
  </div>`;
  const form = document.getElementById('login-form');
  const err = document.getElementById('login-error');
  const run = async fn => {
    err.textContent = '';
    if (!form.reportValidity()) return;
    try { await fn(form.email.value.trim(), form.password.value); }
    catch (e) { err.textContent = authError(e); }
  };
  form.addEventListener('submit', e => { e.preventDefault(); run(store.signIn); });
  document.getElementById('btn-signup').addEventListener('click', () => run(store.signUp));
  document.getElementById('btn-reset')?.addEventListener('click', async () => {
    const email = form.email.value.trim();
    if (!email) { err.textContent = 'Digite seu e-mail acima primeiro.'; return; }
    try { await store.resetPassword(email); toast('Enviamos um link de redefinição para seu e-mail.'); }
    catch (e) { err.textContent = authError(e); }
  });
}

// ---------------- Layout ----------------
function shell(active, title, content, actions = '') {
  const item = (hash, label, key) => `<a href="#/${hash}" class="${active === key ? 'active' : ''}">${label}</a>`;
  $app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><span class="logo">◆</span> ${APP_NAME}</div>
      <nav>
        ${item('', '▦ Meus painéis', 'home')}
        ${item('importar', '⇪ Importar dados', 'upload')}
        ${item('conectores', '⛁ Conectores', 'connectors')}
      </nav>
      <div class="sidebar-foot">
        ${store.mode === 'local' ? '<span class="badge warn">Modo demo</span>' : '<span class="badge ok">Nuvem ativa</span>'}
        <div class="user" title="${esc(user.email)}">${esc(user.email)}</div>
        <button class="btn ghost small" id="btn-logout">Sair</button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar"><h1>${title}</h1><div class="actions">${actions}</div></header>
      <div id="view">${content}</div>
    </main>
  </div>`;
  document.getElementById('btn-logout').addEventListener('click', () => store.signOut());
  return document.getElementById('view');
}

// ---------------- Home ----------------
async function showHome() {
  const view = shell('home', 'Meus painéis', '<div class="loading">Carregando…</div>',
    `<a class="btn" href="#/importar">+ Novo painel</a>`);
  let list = [];
  try { list = await store.listDatasets(); }
  catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erro ao carregar seus dados.</div>`; return; }

  if (!list.length) {
    view.innerHTML = `
      <div class="empty card">
        <div class="empty-icon">▦</div>
        <h2>Você ainda não tem painéis</h2>
        <p>Importe uma planilha de vendas, estoque ou compras e o ${APP_NAME} monta o painel para você.</p>
        <a class="btn" href="#/importar">Importar minha primeira planilha</a>
      </div>`;
    return;
  }
  view.innerHTML = `<div class="grid">${list.map(d => `
    <article class="ds card">
      <div class="ds-head"><span class="ds-icon">${d.source === 'csv' ? 'CSV' : 'XLS'}</span>
        <div><h3>${esc(d.name)}</h3><small>${new Date(d.createdAt).toLocaleDateString('pt-BR')}</small></div></div>
      <p class="muted">${nf.format(d.rowCount)} linhas · ${d.columns.length} colunas</p>
      <div class="tags">${d.columns.slice(0, 5).map(c => `<span class="tag ${c.type}">${esc(c.name)}</span>`).join('')}${d.columns.length > 5 ? `<span class="tag">+${d.columns.length - 5}</span>` : ''}</div>
      <div class="ds-actions">
        <a class="btn small" href="#/painel/${encodeURIComponent(d.id)}">Abrir painel</a>
        <button class="btn ghost small danger" data-del="${esc(d.id)}" data-name="${esc(d.name)}">Excluir</button>
      </div>
    </article>`).join('')}</div>`;

  view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Excluir o painel "${b.dataset.name}" e todos os seus dados? Isso não pode ser desfeito.`)) return;
    b.disabled = true;
    try { await store.deleteDataset(b.dataset.del); rowsCache.delete(b.dataset.del); toast('Painel excluído.'); showHome(); }
    catch (e) { console.error(e); toast('Erro ao excluir.', 'err'); b.disabled = false; }
  }));
}

// ---------------- Importar ----------------
function showUpload() {
  const view = shell('upload', 'Importar dados', `
    <div class="card">
      <label class="drop" id="drop">
        <input type="file" id="file" accept=".xlsx,.xls,.xlsm,.csv,.txt" hidden>
        <div class="drop-icon">⇪</div>
        <strong>Arraste sua planilha aqui ou clique para escolher</strong>
        <span class="muted">Excel (.xlsx, .xls) ou CSV · até ${nf.format(MAX_ROWS)} linhas · a primeira linha deve ter os títulos</span>
      </label>
      <p class="muted tip">Dica: exporte uma consulta do Protheus ou SAP para Excel e importe aqui. Datas no formato aaaammdd (ex.: D2_EMISSAO) são reconhecidas automaticamente.</p>
    </div>
    <div id="preview"></div>`);

  const input = view.querySelector('#file');
  const drop = view.querySelector('#drop');
  input.addEventListener('change', () => input.files[0] && handleFile(input.files[0]));
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));
}

async function handleFile(file) {
  const preview = document.getElementById('preview');
  preview.innerHTML = `<div class="card loading">Lendo ${esc(file.name)}…</div>`;
  let sheets;
  try { sheets = await readFile(file); }
  catch (e) { console.error(e); preview.innerHTML = `<div class="card error">Não consegui ler este arquivo. ${esc(e.message || '')}</div>`; return; }
  if (!sheets.length) { preview.innerHTML = `<div class="card error">O arquivo está vazio.</div>`; return; }

  let sheet = sheets[0];
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const source = /\.(csv|txt)$/i.test(file.name) ? 'csv' : 'excel';

  const draw = () => {
    const tooMany = sheet.data.length > MAX_ROWS;
    preview.innerHTML = `
      <div class="card">
        <div class="preview-head">
          <label class="field grow"><span>Nome do painel</span><input id="ds-name" value="${esc(sheets.length > 1 ? `${baseName} - ${sheet.name}` : baseName)}"></label>
          ${sheets.length > 1 ? `<label class="field"><span>Aba</span><select id="sheet">${sheets.map((s, i) => `<option value="${i}" ${s === sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        </div>
        <p class="muted">${nf.format(sheet.data.length)} linhas · ${sheet.columns.length} colunas. Confira os tipos detectados — números são somados, datas viram linha do tempo e textos viram filtros.</p>
        ${tooMany ? `<p class="error">Este MVP aceita até ${nf.format(MAX_ROWS)} linhas. Só as primeiras serão importadas.</p>` : ''}
        <div class="table-wrap"><table>
          <thead>
            <tr>${sheet.columns.map(c => `<th>${esc(c.name)}</th>`).join('')}</tr>
            <tr>${sheet.columns.map((c, i) => `<th><select data-col="${i}" class="type-${c.type}">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${v}</option>`).join('')}</select></th>`).join('')}</tr>
          </thead>
          <tbody>${sheet.data.slice(0, 8).map(r => `<tr>${sheet.columns.map(c => `<td>${esc(r[c.index] instanceof Date ? r[c.index].toLocaleDateString('pt-BR') : r[c.index])}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
        <div class="row-end"><span class="muted" id="progress"></span><button class="btn" id="btn-save">Criar painel</button></div>
      </div>`;

    preview.querySelector('#sheet')?.addEventListener('change', e => { sheet = sheets[+e.target.value]; draw(); });
    preview.querySelectorAll('[data-col]').forEach(s => s.addEventListener('change', () => {
      sheet.columns[+s.dataset.col].type = s.value;
      s.className = `type-${s.value}`;
    }));
    preview.querySelector('#btn-save').addEventListener('click', async e => {
      const btn = e.currentTarget;
      const name = preview.querySelector('#ds-name').value.trim() || baseName;
      btn.disabled = true;
      const prog = preview.querySelector('#progress');
      prog.textContent = 'Preparando dados…';
      try {
        const rows = normalizeRows(sheet.columns, sheet.data.slice(0, MAX_ROWS));
        const columns = sheet.columns.map(({ name, type }) => ({ name, type }));
        const meta = { name, source, columns, rowCount: rows.length };
        meta.dashboard = suggestConfig(meta, rows);
        const id = await store.saveDataset(meta, rows, p => (prog.textContent = `Enviando… ${Math.round(p * 100)}%`));
        rowsCache.set(id, rows);
        toast('Painel criado!');
        location.hash = `#/painel/${encodeURIComponent(id)}`;
      } catch (err) {
        console.error(err);
        prog.textContent = '';
        toast('Erro ao salvar. Verifique sua conexão e as regras do Firestore.', 'err');
        btn.disabled = false;
      }
    });
  };
  draw();
}

// ---------------- Painel ----------------
async function showDashboard(id) {
  const view = shell('home', 'Carregando painel…', '<div class="loading">Carregando dados…</div>',
    `<a class="btn ghost" href="#/">← Voltar</a>`);
  let ds, rows;
  try {
    const list = await store.listDatasets();
    ds = list.find(d => d.id === id);
    if (!ds) { view.innerHTML = `<div class="card error">Painel não encontrado.</div>`; return; }
    rows = rowsCache.get(id) || await store.loadRows(id);
    rowsCache.set(id, rows);
  } catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erro ao carregar o painel.</div>`; return; }

  document.querySelector('.topbar h1').textContent = ds.name;
  mountDashboard(view, ds, rows, ds.dashboard, async cfg => {
    try { await store.updateDashboard(id, cfg); ds.dashboard = cfg; toast('Painel salvo.'); }
    catch (e) { console.error(e); toast('Erro ao salvar o painel.', 'err'); throw e; }
  });
}

// ---------------- Conectores ----------------
function showConnectors() {
  const card = (icon, name, status, cls, text) => `
    <article class="card connector">
      <div class="conn-head"><span class="conn-icon">${icon}</span><h3>${name}</h3><span class="badge ${cls}">${status}</span></div>
      <p class="muted">${text}</p>
    </article>`;
  shell('connectors', 'Conectores', `
    <div class="grid">
      ${card('XLS', 'Excel / CSV', 'Ativo', 'ok', 'Importe planilhas .xlsx, .xls e .csv (separador ; ou ,). Números e datas no padrão brasileiro são reconhecidos.')}
      ${card('TOTVS', 'Protheus (SQL Server)', 'Fase 2', 'warn', 'Um agente instalado no servidor da empresa lê as tabelas (SD2, SF2, SB1, SB2…) e envia os dados para a nuvem em horários agendados.')}
      ${card('SAP', 'SAP ECC / S/4HANA', 'Fase 3', 'muted', 'Integração via OData ou extração por agente local, com o mesmo modelo de envio agendado.')}
      ${card('G', 'Google Planilhas', 'Fase 2', 'warn', 'Conexão direta com uma planilha do Google, atualizando o painel automaticamente.')}
    </div>
    <div class="card">
      <h3>Enquanto o conector Protheus não chega</h3>
      <p class="muted">Rode esta consulta no SQL Server do Protheus, salve o resultado em Excel e importe. Ajuste o sufixo das tabelas (010) e o filtro de filial ao seu ambiente.</p>
      <pre class="code">SELECT
  SD2.D2_FILIAL   AS Filial,
  SD2.D2_EMISSAO  AS Data_Emissao,
  SD2.D2_DOC      AS Nota,
  SD2.D2_COD      AS Cod_Produto,
  SB1.B1_DESC     AS Produto,
  SB1.B1_TIPO     AS Tipo_Produto,
  SA1.A1_NOME     AS Cliente,
  SA1.A1_EST      AS Estado,
  SD2.D2_QUANT    AS Quantidade,
  SD2.D2_TOTAL    AS Valor_Total
FROM SD2010 SD2
JOIN SB1010 SB1 ON SB1.B1_COD = SD2.D2_COD
               AND SB1.D_E_L_E_T_ = ' '
JOIN SA1010 SA1 ON SA1.A1_COD = SD2.D2_CLIENTE
               AND SA1.A1_LOJA = SD2.D2_LOJA
               AND SA1.D_E_L_E_T_ = ' '
WHERE SD2.D_E_L_E_T_ = ' '
  AND SD2.D2_TIPO = 'N'
  AND SD2.D2_EMISSAO >= '20250101'</pre>
    </div>`);
}
