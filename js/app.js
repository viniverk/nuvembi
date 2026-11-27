// =============================================================
//  NuvemBI — aplicação principal (telas e navegação)
// =============================================================
import { firebaseConfig, APP_NAME, MAX_ROWS } from './firebase-config.js?v=14';
import { createStore, ROLES } from './store.js?v=14';
import { readFile, normalizeRows } from './parser.js?v=14';
import { mountDashboard, suggestConfig } from './dashboard.js?v=14';
import { buildModel } from './model.js?v=14';
import { summarize, SUM_GRAINS, COUNT_FIELD } from './summarize.js?v=14';

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('pt-BR');
const TYPE_LABEL = { text: 'Texto', number: 'Número', date: 'Data' };

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
      if (n) toast(`${n} painel(is) trazido(s) para a empresa.`);
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
      <div class="brand big"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> ${APP_NAME}</div>
      <h1>Seus dados do ERP e do Excel em painéis prontos, na nuvem.</h1>
      <ul class="bullets">
        <li>Importe planilhas Excel e CSV em segundos</li>
        <li>Painéis gerados automaticamente, com filtros</li>
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
  const item = (hash, label, key) => `<a href="#/${hash}" class="${active === key ? 'active' : ''}">${label}</a>`;
  $app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> ${APP_NAME}</div>
      <div class="org-box">
        <small>Empresa</small>
        ${workspace.orgs.length > 1
          ? `<select id="org-switch">${workspace.orgs.map(o => `<option value="${esc(o.id)}" ${o.id === store.org.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`
          : `<strong title="${esc(store.org.name)}">${esc(store.org.name)}</strong>`}
        <span class="role-badge ${role()}">${esc(ROLES[role()])}</span>
      </div>
      <nav>
        ${item('', '▦ Meus painéis', 'home')}
        ${canEdit() ? item('importar', '⇪ Importar dados', 'upload') : ''}
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
  document.getElementById('org-switch')?.addEventListener('change', async e => {
    rowsCache.clear();
    if (await bootWorkspace(e.target.value)) { location.hash = '#/'; route(); }
  });
  return document.getElementById('view');
}

// ---------------- Home ----------------
async function showHome() {
  const view = shell('home', 'Meus painéis', '<div class="loading">Carregando…</div>',
    canEdit() ? `<a class="btn" href="#/importar">+ Novo painel</a>` : '');
  let list = [];
  try { list = await store.listDatasets(); }
  catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erro ao carregar seus dados.</div>`; return; }

  const invitesBanner = workspace.invites.length ? `
    <div class="card invites-banner"><h3>Convites pendentes</h3>${inviteListHtml(workspace.invites)}</div>` : '';
  if (!list.length) {
    view.innerHTML = `${invitesBanner}
      <div class="empty card">
        <div class="empty-icon">▦</div>
        <h2>${canEdit() ? 'Você ainda não tem painéis' : 'Nenhum painel ainda'}</h2>
        <p>${canEdit() ? `Importe uma planilha de vendas, estoque ou compras e o ${APP_NAME} monta o painel para você.` : 'Quando alguém da sua empresa criar um painel, ele aparece aqui.'}</p>
        ${canEdit() ? '<a class="btn" href="#/importar">Importar minha primeira planilha</a>' : ''}
      </div>`;
    bindInviteButtons(view);
    return;
  }
  view.innerHTML = `${invitesBanner}<div class="grid">${list.map(d => `
    <article class="ds card">
      <div class="ds-head"><span class="ds-icon">${d.source === 'csv' ? 'CSV' : d.source === 'qvd' ? 'QVD' : 'XLS'}</span>
        <div><h3>${esc(d.name)}</h3><small>${new Date(d.createdAt).toLocaleDateString('pt-BR')}${d.createdBy ? ` · ${esc(d.createdBy)}` : ''}</small></div>
        ${d.shareId ? '<span class="badge ok shared-badge" title="Tem link público ativo">🔗 Link ativo</span>' : ''}</div>
      <p class="muted">${nf.format(d.rowCount)} linhas · ${d.columns.length} colunas${d.tables?.length ? ` · ${d.tables.length + 1} tabelas` : ''}${d.updatedAt ? ` · atualizado em ${new Date(d.updatedAt).toLocaleDateString('pt-BR')}` : ''}</p>
      <div class="tags">${d.columns.slice(0, 5).map(c => `<span class="tag ${c.type}">${esc(c.name)}</span>`).join('')}${d.columns.length > 5 ? `<span class="tag">+${d.columns.length - 5}</span>` : ''}</div>
      <div class="ds-actions">
        <a class="btn small" href="#/painel/${encodeURIComponent(d.id)}">Abrir painel</a>
        ${canEdit() ? `<button class="btn ghost small" data-refresh="${esc(d.id)}">⟳ Atualizar</button>` : ''}
        ${canEdit() ? `<button class="btn ghost small danger" data-del="${esc(d.id)}" data-name="${esc(d.name)}">Excluir</button>` : ''}
      </div>
    </article>`).join('')}</div>`;

  view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Excluir o painel "${b.dataset.name}" e todos os seus dados? Isso não pode ser desfeito.`)) return;
    b.disabled = true;
    try { await store.deleteDataset(b.dataset.del); rowsCache.delete(b.dataset.del); toast('Painel excluído.'); showHome(); }
    catch (e) { console.error(e); toast('Erro ao excluir.', 'err'); b.disabled = false; }
  }));
  bindInviteButtons(view);
  view.querySelectorAll('[data-refresh]').forEach(b => b.addEventListener('click', () => openRefresh(list.find(d => d.id === b.dataset.refresh))));
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
      <footer><button class="btn ghost" data-close>Cancelar</button><button class="btn" id="rgo" disabled>Atualizar painel</button></footer>
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
    const total = append ? ds.rowCount + sheet.data.length : sheet.data.length;
    summary.innerHTML = `
      ${sheets.length > 1 ? `<label class="field"><span>Aba</span><select id="rsheet">${sheets.map((s, i) => `<option value="${i}" ${s === sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
      <div class="refresh-summary">
        <div><strong>${nf.format(sheet.total || sheet.data.length)}</strong> linhas no arquivo → ${ds.summary ? 'serão resumidas como na importação' : `o painel fica com <strong>${nf.format(Math.min(total, MAX_ROWS))}</strong> linhas`}
          ${append ? `<span class="muted">(${nf.format(ds.rowCount)} atuais + ${nf.format(sheet.data.length)} novas)</span>` : ''}</div>
        <div class="ok-text">✓ ${same.length} coluna(s) iguais às do painel</div>
        ${extra.length ? (ds.summary ? `<div class="muted">Ignoradas no resumo: ${extra.map(c => esc(c.name)).join(', ')}</div>` : `<div>+ ${extra.length} coluna(s) nova(s): ${extra.map(c => esc(c.name)).join(', ')}</div>`) : ''}
        ${missing.length ? `<div class="warn-text">⚠ Não encontradas na planilha: ${missing.map(c => esc(c.name)).join(', ')}.${append ? ' As linhas novas ficam sem esses valores.' : ' Gráficos e filtros que usam essas colunas vão ficar vazios.'}</div>` : ''}
        ${!same.length ? '<div class="error">Nenhuma coluna bate com o painel — parece ser outra planilha.</div>' : ''}
        ${ds.summary ? `<div class="ok-text">Σ Este painel é resumido: o arquivo novo será resumido do mesmo jeito (${ds.summary.keep.length} campos${Object.values(ds.summary.grains || {}).includes('month') ? ', datas por mês' : ''}${ds.summary.from ? `, a partir de ${new Date(ds.summary.from + 'T12:00').toLocaleDateString('pt-BR')}` : ''}).</div>`
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
    try { sheets = await readFile(file, { maxRows: MAX_ROWS + 1 }); }
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
      let rows, columns;
      if (ds.summary) {
        const keep = ds.summary.keep.filter(n => mapped.some(c => c.name === n));
        const r = summarize(sheet, mapped, { ...ds.summary, keep });
        rows = r.rows; columns = r.columns;
      } else {
        rows = normalizeRows(mapped, sheet.data);
        columns = mapped.map(({ name, type }) => ({ name, type }));
      }
      if (append) {
        const old = rowsCache.get(ds.id)?.main || await store.loadRows(ds.id);
        rows = old.concat(rows);
        columns = [...ds.columns, ...columns.filter(c => !ds.columns.some(o => o.name === c.name))];
      }
      rows = rows.slice(0, MAX_ROWS);
      await store.replaceData(ds.id, { columns, rowCount: rows.length }, rows, p => (go.textContent = `Enviando… ${Math.round(p * 100)}%`));
      rowsCache.delete(ds.id);
      close();
      toast(`Dados atualizados: ${nf.format(rows.length)} linhas.`);
      if (location.hash === `#/painel/${encodeURIComponent(ds.id)}`) showDashboard(ds.id); else location.hash = `#/painel/${encodeURIComponent(ds.id)}`;
    } catch (err) {
      console.error(err); toast('Não foi possível atualizar os dados.', 'err');
      go.disabled = false; go.textContent = 'Atualizar painel';
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
      <text x="${b.x + W - 12}" y="${b.y + 22}" text-anchor="end" class="mcount">${nf.format(b.t.rows.length)}</text>
      ${b.shown.map((c, i) => `<text x="${b.x + 14}" y="${b.y + HEAD + i * ROWH + 14}" class="mfield ${keys.has(c.name) ? 'key' : ''}">${keys.has(c.name) ? '🔑 ' : ''}${esc(c.name.length > 26 ? c.name.slice(0, 25) + '…' : c.name)}</text>`).join('')}
      ${b.t.columns.length > MAXF ? `<text x="${b.x + 14}" y="${b.y + HEAD + MAXF * ROWH + 14}" class="mmore">+ ${b.t.columns.length - MAXF} campos</text>` : ''}
    </g>`).join('');
  return `<svg class="model-svg" viewBox="0 0 ${width} ${height}" style="max-width:${width}px">${lines}${boxSvg}</svg>`;
}

function openModel(ds, data) {
  const model = buildModel(ds, data);
  const back = document.createElement('div');
  back.className = 'modal-back';
  const linksOf = t => model.keys.filter(k => t.columns.some(c => c.name === k));
  back.innerHTML = `
    <div class="modal card modal-wide">
      <header><h2>Modelo de dados</h2><button class="x" data-close>×</button></header>
      <div class="modal-body">
        <p class="muted">As tabelas se ligam pelos <strong>campos com o mesmo nome</strong> (🔑), como no Qlik. Selecionar um valor em uma tabela filtra as outras pelas ligações, e um gráfico pode juntar campos de tabelas ligadas.</p>
        <div class="model-wrap">${modelSvg(model)}</div>
        <div class="table-list">${model.tables.map(t => `
          <div class="tl-item">
            <div><strong>${esc(t.name)}</strong> ${t.id === 'main' ? '<span class="tag">principal</span>' : ''}
              <small class="muted">${nf.format(t.rows.length)} linhas · ${t.columns.length} campos · ${linksOf(t).length ? 'liga por ' + linksOf(t).map(esc).join(', ') : '<span class="warn-text">sem ligação</span>'}</small></div>
            ${canEdit() && t.id !== 'main' ? `<div class="row-actions"><button class="btn ghost small" data-tupd="${t.id}">⟳ Atualizar</button><button class="btn ghost small danger" data-tdel="${t.id}">Remover</button></div>` : ''}
          </div>`).join('')}</div>
        ${canEdit() ? '<button class="btn" id="btn-addtable">+ Adicionar tabela</button>' : ''}
      </div>
    </div>`;
  document.body.append(back);
  const close = () => back.remove();
  back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.querySelector('#btn-addtable')?.addEventListener('click', () => { close(); openAddTable(ds, data); });
  back.querySelectorAll('[data-tupd]').forEach(b => b.addEventListener('click', () => { close(); openAddTable(ds, data, (ds.tables || []).find(t => t.id === b.dataset.tupd)); }));
  back.querySelectorAll('[data-tdel]').forEach(b => b.addEventListener('click', async () => {
    const t = ds.tables.find(x => x.id === b.dataset.tdel);
    if (!confirm(`Remover a tabela "${t.name}" deste painel? Gráficos que usam campos dela vão ficar vazios.`)) return;
    try {
      ds.tables = await store.removeTable(ds.id, t.id);
      rowsCache.delete(ds.id); close(); toast('Tabela removida.'); showDashboard(ds.id);
    } catch (err) { console.error(err); toast('Não foi possível remover a tabela.', 'err'); }
  }));
}

// adicionar uma tabela ao painel (ou atualizar uma tabela extra existente)
function openAddTable(ds, data, existing = null) {
  const others = buildModel({ ...ds, tables: (ds.tables || []).filter(t => !existing || t.id !== existing.id) }, data);
  const fieldsElsewhere = others.fields; // campos das outras tabelas (para ligar)
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal card modal-wide">
      <header><h2>${existing ? `Atualizar tabela "${esc(existing.name)}"` : 'Adicionar tabela ao painel'}</h2><button class="x" data-close>×</button></header>
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
        ${st.links.length ? `<div class="ok-text">🔗 Liga ao modelo por: ${st.links.map(x => esc(x.f.name)).join(', ')}</div>` : '<div class="warn-text">⚠ Nenhum campo com o mesmo nome de outra tabela: esta tabela vai ficar solta (as seleções não a filtram). Renomeie a coluna-chave para o nome usado no painel, por exemplo "Vendedor".</div>'}
        ${st.multi.length ? `<div class="warn-text">⚠ Liga com ${esc(st.multi.join(', '))} por mais de um campo. Isso pode gerar resultados inesperados (no Qlik vira "chave sintética"). Prefira um campo-chave só: renomeie os outros.</div>` : ''}
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
    try { sheets = await readFile(file, { maxRows: MAX_ROWS + 1 }); } catch (err) { console.error(err); body.innerHTML = '<div class="error">Não consegui ler este arquivo.</div>'; return; }
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
      const rows = normalizeRows(final, sheet.data.slice(0, MAX_ROWS));
      const columns = final.map(({ name: n, type }) => ({ name: n, type }));
      const prog = p => (go.textContent = `Enviando… ${Math.round(p * 100)}%`);
      ds.tables = existing ? await store.replaceTable(ds.id, existing.id, { name, columns }, rows, prog)
                           : await store.addTable(ds.id, { name, columns }, rows, prog);
      rowsCache.delete(ds.id);
      close();
      toast(existing ? `Tabela "${name}" atualizada.` : `Tabela "${name}" adicionada ao painel.`);
      showDashboard(ds.id);
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
        <span class="muted">Excel (.xlsx, .xls), CSV ou QVD do Qlik · até ${nf.format(MAX_ROWS)} linhas · a primeira linha deve ter os títulos</span>
      </label>
      <p class="muted tip">Dica: já usa Qlik? Envie direto os <strong>.qvd</strong> que suas cargas geram. Também dá para exportar uma consulta do Protheus ou SAP para Excel. Datas no formato aaaammdd (ex.: D2_EMISSAO) são reconhecidas automaticamente.</p>
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
  try { sheets = await readFile(file, { maxRows: MAX_ROWS + 1 }); }
  catch (e) { console.error(e); preview.innerHTML = `<div class="card error">Não consegui ler este arquivo. ${esc(e.message || '')}</div>`; return; }
  if (!sheets.length) { preview.innerHTML = `<div class="card error">O arquivo está vazio.</div>`; return; }

  let sheet = sheets[0];
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const source = /\.(csv|txt)$/i.test(file.name) ? 'csv' : /\.qvd$/i.test(file.name) ? 'qvd' : 'excel';

  // configuração do resumo (para arquivos grandes)
  let sumOn = false, sumKeep = null, sumGrains = {}, sumFrom = '', sumDateCol = null, sumResult = null, sumSig = '';
  const sumSignature = () => JSON.stringify([sumKeep, sumGrains, sumFrom, sumDateCol, sheet.columns.map(c => c.type), sheet.name]);
  const resetSum = () => {
    sumKeep = sheet.columns.map(c => c.name);
    const dates = sheet.columns.filter(c => c.type === 'date');
    sumGrains = Object.fromEntries(dates.map(c => [c.name, 'month']));
    sumDateCol = dates[0]?.name || null;
    sumResult = null;
  };
  resetSum();
  sumOn = (sheet.total || sheet.data.length) > MAX_ROWS;

  const runSummary = () => {
    const sig = sumSignature();
    if (sumResult && sig === sumSig) return sumResult;
    sumResult = summarize(sheet, sheet.columns, { keep: sumKeep, grains: sumGrains, from: sumFrom, dateCol: sumDateCol });
    sumSig = sig;
    return sumResult;
  };

  const draw = () => {
    const total = sheet.total || sheet.data.length;
    const tooMany = total > MAX_ROWS;
    const dateCols = sheet.columns.filter(c => c.type === 'date');
    const sumBox = `
      <details class="summary-box" ${sumOn || tooMany ? 'open' : ''}>
        <summary><strong>Resumir dados antes de importar</strong> ${tooMany ? '<span class="tag warn-tag">recomendado: passa do limite</span>' : '<span class="muted">(opcional)</span>'}</summary>
        <p class="muted small">Agrupa as linhas pelos campos de <strong>texto e data</strong> que você manter e <strong>soma os campos numéricos</strong>. A coluna <code>${COUNT_FIELD}</code> guarda quantas linhas originais cada linha resumida representa. Os totais ficam iguais; desmarque campos que não fazem sentido somar (preço unitário, por exemplo) e códigos muito detalhados (nº da nota, item) para resumir mais.</p>
        <label class="check"><input type="checkbox" id="sum-on" ${sumOn ? 'checked' : ''}><span>Resumir este arquivo</span></label>
        <div class="sum-grid" ${sumOn ? '' : 'hidden'}>
          <div class="sum-cols">${sheet.columns.map(c => `
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
          <label class="field grow"><span>Nome do painel</span><input id="ds-name" value="${esc(sheets.length > 1 ? `${baseName} - ${sheet.name}` : baseName)}"></label>
          ${sheets.length > 1 ? `<label class="field"><span>Aba</span><select id="sheet">${sheets.map((s, i) => `<option value="${i}" ${s === sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        </div>
        <p class="muted">${nf.format(sheet.total || sheet.data.length)} linhas · ${sheet.columns.length} colunas${sheet.total ? ' · arquivo QVD do Qlik' : ''}. Confira os tipos detectados — números são somados, datas viram linha do tempo e textos viram filtros.</p>
        ${tooMany && !sumOn ? `<p class="error">Este plano aceita até ${nf.format(MAX_ROWS)} linhas por painel e o arquivo tem ${nf.format(total)}. Resuma os dados abaixo para usar o arquivo inteiro — sem resumir, só as primeiras ${nf.format(MAX_ROWS)} linhas serão importadas.</p>` : ''}
        <div class="table-wrap"><table>
          <thead>
            <tr>${sheet.columns.map(c => `<th>${esc(c.name)}</th>`).join('')}</tr>
            <tr>${sheet.columns.map((c, i) => `<th><select data-col="${i}" class="type-${c.type}">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${v}</option>`).join('')}</select></th>`).join('')}</tr>
          </thead>
          <tbody>${sheet.data.slice(0, 8).map(r => `<tr>${sheet.columns.map(c => `<td>${esc(r[c.index] instanceof Date ? r[c.index].toLocaleDateString('pt-BR') : r[c.index])}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
        ${sumBox}
        <div class="row-end"><span class="muted" id="progress"></span><button class="btn" id="btn-save">Criar painel</button></div>
      </div>`;

    const out = preview.querySelector('#sum-out');
    const showResult = r => {
      const ok = r.rows.length <= MAX_ROWS;
      out.innerHTML = `${nf.format(r.used)} linhas${r.used < r.read ? ` (de ${nf.format(r.read)}, filtradas pela data)` : ''} → <strong class="${ok ? 'ok-text' : 'error'}">${nf.format(r.rows.length)} linhas resumidas</strong>${ok ? '' : ` — ainda passa de ${nf.format(MAX_ROWS)}: desmarque campos detalhados ou agrupe as datas por mês`}`;
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
    preview.querySelectorAll('[data-col]').forEach(s => s.addEventListener('change', () => {
      sheet.columns[+s.dataset.col].type = s.value;
      s.className = `type-${s.value}`;
      if (sumOn) draw();   // o tipo muda o que é somado e o que agrupa
    }));
    preview.querySelector('#btn-save').addEventListener('click', async e => {
      const btn = e.currentTarget;
      const name = preview.querySelector('#ds-name').value.trim() || baseName;
      btn.disabled = true;
      const prog = preview.querySelector('#progress');
      prog.textContent = 'Preparando dados…';
      try {
        let rows, columns, summary = null;
        if (sumOn) {
          if (!sumKeep.length) throw Object.assign(new Error('Escolha pelo menos um campo para manter.'), { user: true });
          const r = await calc();
          if (!r) throw new Error('resumo');
          if (r.rows.length > MAX_ROWS) throw Object.assign(new Error(`O resumo ainda tem ${nf.format(r.rows.length)} linhas. Desmarque campos detalhados ou agrupe as datas por mês.`), { user: true });
          rows = r.rows; columns = r.columns;
          summary = { keep: sumKeep, grains: sumGrains, from: sumFrom, dateCol: sumDateCol, sourceRows: r.read };
        } else {
          rows = normalizeRows(sheet.columns, sheet.data.slice(0, MAX_ROWS));
          columns = sheet.columns.map(({ name, type }) => ({ name, type }));
        }
        const meta = { name, source, columns, rowCount: rows.length };
        if (summary) meta.summary = summary;
        meta.dashboard = suggestConfig(meta, rows);
        const id = await store.saveDataset(meta, rows, p => (prog.textContent = `Enviando… ${Math.round(p * 100)}%`));
        rowsCache.set(id, { main: rows });
        toast('Painel criado!');
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
async function showDashboard(id) {
  const view = shell('home', 'Carregando painel…', '<div class="loading">Carregando dados…</div>',
    `<a class="btn ghost" href="#/">← Voltar</a><button class="btn ghost" id="btn-model">🗂 Modelo de dados</button>${canEdit() ? '<button class="btn ghost" id="btn-refresh">⟳ Atualizar dados</button><button class="btn ghost" id="btn-share">🔗 Compartilhar</button>' : ''}`);
  let ds, rows;
  try {
    const list = await store.listDatasets();
    ds = list.find(d => d.id === id);
    if (!ds) { view.innerHTML = `<div class="card error">Painel não encontrado.</div>`; return; }
    rows = rowsCache.get(id) || await store.loadAll(id);   // { main: [...], <tabela>: [...] }
    rowsCache.set(id, rows);
  } catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erro ao carregar o painel.</div>`; return; }

  document.querySelector('.topbar h1').textContent = ds.name;
  document.getElementById('btn-share')?.addEventListener('click', () => openShare(ds));
  document.getElementById('btn-refresh')?.addEventListener('click', () => openRefresh(ds));
  document.getElementById('btn-model').addEventListener('click', () => openModel(ds, rows));
  mountDashboard(view, ds, rows, ds.dashboard, canEdit() ? async cfg => {
    try { await store.updateDashboard(id, cfg); ds.dashboard = cfg; toast('Painel salvo.'); }
    catch (e) { console.error(e); toast('Erro ao salvar o painel.', 'err'); throw e; }
  } : null);
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
            <p><span class="badge ok">🔗 Link ativo</span> Qualquer pessoa com o link vê o painel e usa os filtros, <strong>sem precisar de conta</strong>. Ninguém consegue editar.</p>
            <div class="copy-row"><input id="share-url" readonly value="${esc(shareUrl(ds.shareId))}"><button class="btn" id="btn-copy">Copiar</button></div>
            <div class="row-actions">
              <a class="btn ghost small" href="${esc(shareUrl(ds.shareId))}" target="_blank" rel="noopener">Abrir em nova aba</a>
              <button class="btn ghost small danger" id="btn-revoke">Desativar link</button>
            </div>
            <p class="muted small">Ao desativar, o link para de funcionar na hora. Um link novo gerado depois será diferente.</p>`
          : `
            <p>Crie um link para mostrar este painel a alguém de fora da empresa (sócio, cliente, uma TV na recepção). Quem abrir só visualiza e filtra.</p>
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
      if (!confirm('Desativar o link? Quem tiver o link não vai mais conseguir abrir o painel.')) return;
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
  $app.innerHTML = '<div class="loading">Carregando painel…</div>';
  let data = null;
  try { data = await store.loadShared(t); } catch (e) { console.error(e); }
  if (!data) {
    $app.innerHTML = `<div class="center-page"><div class="card invite-page">
      <div class="brand"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> ${APP_NAME}</div>
      <h2>Link indisponível</h2><p class="muted">Este painel não existe mais ou o link foi desativado por quem compartilhou.</p>
      <a class="btn" href="${location.pathname}">Conhecer o ${APP_NAME}</a></div></div>`;
    return;
  }
  $app.innerHTML = `
    <div class="public-page">
      <header class="public-top">
        <div class="brand dark"><img class="logo-img" src="img/icon-nuvembi.png" alt=""> ${APP_NAME}</div>
        <h1>${esc(data.ds.name)}</h1>
        <span class="badge">Somente visualização</span>
        <a class="btn small" href="${location.pathname}" target="_blank" rel="noopener">Criar meu painel grátis</a>
      </header>
      <main class="main" id="view"></main>
    </div>`;
  mountDashboard(document.getElementById('view'), data.ds, data.data, data.ds.dashboard, null);
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
        <div><strong>Editor</strong><span>importa planilhas, edita, exclui e compartilha painéis</span></div>
        <div><strong>Visualizador</strong><span>só vê e filtra os painéis</span></div>
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
    if (!confirm(`Remover ${b.dataset.email} da empresa? A pessoa perde o acesso aos painéis.`)) return;
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
    if (!confirm(`Sair da empresa "${store.org.name}"? Você perde o acesso aos painéis dela.`)) return;
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
      ${card('QVD', 'Arquivos QVD (Qlik)', 'Ativo', 'ok', 'Envie os .qvd gerados pelas suas cargas do Qlik Sense/QlikView. Números, datas e códigos com zero à esquerda vêm com o tipo certo, sem precisar exportar para Excel.')}
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
