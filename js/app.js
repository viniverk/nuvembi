// =============================================================
//  NuvemBI — aplicação principal (telas e navegação)
// =============================================================
import { firebaseConfig, APP_NAME, MAX_ROWS } from './firebase-config.js?v=29';
import { createStore, ROLES } from './store.js?v=29';
import { readFile, normalizeRows } from './parser.js?v=29';
import { mountDashboard, suggestConfig } from './dashboard.js?v=29';
import { buildModel } from './model.js?v=29';
import { summarize, ingest, SUM_GRAINS, COUNT_FIELD } from './summarize.js?v=29';
import { ColTable } from './coltable.js?v=29';
import { runScript, defaultScript, FUNCTION_NAMES, FUNCTION_HELP, highlightScript } from './script.js?v=29';

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('pt-BR');
const TYPE_LABEL = { text: 'Texto', number: 'Número', date: 'Data' };
const PREVIEW_ROWS = 5000;   // linhas lidas do QVD para a prévia e detecção de tipos

let store, user, workspace = { orgs: [], invites: [] };
const rowsCache = new Map();
const role = () => store.org?.role;
const canEdit = () => ['admin', 'editor'].includes(role());
const isAdmin = () => role() === 'admin';
const publicToken = () => { const m = location.hash.match(/^#\/p\/([\w-]+)/); return m ? m[1] : null; };

init();

async function init() {
  try {
    store = await createStore(firebaseConfig);
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="loading">Não foi possível conectar ao Firebase. Confira o arquivo js/firebase-config.js.</div>`;
    return;
  }
  store.onAuth(async u => {
    user = u;
    rowsCache.clear();
    if (publicToken()) return showPublic(publicToken());
    if (!u) return showLogin();
    if (await bootWorkspace()) route();
  });
  window.addEventListener('hashchange', () => {
    if (publicToken()) return showPublic(publicToken());
    if (user && store.org) route();
    else if (!user) showLogin();
  });
}

// escolhe a empresa do usuário (cria uma na 1ª entrada e traz os painéis antigos)
async function bootWorkspace(preferId) {
  $app.innerHTML = '<div class="loading">Carregando sua empresa…</div>';
  try {
    workspace = await store.loadWorkspace();
    if (!workspace.orgs.length) {
      if (workspace.invites.length) { showInvitesOnly(); return false; }
      workspace.orgs.push(await store.createOrg(`Empresa de ${user.email.split('@')[0]}`));
    }
    const want = preferId || store.savedOrgId();
    store.useOrg(workspace.orgs.find(o => o.id === want) || workspace.orgs[0]);
    if (await store.needsMigration()) {
      const n = await store.migrateLegacy();
      if (n) toast(`${n} app(s) trazido(s) para a empresa.`);
    }
    return true;
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="loading">Não foi possível carregar sua empresa. ${esc(e.code || e.message || '')}<br><br><button class="btn" onclick="location.reload()">Tentar de novo</button></div>`;
    return false;
  }
}

// convidado que ainda não tem empresa: aceita um convite ou cria a própria
function showInvitesOnly() {
  $app.innerHTML = `
    <div class="center-page"><div class="card invite-page">
      <div class="brand"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> ${APP_NAME}</div>
      <h2>Você foi convidado</h2>
      ${inviteListHtml(workspace.invites)}
      <p class="muted">Ou comece do zero com a sua própria empresa.</p>
      <button class="btn ghost" id="btn-own">Criar minha empresa</button>
      <button class="btn link" id="btn-out">Sair</button>
    </div></div>`;
  bindInviteButtons($app);
  $app.querySelector('#btn-own').addEventListener('click', async () => {
    const o = await store.createOrg(`Empresa de ${user.email.split('@')[0]}`);
    if (await bootWorkspace(o.id)) { location.hash = '#/'; route(); }
  });
  $app.querySelector('#btn-out').addEventListener('click', () => store.signOut());
}

function inviteListHtml(invites) {
  return invites.map(i => `
    <div class="invite-card">
      <div><strong>${esc(i.orgName)}</strong><small class="muted">Convite de ${esc(i.invitedBy)} · como ${esc(ROLES[i.role] || i.role)}</small></div>
      <div class="row-actions">
        <button class="btn small" data-accept="${esc(i.id)}">Aceitar</button>
        <button class="btn ghost small" data-decline="${esc(i.id)}">Recusar</button>
      </div>
    </div>`).join('');
}
function bindInviteButtons(root) {
  root.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const o = await store.acceptInvite(workspace.invites.find(i => i.id === b.dataset.accept));
      toast(`Você entrou em ${o.name}.`);
      if (await bootWorkspace(o.id)) { location.hash = '#/'; route(); }
    } catch (e) { console.error(e); toast('Não foi possível aceitar o convite.', 'err'); b.disabled = false; }
  }));
  root.querySelectorAll('[data-decline]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Recusar este convite?')) return;
    await store.declineInvite(workspace.invites.find(i => i.id === b.dataset.decline));
    if (await bootWorkspace()) route();
  }));
}

function route() {
  const [view, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'importar') return showUpload();
  if (view === 'conectores') return showConnectors();
  if (view === 'equipe') return showTeam();
  if ((view === 'painel' || view === 'app') && id) return showDashboard(id);
  if (view === 'dados' && id) return showDataManager(id);
  if (view === 'script' && id) return showScriptEditor(id);
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
      <div class="brand big"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> ${APP_NAME}</div>
      <h1>Seus dados do ERP, de planilhas e de arquivos QVD em apps de BI prontos, na nuvem.</h1>
      <ul class="bullets">
        <li>Importe planilhas Excel e CSV em segundos</li>
        <li>Apps com várias tabelas, pastas e editor de script</li>
        <li>Protheus e SAP: conectores em desenvolvimento</li>
      </ul>
    </section>
    <section class="login-box card">
      <img class="login-logo" src="img/logo-nuvembi.png" alt="${APP_NAME}">
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
  const item = (hash, label, key) => { const [ic, ...rest] = label.split(' '); return `<a href="#/${hash}" class="${active === key ? 'active' : ''}" title="${esc(rest.join(' '))}"><b>${ic}</b><span>${rest.join(' ')}</span></a>`; };
  let collapsed = false;
  try { collapsed = localStorage.getItem('nbi-side') === '1'; } catch {}
  $app.innerHTML = `
  <div class="layout ${collapsed ? 'side-min' : ''}">
    <aside class="sidebar">
      <div class="brand"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> <span>${APP_NAME}</span>
        <button class="side-toggle" id="side-toggle" title="Recolher / expandir o menu">«</button></div>
      <div class="org-box">
        <small>Empresa</small>
        ${workspace.orgs.length > 1
          ? `<select id="org-switch">${workspace.orgs.map(o => `<option value="${esc(o.id)}" ${o.id === store.org.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`
          : `<strong title="${esc(store.org.name)}">${esc(store.org.name)}</strong>`}
        <span class="role-badge ${role()}">${esc(ROLES[role()])}</span>
      </div>
      <nav>
        ${item('', '▦ Meus apps', 'home')}
        ${canEdit() ? item('importar', '⇪ Importar arquivo', 'upload') : ''}
        ${item('equipe', '👥 Equipe', 'team')}
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
  document.getElementById('side-toggle').addEventListener('click', () => {
    const l = $app.querySelector('.layout');
    l.classList.toggle('side-min');
    try { localStorage.setItem('nbi-side', l.classList.contains('side-min') ? '1' : '0'); } catch {}
    window.dispatchEvent(new Event('resize'));   // gráficos se ajustam à nova largura
  });
  document.getElementById('org-switch')?.addEventListener('change', async e => {
    rowsCache.clear();
    if (await bootWorkspace(e.target.value)) { location.hash = '#/'; route(); }
  });
  return document.getElementById('view');
}

// ---------------- Home ----------------
async function showHome() {
  const view = shell('home', 'Meus apps', '<div class="loading">Carregando…</div>',
    canEdit() ? `<button class="btn" id="btn-newapp">+ Novo app</button>` : '');
  document.getElementById('btn-newapp')?.addEventListener('click', openNewApp);
  let list = [];
  try { list = await store.listDatasets(); }
  catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erro ao carregar seus dados.</div>`; return; }

  const invitesBanner = workspace.invites.length ? `
    <div class="card invites-banner"><h3>Convites pendentes</h3>${inviteListHtml(workspace.invites)}</div>` : '';
  if (!list.length) {
    view.innerHTML = `${invitesBanner}
      <div class="empty card">
        <div class="empty-icon">▦</div>
        <h2>${canEdit() ? 'Você ainda não tem apps' : 'Nenhum app ainda'}</h2>
        <p>${canEdit() ? `Importe uma planilha de vendas, estoque ou compras e o ${APP_NAME} monta o app para você.` : 'Quando alguém da sua empresa criar um app, ele aparece aqui.'}</p>
        ${canEdit() ? '<div class="row-actions center-actions"><button class="btn" data-newapp>+ Novo app</button><a class="btn ghost" href="#/importar">Importar uma planilha</a></div>' : ''}
      </div>`;
    bindInviteButtons(view);
    view.querySelector('[data-newapp]')?.addEventListener('click', openNewApp);
    return;
  }
  view.innerHTML = `${invitesBanner}<div class="grid">${list.map(d => `
    <article class="ds card">
      <div class="ds-head"><span class="ds-icon">${d.source === 'csv' ? 'CSV' : d.source === 'qvd' ? 'QVD' : d.source === 'app' ? 'APP' : 'XLS'}</span>
        <div><h3>${esc(d.name)}</h3><small>${new Date(d.createdAt).toLocaleDateString('pt-BR')}${d.createdBy ? ` · ${esc(d.createdBy)}` : ''}</small></div>
        ${d.shareId ? '<span class="badge ok shared-badge" title="Tem link público ativo">🔗 Link ativo</span>' : ''}</div>
      <p class="muted">${nf.format((d.rowCount || 0) + (d.tables || []).reduce((t, x) => t + (x.rowCount || 0), 0))} linhas · ${(d.columns.length ? 1 : 0) + (d.tables || []).length} tabela(s)${d.updatedAt ? ` · atualizado em ${new Date(d.updatedAt).toLocaleDateString('pt-BR')}` : ''}</p>
      <div class="tags">${d.columns.slice(0, 5).map(c => `<span class="tag ${c.type}">${esc(c.name)}</span>`).join('')}${d.columns.length > 5 ? `<span class="tag">+${d.columns.length - 5}</span>` : ''}</div>
      <div class="ds-actions">
        <a class="btn small" href="#/painel/${encodeURIComponent(d.id)}">Abrir app</a>
        ${canEdit() ? `<a class="btn ghost small" href="#/dados/${encodeURIComponent(d.id)}">🗄 Dados</a>` : ''}
        ${canEdit() ? `<button class="btn ghost small danger" data-del="${esc(d.id)}" data-name="${esc(d.name)}">Excluir</button>` : ''}
      </div>
    </article>`).join('')}</div>`;

  view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Excluir o app "${b.dataset.name}" e todos os seus dados? Isso não pode ser desfeito.`)) return;
    b.disabled = true;
    try { await store.deleteDataset(b.dataset.del); rowsCache.delete(b.dataset.del); toast('App excluído.'); showHome(); }
    catch (e) { console.error(e); toast('Erro ao excluir.', 'err'); b.disabled = false; }
  }));
  bindInviteButtons(view);
  view.querySelectorAll('[data-refresh]').forEach(b => b.addEventListener('click', () => openRefresh(list.find(d => d.id === b.dataset.refresh))));
}

// ---------------- Novo app ----------------
function openNewApp() {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <form class="modal card">
      <header><h2>Novo app</h2><button type="button" class="x" data-close>×</button></header>
      <div class="modal-body">
        <label class="field"><span>Nome do app</span><input name="name" required maxlength="60" placeholder="Ex.: Compras 2026"></label>
        <div class="newapp-options">
          <button type="submit" class="newapp-opt"><strong>🗄 App vazio</strong><span>Crie o app e adicione várias tabelas (Excel, CSV, QVD) no Gerenciador de dados.</span></button>
          <a class="newapp-opt" href="#/importar" data-close><strong>⇪ A partir de um arquivo</strong><span>Escolha uma planilha ou QVD e o app já sai com um painel pronto.</span></a>
        </div>
      </div>
    </form>`;
  document.body.append(back);
  const close = () => back.remove();
  back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  const form = back.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return;
    try { const id = await store.createApp(name); close(); toast('App criado.'); location.hash = `#/dados/${encodeURIComponent(id)}`; }
    catch (err) { console.error(err); toast('Não foi possível criar o app.', 'err'); }
  });
  setTimeout(() => form.name.focus(), 30);
}

// ---------------- Janela: escolher colunas da importação ----------------
function chooseColumns(sheet, onApply) {
  document.querySelector('.cols-modal')?.remove();
  const sample = c => { for (const r of sheet.data) { const v = r[c.index]; if (v !== null && v !== undefined && v !== '') return v instanceof Date ? v.toLocaleDateString('pt-BR') : String(v); } return ''; };
  const keep = sheet.columns.map(c => c.keep !== false);
  const back = document.createElement('div');
  back.className = 'modal-back cols-modal';
  back.innerHTML = `
    <div class="modal card modal-wide">
      <header><h2>Escolher colunas</h2><button class="x" data-close>×</button></header>
      <div class="modal-body">
        <p class="muted">O arquivo tem <strong>${sheet.columns.length} colunas</strong>. Desmarque as que não precisa no app — ele fica menor e abre mais rápido.</p>
        <div class="cols-tools">
          <input id="cols-search" placeholder="Pesquisar coluna…">
          <button type="button" class="btn ghost small" data-c="all">Selecionar todas</button>
          <button type="button" class="btn ghost small" data-c="none">Limpar seleção</button>
          <span class="muted small" id="cols-count"></span>
        </div>
        <div class="cols-list"></div>
      </div>
      <footer><button class="btn ghost" data-close>Cancelar</button><button class="btn" id="cols-ok">Aplicar</button></footer>
    </div>`;
  document.body.append(back);
  const list = back.querySelector('.cols-list'), search = back.querySelector('#cols-search');
  const visible = () => { const q = search.value.trim().toLowerCase(); return sheet.columns.map((c, i) => i).filter(i => !q || sheet.columns[i].name.toLowerCase().includes(q)); };
  const paint = () => {
    list.innerHTML = visible().map(i => {
      const c = sheet.columns[i];
      return `<label class="col-item ${keep[i] ? '' : 'off'}"><input type="checkbox" data-i="${i}" ${keep[i] ? 'checked' : ''}>
        <span class="ci-name">${esc(c.name)}</span><span class="tag ${c.type}">${TYPE_LABEL[c.type]}</span>
        <small class="muted ci-sample">${esc(sample(c).slice(0, 40))}</small></label>`;
    }).join('') || '<div class="muted">Nenhuma coluna encontrada.</div>';
    back.querySelector('#cols-count').textContent = `${keep.filter(Boolean).length} de ${keep.length} selecionadas`;
  };
  list.addEventListener('change', e => { const i = +e.target.dataset.i; keep[i] = e.target.checked; e.target.closest('.col-item').classList.toggle('off', !keep[i]); back.querySelector('#cols-count').textContent = `${keep.filter(Boolean).length} de ${keep.length} selecionadas`; });
  search.addEventListener('input', paint);
  // os botões valem para as colunas visíveis (a pesquisa permite marcar/desmarcar um grupo)
  back.querySelector('[data-c="all"]').addEventListener('click', () => { visible().forEach(i => (keep[i] = true)); paint(); });
  back.querySelector('[data-c="none"]').addEventListener('click', () => { visible().forEach(i => (keep[i] = false)); paint(); });
  const close = () => back.remove();
  back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.querySelector('#cols-ok').addEventListener('click', () => {
    if (!keep.some(Boolean)) { toast('Selecione pelo menos uma coluna.', 'err'); return; }
    sheet.columns.forEach((c, i) => (c.keep = keep[i]));
    close(); onApply();
  });
  paint();
  setTimeout(() => search.focus(), 30);
}

// ---------------- Atualizar dados de um painel ----------------
function openRefresh(ds) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal card">
      <header><h2>Atualizar dados de "${esc(ds.name)}"</h2><button class="x" data-close>×</button></header>
      <div class="modal-body">
        <p class="muted">Envie a planilha nova. Gráficos, filtros, itens mestres e o link compartilhado continuam iguais.</p>
        <div class="mode-pick">
          <label class="check"><input type="radio" name="rmode" value="replace" checked><span><strong>Substituir</strong> todos os dados pelos da planilha</span></label>
          <label class="check"><input type="radio" name="rmode" value="append"><span><strong>Acrescentar</strong> as linhas da planilha ao final (ex.: fechamento do mês)</span></label>
        </div>
        <label class="drop small-drop"><input type="file" id="rfile" accept=".xlsx,.xls,.xlsm,.csv,.txt,.qvd" hidden>
          <strong>Escolher planilha</strong><span class="muted">Excel, CSV ou QVD</span></label>
        <div id="rsummary"></div>
      </div>
      <footer><button class="btn ghost" data-close>Cancelar</button><button class="btn" id="rgo" disabled>Atualizar dados</button></footer>
    </div>`;
  document.body.append(back);
  const close = () => back.remove();
  back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  const summary = back.querySelector('#rsummary');
  const go = back.querySelector('#rgo');
  let sheets = null, sheet = null;

  // liga cada coluna da planilha nova à coluna do painel com o mesmo nome (sem diferenciar maiúsculas)
  const mapColumns = sh => sh.columns.map(c => {
    const old = ds.columns.find(o => o.name.toLowerCase() === c.name.toLowerCase());
    return old ? { ...c, name: old.name, type: old.type, matched: true } : { ...c, matched: false };
  });

  const paint = () => {
    if (!sheet) return;
    const mapped = mapColumns(sheet);
    const same = mapped.filter(c => c.matched), extra = mapped.filter(c => !c.matched);
    const missing = ds.columns.filter(o => !mapped.some(c => c.name === o.name) && !(ds.summary && o.name.startsWith(COUNT_FIELD)));
    const append = back.querySelector('input[name=rmode]:checked').value === 'append';
    const fileRows = sheet.total || sheet.data.length;
    const total = append ? ds.rowCount + fileRows : fileRows;
    summary.innerHTML = `
      ${sheets.length > 1 ? `<label class="field"><span>Aba</span><select id="rsheet">${sheets.map((s, i) => `<option value="${i}" ${s === sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
      <div class="refresh-summary">
        <div><strong>${nf.format(sheet.total || sheet.data.length)}</strong> linhas no arquivo → ${ds.summary ? 'serão resumidas como na importação' : `a tabela fica com <strong>${nf.format(Math.min(total, MAX_ROWS))}</strong> linhas`}
          ${append ? `<span class="muted">(${nf.format(ds.rowCount)} atuais + ${nf.format(fileRows)} novas)</span>` : ''}</div>
        <div class="ok-text">✓ ${same.length} coluna(s) iguais às da tabela</div>
        ${extra.length ? (ds.summary ? `<div class="muted">Ignoradas no resumo: ${extra.map(c => esc(c.name)).join(', ')}</div>` : `<div>+ ${extra.length} coluna(s) nova(s): ${extra.map(c => esc(c.name)).join(', ')}</div>`) : ''}
        ${missing.length ? `<div class="warn-text">⚠ Não encontradas na planilha: ${missing.map(c => esc(c.name)).join(', ')}.${append ? ' As linhas novas ficam sem esses valores.' : ' Gráficos e filtros que usam essas colunas vão ficar vazios.'}</div>` : ''}
        ${!same.length ? '<div class="error">Nenhuma coluna bate com a tabela — parece ser outra planilha.</div>' : ''}
        ${ds.summary ? `<div class="ok-text">Σ Esta tabela é resumida: o arquivo novo será resumido do mesmo jeito (${ds.summary.keep.length} campos${Object.values(ds.summary.grains || {}).includes('month') ? ', datas por mês' : ''}${ds.summary.from ? `, a partir de ${new Date(ds.summary.from + 'T12:00').toLocaleDateString('pt-BR')}` : ''}).</div>`
          : total > MAX_ROWS ? `<div class="warn-text">⚠ Passa do limite de ${nf.format(MAX_ROWS)} linhas; o excedente fica de fora.</div>` : ''}
        ${append ? '<div class="muted small">Dica: o sistema não remove linhas repetidas. Se a planilha já tem os meses anteriores, use "Substituir".</div>' : ''}
      </div>`;
    summary.querySelector('#rsheet')?.addEventListener('change', e => { sheet = sheets[+e.target.value]; paint(); });
    go.disabled = !same.length;
  };
  back.querySelectorAll('input[name=rmode]').forEach(r => r.addEventListener('change', paint));
  back.querySelector('#rfile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    summary.innerHTML = `<div class="muted">Lendo ${esc(file.name)}…</div>`;
    try { sheets = await readFile(file, { maxRows: PREVIEW_ROWS }); }
    catch (err) { console.error(err); summary.innerHTML = `<div class="error">Não consegui ler este arquivo.</div>`; return; }
    if (!sheets.length) { summary.innerHTML = '<div class="error">O arquivo está vazio.</div>'; return; }
    // escolhe a aba que mais combina com as colunas do painel
    const score = s => mapColumns(s).filter(c => c.matched).length;
    sheet = [...sheets].sort((a, b) => score(b) - score(a))[0];
    back.querySelector('.small-drop strong').textContent = file.name;
    paint();
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    const append = back.querySelector('input[name=rmode]:checked').value === 'append';
    const mapped = mapColumns(sheet);
    try {
      go.textContent = ds.summary ? 'Resumindo…' : 'Preparando…';
      await new Promise(r => setTimeout(r, 30));
      let table, columns;
      if (ds.summary) {
        const keep = ds.summary.keep.filter(n => mapped.some(c => c.name === n));
        const r = summarize(sheet, mapped, { ...ds.summary, keep });
        table = r.table; columns = r.columns;
      } else {
        table = ingest(sheet, mapped, { limit: MAX_ROWS }).table;
        columns = mapped.map(({ name, type }) => ({ name, type }));
      }
      if (append) {
        const old = rowsCache.get(ds.id)?.main || await store.loadRows(ds.id);
        columns = [...ds.columns, ...columns.filter(c => !ds.columns.some(o => o.name === c.name))];
        table = ColTable.concat(old, table, columns);
      }
      table = table.slice(MAX_ROWS);
      await store.replaceData(ds.id, { columns, rowCount: table.n }, table, p => (go.textContent = `Enviando… ${Math.round(p * 100)}%`));
      rowsCache.delete(ds.id);
      close();
      toast(`Dados atualizados: ${nf.format(table.n)} linhas.`);
      afterDataChange(ds.id);
    } catch (err) {
      console.error(err); toast('Não foi possível atualizar os dados.', 'err');
      go.disabled = false; go.textContent = 'Atualizar dados';
    }
  });
}

// ---------------- Modelo de dados (várias tabelas) ----------------
function modelSvg(model) {
  // layout em estrela: principal à esquerda, demais tabelas empilhadas à direita (linhas não se cruzam)
  const W = 230, GAPX = 150, GAPY = 28, HEAD = 40, ROWH = 21, MAXF = 12;
  const keys = new Set(model.keys);
  const boxes = model.tables.map(t => {
    const shown = [...t.columns].sort((a, b) => (keys.has(b.name) - keys.has(a.name))).slice(0, MAXF);
    const h = HEAD + shown.length * ROWH + (t.columns.length > MAXF ? ROWH : 0) + 10;
    return { t, shown, h };
  });
  const [main, ...rest] = boxes;
  const restH = rest.reduce((s, b) => s + b.h + GAPY, 0) - GAPY;
  const height = 20 + Math.max(main.h, restH);
  main.x = 10; main.y = 10 + Math.max(0, (height - 20 - main.h) / 2);
  let yy = 10 + Math.max(0, (height - 20 - restH) / 2);
  rest.forEach(b => { b.x = 10 + W + GAPX; b.y = yy; yy += b.h + GAPY; });
  const width = 20 + (rest.length ? 2 * W + GAPX : W) + 70;   // margem para ligações entre tabelas da direita
  const fieldY = (b, f) => { const i = b.shown.findIndex(c => c.name === f); return b.y + HEAD + (i < 0 ? 0 : i) * ROWH + ROWH / 2 + 2; };
  // ligações: cada tabela com a chave se liga à primeira tabela que também tem a chave
  let lines = '';
  for (const k of model.keys) {
    const bs = boxes.filter(b => b.t.columns.some(c => c.name === k));
    for (let i = 1; i < bs.length; i++) {
      const a = bs[0], b = bs[i];   // bs[0] é a principal quando ela tem a chave
      const aRight = a.x < b.x, sameCol = a.x === b.x;
      const x1 = sameCol ? a.x + W : (aRight ? a.x + W : a.x), x2 = sameCol ? b.x + W : (aRight ? b.x : b.x + W);
      const y1 = fieldY(a, k), y2 = fieldY(b, k);
      const mx = sameCol ? x1 + 55 : (x1 + x2) / 2;
      lines += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" class="mlink"/>`;
    }
  }
  const boxSvg = boxes.map(b => `
    <g>
      <rect x="${b.x}" y="${b.y}" width="${W}" height="${b.h}" rx="10" class="mbox ${b.t.id === 'main' ? 'main' : ''}"/>
      <rect x="${b.x}" y="${b.y}" width="${W}" height="${HEAD - 6}" rx="10" class="mhead ${b.t.id === 'main' ? 'main' : ''}"/>
      <rect x="${b.x}" y="${b.y + HEAD - 16}" width="${W}" height="10" class="mhead ${b.t.id === 'main' ? 'main' : ''}"/>
      <text x="${b.x + 12}" y="${b.y + 22}" class="mtitle">${esc(b.t.name.length > 22 ? b.t.name.slice(0, 21) + '…' : b.t.name)}</text>
      <text x="${b.x + W - 12}" y="${b.y + 22}" text-anchor="end" class="mcount">${nf.format(b.t.n)}</text>
      ${b.shown.map((c, i) => `<text x="${b.x + 14}" y="${b.y + HEAD + i * ROWH + 14}" class="mfield ${keys.has(c.name) ? 'key' : ''}">${keys.has(c.name) ? '🔑 ' : ''}${esc(c.name.length > 26 ? c.name.slice(0, 25) + '…' : c.name)}</text>`).join('')}
      ${b.t.columns.length > MAXF ? `<text x="${b.x + 14}" y="${b.y + HEAD + MAXF * ROWH + 14}" class="mmore">+ ${b.t.columns.length - MAXF} campos</text>` : ''}
    </g>`).join('');
  return `<svg class="model-svg" viewBox="0 0 ${width} ${height}" style="max-width:${width}px">${lines}${boxSvg}</svg>`;
}

// adicionar uma tabela ao painel (ou atualizar uma tabela extra existente)
function openAddTable(ds, data, existing = null) {
  const others = buildModel({ ...ds, tables: (ds.tables || []).filter(t => !existing || t.id !== existing.id) }, data);
  const fieldsElsewhere = others.fields; // campos das outras tabelas (para ligar)
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal card modal-wide">
      <header><h2>${existing ? `Atualizar tabela "${esc(existing.name)}"` : 'Adicionar dados ao app'}</h2><button class="x" data-close>×</button></header>
      <div class="modal-body">
        <p class="muted">${existing ? 'Envie a planilha nova desta tabela. Os nomes dos campos são mantidos quando batem.' : 'Ex.: Metas por vendedor, cadastro de Vendedores ou de Produtos.'} Campos com o <strong>mesmo nome</strong> de um campo de outra tabela viram ligação 🔗 — renomeie aqui para ligar ou desligar.</p>
        <label class="drop small-drop"><input type="file" id="tfile" accept=".xlsx,.xls,.xlsm,.csv,.txt,.qvd" hidden><strong>Escolher planilha</strong><span class="muted">Excel, CSV ou QVD</span></label>
        <div id="tbody"></div>
      </div>
      <footer><button class="btn ghost" data-close>Cancelar</button><button class="btn" id="tgo" disabled>${existing ? 'Atualizar tabela' : 'Adicionar tabela'}</button></footer>
    </div>`;
  document.body.append(back);
  const close = () => back.remove();
  back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  const body = back.querySelector('#tbody'), go = back.querySelector('#tgo');
  let sheets = null, sheet = null, cols = [];

  const findField = name => fieldsElsewhere.find(f => f.name.toLowerCase() === name.trim().toLowerCase());
  const tableNames = f => f.tables.map(id => others.byId[id].name).join(', ');

  const setSheet = sh => {
    sheet = sh;
    cols = sh.columns.map(c => {
      const prev = existing?.columns.find(o => o.name.toLowerCase() === c.name.toLowerCase());
      const ef = findField(c.name);
      return { index: c.index, orig: c.name, name: prev ? prev.name : ef ? ef.name : c.name, type: prev ? prev.type : ef ? ef.type : c.type };
    });
    paint();
  };
  const status = () => {
    const names = cols.map(c => c.name.trim());
    const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
    const links = cols.map(c => ({ c, f: findField(c.name) })).filter(x => x.f);
    const perTable = {};
    links.forEach(({ f }) => f.tables.forEach(id => (perTable[id] = (perTable[id] || 0) + 1)));
    const multi = Object.entries(perTable).filter(([, n]) => n > 1).map(([id]) => others.byId[id].name);
    return { dup, links, multi, empty: names.some(n => !n) };
  };
  const paint = () => {
    if (!sheet) return;
    const st = status();
    const defaultName = existing ? existing.name : (sheets.length > 1 ? sheet.name : back.querySelector('.small-drop strong').textContent.replace(/\.[^.]+$/, ''));
    const curName = body.querySelector('#tname')?.value ?? defaultName;
    body.innerHTML = `
      <div class="preview-head">
        <label class="field grow"><span>Nome da tabela</span><input id="tname" value="${esc(curName)}" maxlength="40"></label>
        ${sheets.length > 1 ? `<label class="field"><span>Aba</span><select id="tsheet">${sheets.map((s2, i) => `<option value="${i}" ${s2 === sheet ? 'selected' : ''}>${esc(s2.name)}</option>`).join('')}</select></label>` : ''}
      </div>
      <p class="muted small">${nf.format(sheet.total || sheet.data.length)} linhas · ${cols.length} campos${sheet.total > MAX_ROWS ? ` <span class="warn-text">(só as primeiras ${nf.format(MAX_ROWS)} serão usadas)</span>` : ''}</p>
      <div class="table-wrap"><table class="map-table">
        <thead><tr><th>Coluna na planilha</th><th>Nome do campo</th><th>Tipo</th><th>Ligação</th></tr></thead>
        <tbody>${cols.map((c, i) => {
          const f = findField(c.name);
          return `<tr>
            <td class="muted">${esc(c.orig)}</td>
            <td><input data-cname="${i}" value="${esc(c.name)}"></td>
            <td><select data-ctype="${i}">${Object.entries({ text: 'Texto', number: 'Número', date: 'Data' }).map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
            <td>${f ? `<span class="link-ok">🔗 liga com ${esc(tableNames(f))}</span>` : '<span class="muted">—</span>'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      <div class="refresh-summary">
        ${st.links.length ? `<div class="ok-text">🔗 Liga ao modelo por: ${st.links.map(x => esc(x.f.name)).join(', ')}</div>` : '<div class="warn-text">⚠ Nenhum campo com o mesmo nome de outra tabela: esta tabela vai ficar solta (as seleções não a filtram). Renomeie a coluna-chave para o nome usado no app, por exemplo "Vendedor".</div>'}
        ${st.multi.length ? `<div class="warn-text">⚠ Liga com ${esc(st.multi.join(', '))} por mais de um campo. Isso pode gerar resultados inesperados (chave sintética). Prefira um campo-chave só: renomeie os outros.</div>` : ''}
        ${st.dup.length ? `<div class="error">Nomes repetidos: ${esc([...new Set(st.dup)].join(', '))}</div>` : ''}
        ${st.empty ? '<div class="error">Todo campo precisa de um nome.</div>' : ''}
      </div>`;
    body.querySelector('#tsheet')?.addEventListener('change', e => setSheet(sheets[+e.target.value]));
    body.querySelectorAll('[data-cname]').forEach(inp => inp.addEventListener('change', () => { cols[+inp.dataset.cname].name = inp.value; const f = findField(inp.value); if (f) cols[+inp.dataset.cname].type = f.type; paint(); }));
    body.querySelectorAll('[data-ctype]').forEach(sel => sel.addEventListener('change', () => (cols[+sel.dataset.ctype].type = sel.value)));
    go.disabled = !!(st.dup.length || st.empty);
  };
  back.querySelector('#tfile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    body.innerHTML = `<div class="muted">Lendo ${esc(file.name)}…</div>`;
    try { sheets = await readFile(file, { maxRows: PREVIEW_ROWS }); } catch (err) { console.error(err); body.innerHTML = '<div class="error">Não consegui ler este arquivo.</div>'; return; }
    if (!sheets.length) { body.innerHTML = '<div class="error">O arquivo está vazio.</div>'; return; }
    back.querySelector('.small-drop strong').textContent = file.name;
    setSheet(sheets[0]);
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    const name = (body.querySelector('#tname').value || 'Tabela').trim();
    // nomes que batem com campos de outras tabelas usam a grafia exata (para ligar)
    const final = cols.map(c => { const f = findField(c.name); return { index: c.index, name: f ? f.name : c.name.trim(), type: c.type }; });
    try {
      const rows = ingest(sheet, final, { limit: MAX_ROWS }).table;
      const columns = final.map(({ name: n, type }) => ({ name: n, type }));
      const prog = p => (go.textContent = `Enviando… ${Math.round(p * 100)}%`);
      ds.tables = existing ? await store.replaceTable(ds.id, existing.id, { name, columns }, rows, prog)
                           : await store.addTable(ds.id, { name, columns }, rows, prog);
      rowsCache.delete(ds.id);
      close();
      toast(existing ? `Tabela "${name}" atualizada.` : `Tabela "${name}" adicionada ao app.`);
      afterDataChange(ds.id);
    } catch (err) {
      console.error(err); toast('Não foi possível salvar a tabela.', 'err');
      go.disabled = false; go.textContent = existing ? 'Atualizar tabela' : 'Adicionar tabela';
    }
  });
}

// ---------------- Importar ----------------
function showUpload() {
  if (!canEdit()) { location.hash = '#/'; return; }
  const view = shell('upload', 'Importar dados', `
    <div class="card">
      <label class="drop" id="drop">
        <input type="file" id="file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.qvd" hidden>
        <div class="drop-icon">⇪</div>
        <strong>Arraste sua planilha aqui ou clique para escolher</strong>
        <span class="muted">Excel (.xlsx, .xls), CSV ou QVD · até ${nf.format(MAX_ROWS)} linhas · a primeira linha deve ter os títulos</span>
      </label>
      <p class="muted tip">Dica: já tem arquivos <strong>.qvd</strong>? Envie direto, eles vêm com os tipos certos. Também dá para exportar uma consulta do Protheus ou SAP para Excel. Datas no formato aaaammdd (ex.: D2_EMISSAO) são reconhecidas automaticamente.</p>
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
  try { sheets = await readFile(file, { maxRows: PREVIEW_ROWS }); }
  catch (e) { console.error(e); preview.innerHTML = `<div class="card error">Não consegui ler este arquivo. ${esc(e.message || '')}</div>`; return; }
  if (!sheets.length) { preview.innerHTML = `<div class="card error">O arquivo está vazio.</div>`; return; }

  let sheet = sheets[0];
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const source = /\.(csv|txt)$/i.test(file.name) ? 'csv' : /\.qvd$/i.test(file.name) ? 'qvd' : 'excel';

  // colunas escolhidas para importar (todas marcadas por padrão)
  const active = () => sheet.columns.filter(c => c.keep !== false);
  sheets.forEach(sh => sh.columns.forEach(c => { if (c.keep === undefined) c.keep = true; }));
  const askedCols = new Set();   // abas em que a janela "Escolher colunas" já abriu sozinha

  // configuração do resumo (para arquivos grandes)
  let sumOn = false, sumKeep = null, sumGrains = {}, sumFrom = '', sumDateCol = null, sumResult = null, sumSig = '';
  const sumSignature = () => JSON.stringify([sumKeep, sumGrains, sumFrom, sumDateCol, sheet.columns.map(c => c.type + (c.keep === false ? '-' : '')), sheet.name]);
  const resetSum = () => {
    sumKeep = active().map(c => c.name);
    const dates = active().filter(c => c.type === 'date');
    sumGrains = Object.fromEntries(dates.map(c => [c.name, 'month']));
    sumDateCol = dates[0]?.name || null;
    sumResult = null;
  };
  resetSum();
  sumOn = (sheet.total || sheet.data.length) > MAX_ROWS;

  const runSummary = () => {
    const sig = sumSignature();
    if (sumResult && sig === sumSig) return sumResult;
    const names = new Set(active().map(c => c.name));
    sumResult = summarize(sheet, active(), { keep: sumKeep.filter(n => names.has(n)), grains: sumGrains, from: sumFrom, dateCol: sumDateCol });
    sumSig = sig;
    return sumResult;
  };

  const draw = () => {
    const total = sheet.total || sheet.data.length;
    const tooMany = total > MAX_ROWS;
    const dateCols = active().filter(c => c.type === 'date');
    const nOn = active().length, nAll = sheet.columns.length;
    const sumBox = `
      <details class="summary-box" ${sumOn || tooMany ? 'open' : ''}>
        <summary><strong>Resumir dados antes de importar</strong> ${tooMany ? '<span class="tag warn-tag">recomendado: passa do limite</span>' : '<span class="muted">(opcional)</span>'}</summary>
        <p class="muted small">Agrupa as linhas pelos campos de <strong>texto e data</strong> que você manter e <strong>soma os campos numéricos</strong>. A coluna <code>${COUNT_FIELD}</code> guarda quantas linhas originais cada linha resumida representa. Os totais ficam iguais; desmarque campos que não fazem sentido somar (preço unitário, por exemplo) e códigos muito detalhados (nº da nota, item) para resumir mais.</p>
        <label class="check"><input type="checkbox" id="sum-on" ${sumOn ? 'checked' : ''}><span>Resumir este arquivo</span></label>
        <div class="sum-grid" ${sumOn ? '' : 'hidden'}>
          <div class="sum-cols">${active().map(c => `
            <label class="sum-col ${sumKeep.includes(c.name) ? '' : 'off'}">
              <input type="checkbox" data-keep="${esc(c.name)}" ${sumKeep.includes(c.name) ? 'checked' : ''}>
              <span>${esc(c.name)}</span><small class="muted">${c.type === 'number' ? 'soma' : c.type === 'date' ? 'data' : 'agrupa'}</small>
              ${c.type === 'date' ? `<select data-grain="${esc(c.name)}">${Object.entries(SUM_GRAINS).map(([k, v]) => `<option value="${k}" ${k === (sumGrains[c.name] || 'day') ? 'selected' : ''}>por ${v.toLowerCase()}</option>`).join('')}</select>` : ''}
            </label>`).join('')}</div>
          ${dateCols.length ? `<div class="inline-form">
            <span class="muted small">Importar só a partir de</span>
            <input type="date" id="sum-from" value="${esc(sumFrom)}" style="flex:0 0 170px">
            ${dateCols.length > 1 ? `<select id="sum-datecol">${dateCols.map(c => `<option ${c.name === sumDateCol ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : `<span class="muted small">(${esc(sumDateCol)})</span>`}
          </div>` : ''}
          <div class="inline-form"><button class="btn ghost small" id="sum-calc">Calcular prévia do resumo</button><span id="sum-out" class="small"></span></div>
        </div>
      </details>`;
    preview.innerHTML = `
      <div class="card">
        <div class="preview-head">
          <label class="field grow"><span>Nome do app</span><input id="ds-name" value="${esc(sheets.length > 1 ? `${baseName} - ${sheet.name}` : baseName)}"></label>
          ${sheets.length > 1 ? `<label class="field"><span>Aba</span><select id="sheet">${sheets.map((s, i) => `<option value="${i}" ${s === sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        </div>
        <p class="muted">${nf.format(sheet.total || sheet.data.length)} linhas · ${sheet.columns.length} colunas${sheet.total ? ' · arquivo QVD' : ''}. Confira os tipos detectados — números são somados, datas viram linha do tempo e textos viram filtros.</p>
        ${tooMany && !sumOn ? `<p class="error">Este plano aceita até ${nf.format(MAX_ROWS)} linhas por tabela e o arquivo tem ${nf.format(total)}. Resuma os dados abaixo para usar o arquivo inteiro — sem resumir, só as primeiras ${nf.format(MAX_ROWS)} linhas serão importadas.</p>` : ''}
        <div class="cols-bar">
          <strong class="${nOn ? '' : 'error'}">${nOn} de ${nAll} colunas selecionadas</strong>
          <button type="button" class="btn ghost small" data-cols="all">Selecionar todas</button>
          <button type="button" class="btn ghost small" data-cols="none">Limpar seleção</button>
          <button type="button" class="btn small" data-cols="popup">☰ Escolher colunas…</button>
          <span class="muted small">Desmarque as colunas que não quer importar — o app fica menor e mais rápido.</span>
        </div>
        <div class="table-wrap"><table class="preview-table">
          <thead>
            <tr>${sheet.columns.map((c, i) => `<th class="${c.keep === false ? 'col-off' : ''}"><label class="th-check"><input type="checkbox" data-keepcol="${i}" ${c.keep === false ? '' : 'checked'}><span>${esc(c.name)}</span></label></th>`).join('')}</tr>
            <tr>${sheet.columns.map((c, i) => `<th class="${c.keep === false ? 'col-off' : ''}"><select data-col="${i}" class="type-${c.type}">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${v}</option>`).join('')}</select></th>`).join('')}</tr>
          </thead>
          <tbody>${sheet.data.slice(0, 8).map(r => `<tr>${sheet.columns.map(c => `<td class="${c.keep === false ? 'col-off' : ''}">${esc(r[c.index] instanceof Date ? r[c.index].toLocaleDateString('pt-BR') : r[c.index])}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
        ${sumBox}
        <div class="row-end"><span class="muted" id="progress"></span><button class="btn" id="btn-save">Criar app</button></div>
      </div>`;

    const out = preview.querySelector('#sum-out');
    const showResult = r => {
      const ok = r.rowCount <= MAX_ROWS;
      out.innerHTML = `${nf.format(r.used)} linhas${r.used < r.read ? ` (de ${nf.format(r.read)}, filtradas pela data)` : ''} → <strong class="${ok ? 'ok-text' : 'error'}">${nf.format(r.rowCount)} linhas resumidas</strong>${ok ? '' : ` — ainda passa de ${nf.format(MAX_ROWS)}: desmarque campos detalhados ou agrupe as datas por mês`}`;
    };
    const calc = () => new Promise(res => {
      out.textContent = 'Resumindo… arquivos grandes levam alguns segundos.';
      setTimeout(() => { try { const r = runSummary(); showResult(r); res(r); } catch (err) { console.error(err); out.innerHTML = '<span class="error">Não foi possível resumir.</span>'; res(null); } }, 30);
    });
    preview.querySelector('#sum-on').addEventListener('change', e => { sumOn = e.target.checked; draw(); });
    preview.querySelectorAll('[data-keep]').forEach(cb => cb.addEventListener('change', () => {
      sumKeep = cb.checked ? [...new Set([...sumKeep, cb.dataset.keep])] : sumKeep.filter(n => n !== cb.dataset.keep);
      cb.closest('.sum-col').classList.toggle('off', !cb.checked); out.textContent = '';
    }));
    preview.querySelectorAll('[data-grain]').forEach(sel => sel.addEventListener('change', () => { sumGrains[sel.dataset.grain] = sel.value; out.textContent = ''; }));
    preview.querySelector('#sum-from')?.addEventListener('change', e => { sumFrom = e.target.value; out.textContent = ''; });
    preview.querySelector('#sum-datecol')?.addEventListener('change', e => { sumDateCol = e.target.value; out.textContent = ''; });
    preview.querySelector('#sum-calc')?.addEventListener('click', calc);
    if (sumResult && sumSig === sumSignature()) showResult(sumResult);

    preview.querySelector('#sheet')?.addEventListener('change', e => { sheet = sheets[+e.target.value]; resetSum(); sumOn = (sheet.total || sheet.data.length) > MAX_ROWS; draw(); });
    const colsChanged = () => { resetSum(); draw(); };
    preview.querySelectorAll('[data-keepcol]').forEach(cb => cb.addEventListener('change', () => { sheet.columns[+cb.dataset.keepcol].keep = cb.checked; colsChanged(); }));
    preview.querySelector('[data-cols="all"]').addEventListener('click', () => { sheet.columns.forEach(c => (c.keep = true)); colsChanged(); });
    preview.querySelector('[data-cols="none"]').addEventListener('click', () => { sheet.columns.forEach(c => (c.keep = false)); colsChanged(); });
    preview.querySelector('[data-cols="popup"]').addEventListener('click', () => chooseColumns(sheet, colsChanged));
    // arquivo com muitas colunas: abre a janela de escolha sozinho na primeira vez
    if (sheet.columns.length > 10 && !askedCols.has(sheet)) { askedCols.add(sheet); setTimeout(() => chooseColumns(sheet, colsChanged), 50); }
    preview.querySelectorAll('[data-col]').forEach(s => s.addEventListener('change', () => {
      sheet.columns[+s.dataset.col].type = s.value;
      s.className = `type-${s.value}`;
      if (sumOn) draw();   // o tipo muda o que é somado e o que agrupa
    }));
    preview.querySelector('#btn-save').addEventListener('click', async e => {
      const btn = e.currentTarget;
      const name = preview.querySelector('#ds-name').value.trim() || baseName;
      if (!active().length) { toast('Selecione pelo menos uma coluna para importar.', 'err'); return; }
      btn.disabled = true;
      const prog = preview.querySelector('#progress');
      prog.textContent = 'Preparando dados…';
      try {
        let table, columns, summary = null;
        if (sumOn) {
          if (!sumKeep.length) throw Object.assign(new Error('Escolha pelo menos um campo para manter.'), { user: true });
          const r = await calc();
          if (!r) throw new Error('resumo');
          if (r.rowCount > MAX_ROWS) throw Object.assign(new Error(`O resumo ainda tem ${nf.format(r.rowCount)} linhas. Desmarque campos detalhados ou agrupe as datas por mês.`), { user: true });
          table = r.table; columns = r.columns;
          summary = { keep: sumKeep, grains: sumGrains, from: sumFrom, dateCol: sumDateCol, sourceRows: r.read };
        } else {
          prog.textContent = 'Lendo o arquivo inteiro…';
          await new Promise(res => setTimeout(res, 30));
          table = ingest(sheet, active(), { limit: MAX_ROWS }).table;
          columns = active().map(({ name, type }) => ({ name, type }));
        }
        const meta = { name, source, columns, rowCount: table.n };
        if (summary) meta.summary = summary;
        meta.dashboard = suggestConfig(meta, table);
        prog.textContent = 'Compactando…';
        const id = await store.saveDataset(meta, table, p => (prog.textContent = `Enviando… ${Math.round(p * 100)}%`));
        rowsCache.set(id, { main: table });
        toast('App criado!');
        location.hash = `#/painel/${encodeURIComponent(id)}`;
      } catch (err) {
        console.error(err);
        prog.textContent = '';
        toast(err.user ? err.message : 'Erro ao salvar. Verifique sua conexão e as regras do Firestore.', 'err');
        btn.disabled = false;
      }
    });
  };
  draw();
}

// ---------------- Painel ----------------
function afterDataChange(id) {
  rowsCache.delete(id);
  scriptCache.delete(id);
  const h = location.hash;
  if (/^#\/(painel|app|dados|script)\//.test(h)) route(); else location.hash = `#/dados/${encodeURIComponent(id)}`;
}

async function loadApp(id) {
  const list = await store.listDatasets();
  const ds = list.find(d => d.id === id);
  if (!ds) return null;
  const data = rowsCache.get(id) || await store.loadAll(id);   // { main: ColTable, <tabela>: ColTable }
  rowsCache.set(id, data);
  return { ds, data };
}

// ---------- script de carga: fontes (tabelas do Gerenciador) -> tabelas do modelo ----------
const scriptCache = new Map();   // id -> { data, script, out }
const sourcesOf = (ds, data) => Object.fromEntries(buildModel(ds, data).tables.map(t => [t.name, t.t]));
const scriptTableId = name => 'sc_' + name.replace(/[^A-Za-z0-9]/g, ch => '_' + ch.charCodeAt(0).toString(36));
// script em uso pelo app = o da última carga (apps antigos só têm "script")
const loadedScriptOf = ds => (ds.loadedScript !== undefined ? ds.loadedScript : ds.script) || '';
// devolve o que o app analisa: as fontes (sem script) ou as tabelas geradas pelo script
function appModel(ds, data) {
  const active = loadedScriptOf(ds);
  if (!active.trim()) return { ds, data, result: null };
  const hit = scriptCache.get(ds.id);
  if (hit && hit.data === data && hit.script === active) return hit.out;
  const result = runScript(active, sourcesOf(ds, data));
  let out;
  if (!result.ok) out = { ds, data, result, error: result.error };
  else out = {
    result,
    ds: { ...ds, columns: [], mainName: undefined, tables: result.tables.map(o => ({ id: scriptTableId(o.name), name: o.name, columns: o.t.columns, rowCount: o.t.n })) },
    data: Object.fromEntries(result.tables.map(o => [scriptTableId(o.name), o.t])),
  };
  scriptCache.set(ds.id, { data, script: active, out });
  return out;
}
const scriptErrorCard = (ds, m) => `
  <div class="card error-card">
    <h2>⚠ O script de carga deste app tem um erro</h2>
    <p class="error">${esc(m.error)}${m.result?.line ? ` (linha ${m.result.line})` : ''}</p>
    ${canEdit() ? `<a class="btn" href="#/script/${encodeURIComponent(ds.id)}">Abrir o Editor de script</a>` : '<p class="muted">Peça para quem edita o app corrigir o script.</p>'}
  </div>`;

// navegação do app: Analisar (pastas) · Preparar (gerenciador de dados, editor de script)
function appNav(view, ds, active) {
  const id = encodeURIComponent(ds.id);
  const link = (key, href, label) => `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  const top = document.querySelector('.topbar');
  top.classList.add('app-top');
  top.querySelector('h1').insertAdjacentHTML('afterend', `
    <nav class="app-nav">
      ${link('analisar', `#/painel/${id}`, '📊 Analisar')}
      ${link('dados', `#/dados/${id}`, '🗄 Gerenciador de dados')}
      ${link('script', `#/script/${id}`, '📝 Editor de script')}
    </nav>`);
}

async function showDashboard(id) {
  const view = shell('home', 'Carregando app…', '<div class="loading">Carregando dados…</div>',
    `<a class="btn ghost small" href="#/" title="Voltar para Meus apps">← Apps</a>${canEdit() ? '<button class="btn ghost small" id="btn-share">🔗 Compartilhar</button>' : ''}`);
  let app;
  try { app = await loadApp(id); }
  catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erro ao carregar o app.</div>`; return; }
  if (!app) { view.innerHTML = `<div class="card error">App não encontrado.</div>`; return; }
  const { ds, data } = app;
  document.querySelector('.topbar h1').textContent = ds.name;
  appNav(view, ds, 'analisar');
  document.getElementById('btn-share')?.addEventListener('click', () => openShare(ds));
  const m = appModel(ds, data);
  if (m.error) { view.innerHTML = scriptErrorCard(ds, m); return; }
  if (buildModel(m.ds, m.data).empty) {
    view.innerHTML = `
      <div class="empty card">
        <div class="empty-icon">🗄</div>
        <h2>Este app ainda não tem dados</h2>
        <p>Adicione planilhas Excel, CSV ou arquivos QVD no Gerenciador de dados. Tabelas com campos de mesmo nome se ligam sozinhas.</p>
        ${canEdit() ? `<a class="btn" href="#/dados/${encodeURIComponent(ds.id)}">Ir para o Gerenciador de dados</a>` : ''}
      </div>`;
    return;
  }
  mountDashboard(view, m.ds, m.data, ds.dashboard, canEdit() ? async cfg => {
    try { await store.updateDashboard(id, cfg); ds.dashboard = cfg; m.ds.dashboard = cfg; toast('App salvo.'); }
    catch (e) { console.error(e); toast('Erro ao salvar o app.', 'err'); throw e; }
  } : null);
}

// ---------------- Gerenciador de dados (tabelas do app + modelo) ----------------
async function showDataManager(id) {
  const view = shell('home', 'Carregando app…', '<div class="loading">Carregando dados…</div>',
    `<a class="btn ghost small" href="#/" title="Voltar para Meus apps">← Apps</a>`);
  let app;
  try { app = await loadApp(id); }
  catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erro ao carregar o app.</div>`; return; }
  if (!app) { view.innerHTML = `<div class="card error">App não encontrado.</div>`; return; }
  const { ds, data } = app;
  document.querySelector('.topbar h1').textContent = ds.name;
  appNav(view, ds, 'dados');
  const model = buildModel(ds, data);
  const sm = appModel(ds, data);
  const finalModel = sm.result && !sm.error ? buildModel(sm.ds, sm.data) : model;
  const linksOf = t => model.keys.filter(k => t.columns.some(c => c.name === k));
  const fmtSize = b => !b ? '' : b > 1e6 ? ` · ${(b / 1e6).toFixed(1).replace('.', ',')} MB` : ` · ${Math.max(1, Math.round(b / 1e3))} KB`;
  const metaOf = t => t.id === 'main' ? ds : (ds.tables || []).find(x => x.id === t.id) || {};

  view.innerHTML = `
    <div class="dm-head">
      <p class="muted">As tabelas do app se ligam pelos <strong>campos com o mesmo nome</strong> (🔑). Adicione quantas quiser: Excel, CSV ou QVD.</p>
      ${canEdit() ? '<button class="btn" id="btn-addtable">+ Adicionar dados</button>' : ''}
    </div>
    ${sm.result ? `<div class="card script-note ${sm.error ? 'bad' : ''}">📝 ${sm.error
      ? `O script de carga está com erro: <strong>${esc(sm.error)}</strong>. <a href="#/script/${encodeURIComponent(ds.id)}">Corrigir no Editor de script</a>`
      : `Este app usa o <a href="#/script/${encodeURIComponent(ds.id)}">Editor de script</a>: as tabelas abaixo são as <strong>fontes</strong>, e o modelo usado no Analisar é o resultado do script (${sm.result.tables.length} tabela(s)).`}</div>` : ''}
    ${model.empty ? `<div class="empty card"><div class="empty-icon">🗄</div><h2>Nenhuma tabela ainda</h2><p>Clique em <strong>+ Adicionar dados</strong> e escolha uma planilha ou QVD.</p></div>` : `
    <div class="dm-grid">${model.tables.map(t => {
      const m = metaOf(t);
      return `
      <article class="card dm-table">
        <div class="dm-title"><span class="ds-icon">${t.id === 'main' ? (ds.source === 'qvd' ? 'QVD' : ds.source === 'csv' ? 'CSV' : 'XLS') : 'TAB'}</span>
          <div><h3>${esc(t.name)}</h3><small class="muted">${nf.format(t.n)} linhas · ${t.columns.length} campos${fmtSize(m.bytes)}${m.summary ? ' · resumida' : ''}</small></div></div>
        <div class="tags">${t.columns.slice(0, 8).map(c => `<span class="tag ${c.type}">${model.keys.includes(c.name) ? '🔑 ' : ''}${esc(c.name)}</span>`).join('')}${t.columns.length > 8 ? `<span class="tag">+${t.columns.length - 8}</span>` : ''}</div>
        <small class="muted">${linksOf(t).length ? 'Liga por ' + linksOf(t).map(esc).join(', ') : '<span class="warn-text">Sem ligação com outras tabelas</span>'}</small>
        ${canEdit() ? `<div class="row-actions">
          <button class="btn ghost small" data-tupd="${t.id}">⟳ Atualizar</button>
          <button class="btn ghost small" data-tren="${t.id}">✎ Renomear</button>
          <button class="btn ghost small danger" data-tdel="${t.id}">🗑 Remover</button>
        </div>` : ''}
      </article>`;
    }).join('')}</div>
    <div class="card">
      <h3>Visualizador do modelo${sm.result && !sm.error ? ' <small class="muted">(resultado do script)</small>' : ''}</h3>
      <div class="model-wrap">${finalModel.empty ? '<p class="muted">O script não gerou tabelas.</p>' : modelSvg(finalModel)}</div>
    </div>`}`;

  view.querySelector('#btn-addtable')?.addEventListener('click', () => openAddTable(ds, data));
  view.querySelectorAll('[data-tupd]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.tupd === 'main') openRefresh(ds);
    else openAddTable(ds, data, (ds.tables || []).find(t => t.id === b.dataset.tupd));
  }));
  view.querySelectorAll('[data-tren]').forEach(b => b.addEventListener('click', async () => {
    const t = model.byId[b.dataset.tren];
    const name = prompt('Novo nome da tabela:', t.name);
    if (!name || !name.trim() || name.trim() === t.name) return;
    try { await store.renameTable(ds.id, t.id, name.trim().slice(0, 40)); toast('Tabela renomeada.'); afterDataChange(ds.id); }
    catch (err) { console.error(err); toast('Não foi possível renomear.', 'err'); }
  }));
  view.querySelectorAll('[data-tdel]').forEach(b => b.addEventListener('click', async () => {
    const t = model.byId[b.dataset.tdel];
    if (!confirm(`Remover a tabela "${t.name}" do app? Gráficos que usam campos dela vão ficar vazios.`)) return;
    try {
      if (t.id === 'main') await store.clearMain(ds.id); else ds.tables = await store.removeTable(ds.id, t.id);
      toast('Tabela removida.'); afterDataChange(ds.id);
    } catch (err) { console.error(err); toast('Não foi possível remover a tabela.', 'err'); }
  }));
}

// ---------------- Editor de script ----------------
const SCRIPT_HELP = `
  <div class="se-help-grid">
    <div><h4>Carregar uma tabela</h4><pre>Vendas:
LOAD Nota, Cliente,
     Valor AS Faturamento,
     Year(Data) AS Ano
FROM [vendas]
WHERE Valor > 0;</pre></div>
    <div><h4>Mapa (de-para)</h4><pre>MapaUF:
MAPPING LOAD Cliente, UF
FROM [clientes];

LOAD *, ApplyMap('MapaUF',
  Cliente, 'Sem UF') AS UF
FROM [vendas];</pre></div>
    <div><h4>Juntar e agrupar</h4><pre>LEFT JOIN (Vendas)
LOAD Cliente, Nome FROM [clientes];

Resumo:
LOAD Cliente, Sum(Valor) AS Total
RESIDENT Vendas
GROUP BY Cliente;</pre></div>
    <div><h4>Outros comandos</h4><pre>CONCATENATE (Vendas) LOAD …;
NOCONCATENATE LOAD …;
LOAD DISTINCT …;
LOAD * INLINE [ Ano, Meta
2026, 1000 ];
DROP TABLE Tmp;
DROP FIELD Campo FROM Vendas;
RENAME FIELD A TO B;
SET vAno = 2026;  … $(vAno)
WHERE NOT Exists(Nota)
// comentário  /* bloco */</pre></div>
  </div>
  <p class="muted small">Datas do Protheus (texto 20260315): <code>Date#(D2_EMISSAO, 'YYYYMMDD') AS Emissao</code>. Campos com espaço ou acento vão entre colchetes: <code>[Valor Total]</code>. Textos entre aspas simples: <code>'SC'</code>.</p>`;

async function showScriptEditor(id) {
  const view = shell('home', 'Carregando app…', '<div class="loading">Carregando dados…</div>',
    `<a class="btn ghost small" href="#/" title="Voltar para Meus apps">← Apps</a>`);
  let app;
  try { app = await loadApp(id); }
  catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erro ao carregar o app.</div>`; return; }
  if (!app) { view.innerHTML = `<div class="card error">App não encontrado.</div>`; return; }
  const { ds, data } = app;
  document.querySelector('.topbar h1').textContent = ds.name;
  appNav(view, ds, 'script');
  const edit = canEdit();
  const srcModel = buildModel(ds, data);
  const sources = srcModel.tables;
  const draftKey = 'nbi-script-draft:' + ds.id;
  let draft = null;
  try { draft = localStorage.getItem(draftKey); } catch {}
  let saved = ds.script || '';                 // texto salvo
  let loaded = loadedScriptOf(ds);             // texto da última carga (o que o app usa)
  const initial = draft !== null && draft !== saved ? draft : saved;
  const qn = s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `[${s}]`;

  view.innerHTML = `
    <div class="se">
      <aside class="se-side card">
        <h4>Fontes do app</h4>
        ${sources.length ? sources.map((t, k) => `
          <details class="se-src" ${k === 0 ? 'open' : ''}>
            <summary><strong>${esc(t.name)}</strong> <small class="muted">${nf.format(t.n)} linhas</small></summary>
            ${edit ? `<button class="btn ghost small" data-insload="${k}">+ Inserir LOAD</button>` : ''}
            <div class="se-fields">${t.columns.map(c => `<button type="button" class="se-field ${c.type}" data-insfield="${esc(qn(c.name))}" title="${c.type}">${esc(c.name)}</button>`).join('')}</div>
          </details>`).join('') : `<p class="muted small">Nenhuma fonte ainda. Adicione tabelas no <a href="#/dados/${encodeURIComponent(ds.id)}">Gerenciador de dados</a>.</p>`}
        <h4>Funções</h4>
        <div class="se-fields">${FUNCTION_NAMES.map(f => { const h = FUNCTION_HELP[f]; return `<button type="button" class="se-fn" data-insfn="${f}" ${h ? `title="${esc(h[0] + '\n' + h[1] + '\nEx.: ' + h[2])}"` : ''}>${f}</button>`; }).join('')}</div>
        <div class="se-fnhelp" id="se-fnhelp"><span class="muted small">Passe o mouse numa função para ver o que ela faz. Clique para inserir.</span></div>
      </aside>
      <section class="se-main">
        <div class="se-bar">
          ${edit ? '<button class="btn" id="se-run" title="Salva e carrega os dados (Ctrl+Enter)">▶ Carregar dados</button>' : ''}
          ${edit ? '<button class="btn ghost" id="se-save" title="Salva o script sem carregar os dados (Ctrl+S)">💾 Salvar</button>' : ''}
          ${edit ? `<button class="btn ghost" id="se-gen">✨ Gerar script das fontes</button>` : ''}
          <button class="btn ghost" id="se-dbgbtn" title="Testar o script com poucas linhas, sem salvar">🐞 Depurar</button>
          <button class="btn ghost" id="se-helpbtn">? Ajuda</button>
          ${edit && loaded ? '<button class="btn ghost danger" id="se-off">Desativar script</button>' : ''}
          <span class="small" id="se-status"></span>
        </div>
        <div class="se-help card" id="se-help" hidden>${SCRIPT_HELP}</div>
        <div class="se-debug card" id="se-debug" hidden>
          <strong>🐞 Depuração</strong>
          <label>Linhas de cada fonte
            <select id="dbg-limit"><option value="10">10</option><option value="100" selected>100</option><option value="1000">1.000</option><option value="10000">10.000</option><option value="0">Todas</option></select></label>
          <label class="check-inline"><input type="checkbox" id="dbg-stop"> Parar na linha do cursor <span class="muted small" id="dbg-line"></span></label>
          <button class="btn small" id="dbg-run" title="Ctrl+Shift+Enter">▶ Executar depuração</button>
          <span class="muted small">Não salva nada: o app continua com a última carga.</span>
        </div>
        <div class="se-editor">
          <pre class="se-gutter" id="se-gutter" aria-hidden="true"></pre>
          <div class="se-code">
            <pre class="se-hl" id="se-hl" aria-hidden="true"></pre>
            <textarea id="se-text" spellcheck="false" autocomplete="off" autocapitalize="off" ${edit ? '' : 'readonly'} placeholder="${edit ? 'Escreva o script de carga aqui ou clique em ✨ Gerar script das fontes.' : 'Este app não tem script.'}">${esc(initial)}</textarea>
          </div>
        </div>
        <div class="se-log card" id="se-log"><p class="muted small">O resultado da carga aparece aqui: tabelas, linhas, campos e erros com o número da linha.</p></div>
      </section>
    </div>`;

  const ta = view.querySelector('#se-text'), gutter = view.querySelector('#se-gutter'), status = view.querySelector('#se-status'), logEl = view.querySelector('#se-log');
  let errLine = 0;
  // situação do script: carregado / salvo sem carregar / alterações não salvas
  const paintStatus = () => {
    const t = ta.value;
    const [cls, txt] = t !== saved
      ? ['warn', draft !== null && t === draft && t !== saved ? '✎ Rascunho recuperado deste navegador — não salvo' : '✎ Alterações não salvas']
      : !t.trim() && !loaded ? ['muted', 'Sem script: o app usa as fontes como estão']
      : t === loaded ? ['ok', '✓ Salvo e carregado']
      : ['info', loaded ? '💾 Salvo — ainda não carregado (o app usa a última carga)' : '💾 Salvo — ainda não carregado (o app usa as fontes)'];
    status.className = 'small se-st ' + cls;
    status.textContent = txt;
  };
  const paintGutter = () => {
    const n = ta.value.split('\n').length;
    let out = '';
    for (let i = 1; i <= n; i++) out += (i === errLine ? `<b>${i}</b>` : i) + '\n';
    gutter.innerHTML = out;
    gutter.scrollTop = ta.scrollTop;
    hl.innerHTML = highlightScript(ta.value);
    hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
  };
  const hl = view.querySelector('#se-hl');
  paintGutter();
  paintStatus();
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; });
  ta.addEventListener('input', () => {
    errLine = 0; paintGutter();
    try { localStorage.setItem(draftKey, ta.value); } catch {}
    paintStatus();
  });
  const insert = text => {
    if (!edit) return;
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.setRangeText(text, a, b, 'end');
    ta.focus(); ta.dispatchEvent(new Event('input'));
  };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); insert('    '); }
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveOnly(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) { e.preventDefault(); view.querySelector('#se-debug').hidden = false; debugRun(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  });
  view.querySelectorAll('[data-insfield]').forEach(b => b.addEventListener('click', () => insert(b.dataset.insfield)));
  view.querySelectorAll('[data-insfn]').forEach(b => b.addEventListener('click', () => insert(b.dataset.insfn + '(')));
  // explicação da função no quadro abaixo da lista
  const fnBox = view.querySelector('#se-fnhelp');
  const showFn = f => { const h = FUNCTION_HELP[f]; if (!h) return; fnBox.innerHTML = `<code class="sig">${esc(h[0])}</code><p>${esc(h[1])}</p><code class="ex">${esc(h[2])}</code>`; };
  view.querySelectorAll('[data-insfn]').forEach(b => { b.addEventListener('mouseenter', () => showFn(b.dataset.insfn)); b.addEventListener('focus', () => showFn(b.dataset.insfn)); });
  view.querySelectorAll('[data-insload]').forEach(b => b.addEventListener('click', () => {
    const t = sources[+b.dataset.insload];
    const pre = ta.value && !ta.value.endsWith('\n\n') ? (ta.value.endsWith('\n') ? '\n' : '\n\n') : '';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    insert(pre + defaultScript([{ name: t.name, columns: t.columns }]).split('\n').filter(l => !l.startsWith('//')).join('\n').replace(/^\n+/, ''));
  }));
  view.querySelector('#se-helpbtn').addEventListener('click', () => { const h = view.querySelector('#se-help'); h.hidden = !h.hidden; });
  view.querySelector('#se-dbgbtn').addEventListener('click', () => { const d = view.querySelector('#se-debug'); d.hidden = !d.hidden; if (!d.hidden) showCursorLine(); });
  const cursorLine = () => ta.value.slice(0, ta.selectionStart).split('\n').length;
  const showCursorLine = () => { view.querySelector('#dbg-line').textContent = `(linha ${cursorLine()})`; };
  ['keyup', 'click'].forEach(ev => ta.addEventListener(ev, showCursorLine));
  // depuração: roda com poucas linhas e mostra uma amostra de cada tabela, sem salvar
  function debugRun() {
    const limit = +view.querySelector('#dbg-limit').value;
    const stopLine = view.querySelector('#dbg-stop').checked ? cursorLine() : 0;
    const res = runScript(ta.value, sourcesOf(ds, data), { limit, stopLine });
    showLog(res, res.tables.length ? previewHtml(res.tables) : '');
    bindPreview();
    if (!res.ok && res.line) goLine(res.line);
    status.textContent = res.ok ? '🐞 Depuração concluída (nada foi salvo)' : '✖ Erro na depuração';
  }
  const fmtCell = (v, type) => v === null || v === undefined ? '<span class="null">—</span>' : type === 'number' ? (Number.isInteger(v) ? String(v) : v.toLocaleString('pt-BR', { maximumFractionDigits: 6 })) : esc(String(v));
  const previewHtml = tables => `
    <div class="dbg-preview">
      <div class="dbg-tabs">${tables.map((o, k) => `<button type="button" class="${k === 0 ? 'active' : ''}" data-dbgt="${k}">${esc(o.name)} <small>${nf.format(o.t.n)}</small></button>`).join('')}</div>
      ${tables.map((o, k) => `
        <div class="dbg-table table-wrap" data-dbgp="${k}" ${k ? 'hidden' : ''}>
          <table><thead><tr>${o.t.columns.map(c => `<th title="${c.type}">${esc(c.name)}<small>${c.type === 'number' ? 'número' : c.type === 'date' ? 'data' : 'texto'}</small></th>`).join('')}</tr></thead>
          <tbody>${Array.from({ length: Math.min(o.t.n, 50) }, (_, i) => `<tr>${o.t.columns.map(c => `<td class="${c.type}">${fmtCell(o.t.get(c.name, i), c.type)}</td>`).join('')}</tr>`).join('')}</tbody></table>
          ${o.t.n > 50 ? `<p class="muted small">Mostrando 50 de ${nf.format(o.t.n)} linhas.</p>` : ''}
        </div>`).join('')}
    </div>`;
  const bindPreview = () => logEl.querySelectorAll('[data-dbgt]').forEach(b => b.addEventListener('click', () => {
    logEl.querySelectorAll('[data-dbgt]').forEach(x => x.classList.toggle('active', x === b));
    logEl.querySelectorAll('[data-dbgp]').forEach(p => { p.hidden = p.dataset.dbgp !== b.dataset.dbgt; });
  }));
  view.querySelector('#dbg-run').addEventListener('click', debugRun);
  view.querySelector('#se-gen')?.addEventListener('click', () => {
    if (!sources.length) { toast('Adicione tabelas no Gerenciador de dados primeiro.', 'err'); return; }
    if (ta.value.trim() && !confirm('Substituir o script atual por um script novo, gerado a partir das fontes?')) return;
    ta.value = defaultScript(sources.map(t => ({ name: t.name, columns: t.columns })));
    ta.dispatchEvent(new Event('input'));
  });
  view.querySelector('#se-off')?.addEventListener('click', async () => {
    if (!confirm('Desativar o script? O app volta a usar as fontes do Gerenciador como estão. O texto do script continua salvo aqui para você carregar de novo quando quiser.')) return;
    try {
      await store.saveScript(ds.id, { script: ta.value, loadedScript: '' });
      ds.script = ta.value; ds.loadedScript = ''; scriptCache.delete(ds.id);
      try { localStorage.removeItem(draftKey); } catch {}
      toast('Script desativado.'); showScriptEditor(ds.id);
    } catch (e) { console.error(e); toast('Não foi possível salvar.', 'err'); }
  });

  const icon = { table: '▦', map: '⇄', trace: '›', info: 'ℹ', warn: '⚠', error: '✖', done: '✓' };
  const showLog = (res, extra = '') => {
    logEl.innerHTML = `
      <ul class="se-lines">${res.log.map(l => `<li class="se-${l.kind}">${icon[l.kind] || '·'} ${l.kind === 'error' && l.line ? `<a href="#" data-goline="${l.line}">` : ''}${esc(l.text)}${l.kind === 'error' && l.line ? '</a>' : ''}</li>`).join('')}</ul>
      ${res.ok && res.tables.length ? `<div class="se-out">${res.tables.map(o => `<div class="se-outt"><strong>${esc(o.name)}</strong> <small class="muted">${nf.format(o.t.n)} linhas</small><div class="tags">${o.t.columns.slice(0, 12).map(c => `<span class="tag ${c.type}">${res.tables.some(x => x !== o && x.t.has(c.name)) ? '🔑 ' : ''}${esc(c.name)}</span>`).join('')}${o.t.columns.length > 12 ? `<span class="tag">+${o.t.columns.length - 12}</span>` : ''}</div></div>`).join('')}</div>` : ''}
      ${extra}`;
    logEl.querySelectorAll('[data-goline]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); goLine(+a.dataset.goline); }));
  };
  const goLine = line => {
    const lines = ta.value.split('\n');
    const start = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(start, start + (lines[line - 1] || '').length);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (line - 4) * lh);
    errLine = line; paintGutter();
  };

  async function run() {
    if (!edit) return;
    const btn = view.querySelector('#se-run');
    const text = ta.value;
    btn.disabled = true; btn.textContent = '⏳ Carregando…';
    logEl.innerHTML = '<p class="muted">Executando o script…</p>';
    await new Promise(r => setTimeout(r, 30));
    try {
      if (!text.trim()) {
        await store.saveScript(ds.id, { script: '', loadedScript: '' });
        ds.script = ''; ds.loadedScript = ''; saved = ''; loaded = ''; scriptCache.delete(ds.id);
        try { localStorage.removeItem(draftKey); } catch {}
        logEl.innerHTML = '<p class="muted">Script vazio: o app usa as fontes do Gerenciador como estão.</p>';
        paintStatus();
        return;
      }
      const res = runScript(text, sourcesOf(ds, data));
      if (!res.ok) {
        showLog(res, '<p class="error small">Nada foi alterado no app. Corrija o erro e carregue de novo.</p>');
        if (res.line) goLine(res.line);
        status.textContent = '✖ Erro na carga';
        return;
      }
      if (!res.tables.length) { showLog(res, '<p class="error small">O script não gerou nenhuma tabela; nada foi alterado.</p>'); return; }
      await store.saveScript(ds.id, { script: text, loadedScript: text });
      ds.script = text; ds.loadedScript = text; saved = text; loaded = text;
      scriptCache.delete(ds.id);
      try { localStorage.removeItem(draftKey); } catch {}
      paintStatus();
      showLog(res, `<div class="row-actions"><a class="btn" href="#/painel/${encodeURIComponent(ds.id)}">📊 Ir para Analisar</a><a class="btn ghost" href="#/dados/${encodeURIComponent(ds.id)}">Ver o modelo</a></div>`);
      toast('Dados carregados.');
    } catch (e) {
      console.error(e); toast('Não foi possível salvar o script.', 'err');
    } finally {
      btn.disabled = false; btn.textContent = '▶ Carregar dados';
    }
  }
  view.querySelector('#se-run')?.addEventListener('click', run);
  // salvar sem carregar: o app continua usando o script da última carga
  async function saveOnly() {
    if (!edit) return;
    const btn = view.querySelector('#se-save');
    const text = ta.value;
    if (text === saved) { toast('Nada novo para salvar.'); return; }
    btn.disabled = true;
    try {
      await store.saveScript(ds.id, { script: text, loadedScript: loaded });   // loadedScript fica igual
      ds.script = text; ds.loadedScript = loaded; saved = text;
      try { localStorage.removeItem(draftKey); } catch {}
      paintStatus();
      toast(text === loaded ? 'Script salvo.' : 'Script salvo. Os dados do app só mudam quando você clicar em ▶ Carregar dados.');
    } catch (e) { console.error(e); toast('Não foi possível salvar o script.', 'err'); }
    finally { btn.disabled = false; }
  }
  view.querySelector('#se-save')?.addEventListener('click', saveOnly);
  // mostra o resultado do script já carregado
  if (loaded && initial === loaded) { const m = appModel(ds, data); if (m.result) { showLog(m.result); if (m.error && m.result.line) { errLine = m.result.line; paintGutter(); } } }
}

// ---------------- Compartilhar por link ----------------
function shareUrl(t) { return `${location.origin}${location.pathname}#/p/${t}`; }

function openShare(ds) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const paint = () => {
    back.innerHTML = `
      <div class="modal card">
        <header><h2>Compartilhar "${esc(ds.name)}"</h2><button class="x" data-close>×</button></header>
        <div class="modal-body">
          ${ds.shareId ? `
            <p><span class="badge ok">🔗 Link ativo</span> Qualquer pessoa com o link vê o app e usa os filtros, <strong>sem precisar de conta</strong>. Ninguém consegue editar.</p>
            <div class="copy-row"><input id="share-url" readonly value="${esc(shareUrl(ds.shareId))}"><button class="btn" id="btn-copy">Copiar</button></div>
            <div class="row-actions">
              <a class="btn ghost small" href="${esc(shareUrl(ds.shareId))}" target="_blank" rel="noopener">Abrir em nova aba</a>
              <button class="btn ghost small danger" id="btn-revoke">Desativar link</button>
            </div>
            <p class="muted small">Ao desativar, o link para de funcionar na hora. Um link novo gerado depois será diferente.</p>`
          : `
            <p>Crie um link para mostrar este app a alguém de fora da empresa (sócio, cliente, uma TV na recepção). Quem abrir só visualiza e filtra.</p>
            <button class="btn" id="btn-create">Criar link de visualização</button>
            <p class="muted small">Para dar acesso com login e poder de edição, convide a pessoa em <a href="#/equipe" data-close>Equipe</a>.</p>`}
        </div>
      </div>`;
    back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => back.remove()));
    back.querySelector('#btn-create')?.addEventListener('click', async e => {
      e.target.disabled = true;
      try { ds.shareId = await store.createShare(ds); toast('Link criado.'); paint(); }
      catch (err) { console.error(err); toast('Não foi possível criar o link.', 'err'); e.target.disabled = false; }
    });
    back.querySelector('#btn-copy')?.addEventListener('click', async () => {
      const inp = back.querySelector('#share-url');
      try { await navigator.clipboard.writeText(inp.value); } catch { inp.select(); document.execCommand('copy'); }
      toast('Link copiado.');
    });
    back.querySelector('#btn-revoke')?.addEventListener('click', async e => {
      if (!confirm('Desativar o link? Quem tiver o link não vai mais conseguir abrir o app.')) return;
      e.target.disabled = true;
      try { await store.revokeShare(ds); delete ds.shareId; toast('Link desativado.'); paint(); }
      catch (err) { console.error(err); toast('Não foi possível desativar.', 'err'); e.target.disabled = false; }
    });
  };
  paint();
  back.addEventListener('mousedown', e => { if (e.target === back) back.remove(); });
  document.body.append(back);
}

// painel aberto pelo link público (sem login, só leitura)
async function showPublic(t) {
  $app.innerHTML = '<div class="loading">Carregando app…</div>';
  let data = null;
  try { data = await store.loadShared(t); } catch (e) { console.error(e); }
  if (!data) {
    $app.innerHTML = `<div class="center-page"><div class="card invite-page">
      <div class="brand"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> ${APP_NAME}</div>
      <h2>Link indisponível</h2><p class="muted">Este app não existe mais ou o link foi desativado por quem compartilhou.</p>
      <a class="btn" href="${location.pathname}">Conhecer o ${APP_NAME}</a></div></div>`;
    return;
  }
  $app.innerHTML = `
    <div class="public-page">
      <header class="public-top">
        <div class="brand dark"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> ${APP_NAME}</div>
        <h1>${esc(data.ds.name)}</h1>
        <span class="badge">Somente visualização</span>
        <a class="btn small" href="${location.pathname}" target="_blank" rel="noopener">Criar meu app grátis</a>
      </header>
      <main class="main" id="view"></main>
    </div>`;
  const pm = appModel(data.ds, data.data);
  if (pm.error) { document.getElementById('view').innerHTML = '<div class="card error">Este app está com um erro no script de carga. Avise quem compartilhou.</div>'; return; }
  mountDashboard(document.getElementById('view'), pm.ds, pm.data, data.ds.dashboard, null);
}

// ---------------- Equipe ----------------
async function showTeam() {
  const view = shell('team', 'Equipe', '<div class="loading">Carregando…</div>');
  let members = [], invites = [];
  try {
    members = await store.listMembers();
    if (isAdmin()) invites = await store.listInvites();
  } catch (e) { console.error(e); view.innerHTML = '<div class="card error">Erro ao carregar a equipe.</div>'; return; }
  members.sort((a, b) => (a.role === 'admin' ? -1 : 0) - (b.role === 'admin' ? -1 : 0) || a.email.localeCompare(b.email));
  const roleSel = (cur, attrs) => `<select ${attrs}>${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  const admins = members.filter(m => m.role === 'admin').length;

  view.innerHTML = `
    ${isAdmin() ? `
    <div class="card">
      <h3>Nome da empresa</h3>
      <form id="org-form" class="inline-form"><input name="name" value="${esc(store.org.name)}" required maxlength="80"><button class="btn ghost">Salvar nome</button></form>
    </div>
    <div class="card">
      <h3>Convidar pessoa</h3>
      <form id="invite-form" class="inline-form">
        <input type="email" name="email" placeholder="email@empresa.com.br" required>
        ${roleSel('viewer', 'name="role"')}
        <button class="btn">Convidar</button>
      </form>
      <p class="muted small">A pessoa entra no site com <strong>esse mesmo e-mail</strong> (criando a conta, se ainda não tiver) e aceita o convite na tela inicial. Nenhum e-mail é enviado automaticamente — use "Copiar convite" para mandar pelo WhatsApp ou e-mail.</p>
      <div class="roles-help">
        <div><strong>Administrador</strong><span>tudo, inclusive equipe e nome da empresa</span></div>
        <div><strong>Editor</strong><span>importa planilhas, edita, exclui e compartilha apps</span></div>
        <div><strong>Visualizador</strong><span>só vê e filtra os apps</span></div>
      </div>
    </div>` : ''}
    <div class="card">
      <h3>Membros (${members.length})</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>E-mail</th><th>Papel</th><th>Desde</th><th></th></tr></thead>
        <tbody>${members.map(m => {
          const isMe = m.uid === user.uid;
          const lastAdmin = m.role === 'admin' && admins <= 1;
          return `<tr>
            <td>${esc(m.email)}${isMe ? ' <span class="tag">você</span>' : ''}</td>
            <td>${isAdmin() && !lastAdmin ? roleSel(m.role, `data-role="${esc(m.uid)}"`) : esc(ROLES[m.role] || m.role)}</td>
            <td>${m.addedAt ? new Date(m.addedAt).toLocaleDateString('pt-BR') : ''}</td>
            <td class="number">${isMe
              ? (!lastAdmin ? `<button class="btn ghost small danger" data-leave>Sair da empresa</button>` : '')
              : (isAdmin() ? `<button class="btn ghost small danger" data-remove="${esc(m.uid)}" data-email="${esc(m.email)}">Remover</button>` : '')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      ${admins <= 1 && isAdmin() ? '<p class="muted small">A empresa precisa de pelo menos um administrador. Para deixar de ser admin, promova outra pessoa primeiro.</p>' : ''}
    </div>
    ${isAdmin() && invites.length ? `
    <div class="card">
      <h3>Convites pendentes (${invites.length})</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>E-mail</th><th>Papel</th><th>Enviado</th><th></th></tr></thead>
        <tbody>${invites.map(i => `<tr>
          <td>${esc(i.email)}</td><td>${esc(ROLES[i.role] || i.role)}</td>
          <td>${new Date(i.createdAt).toLocaleDateString('pt-BR')}</td>
          <td class="number"><button class="btn ghost small" data-copy="${esc(i.email)}" data-role-label="${esc(ROLES[i.role])}">Copiar convite</button>
            <button class="btn ghost small danger" data-cancel="${esc(i.id)}">Cancelar</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}`;

  const reload = () => showTeam();
  view.querySelector('#org-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    try {
      await store.renameOrg(name);
      workspace.orgs = workspace.orgs.map(o => o.id === store.org.id ? { ...o, name } : o);
      toast('Nome atualizado.'); reload();
    } catch (err) { console.error(err); toast('Não foi possível renomear.', 'err'); }
  });
  view.querySelector('#invite-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = e.target.email.value.trim().toLowerCase();
    if (members.some(m => m.email === email)) { toast('Essa pessoa já faz parte da empresa.', 'err'); return; }
    try { await store.invite(email, e.target.role.value); toast('Convite criado. Avise a pessoa!'); reload(); }
    catch (err) { console.error(err); toast('Não foi possível convidar.', 'err'); }
  });
  view.querySelectorAll('[data-role]').forEach(s => s.addEventListener('change', async () => {
    try { await store.setRole(s.dataset.role, s.value); toast('Papel atualizado.'); reload(); }
    catch (err) { console.error(err); toast('Não foi possível mudar o papel.', 'err'); reload(); }
  }));
  view.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Remover ${b.dataset.email} da empresa? A pessoa perde o acesso aos apps.`)) return;
    try { await store.removeMember(b.dataset.remove); toast('Pessoa removida.'); reload(); }
    catch (err) { console.error(err); toast('Não foi possível remover.', 'err'); }
  }));
  view.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
    try { await store.cancelInvite(b.dataset.cancel); toast('Convite cancelado.'); reload(); }
    catch (err) { console.error(err); toast('Não foi possível cancelar.', 'err'); }
  }));
  view.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    const msg = `Olá! Você foi convidado(a) para a empresa "${store.org.name}" no ${APP_NAME} como ${b.dataset.roleLabel}.\n`
      + `1. Acesse ${location.origin}${location.pathname}\n2. Entre ou crie sua conta com o e-mail ${b.dataset.copy}\n3. Clique em "Aceitar" no convite.`;
    try { await navigator.clipboard.writeText(msg); toast('Mensagem de convite copiada.'); }
    catch { prompt('Copie a mensagem:', msg); }
  }));
  view.querySelector('[data-leave]')?.addEventListener('click', async () => {
    if (!confirm(`Sair da empresa "${store.org.name}"? Você perde o acesso aos apps dela.`)) return;
    try {
      await store.leaveOrg(store.org.id);
      toast('Você saiu da empresa.');
      if (await bootWorkspace()) { location.hash = '#/'; route(); }
    } catch (err) { console.error(err); toast('Não foi possível sair.', 'err'); }
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
      ${card('QVD', 'Arquivos QVD', 'Ativo', 'ok', 'Envie arquivos .qvd direto, sem converter. Números, datas e códigos com zero à esquerda vêm com o tipo certo, sem precisar exportar para Excel.')}
      ${card('TOTVS', 'Protheus (SQL Server)', 'Fase 2', 'warn', 'Um agente instalado no servidor da empresa lê as tabelas (SD2, SF2, SB1, SB2…) e envia os dados para a nuvem em horários agendados.')}
      ${card('SAP', 'SAP ECC / S/4HANA', 'Fase 3', 'muted', 'Integração via OData ou extração por agente local, com o mesmo modelo de envio agendado.')}
      ${card('G', 'Google Planilhas', 'Fase 2', 'warn', 'Conexão direta com uma planilha do Google, atualizando o app automaticamente.')}
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
