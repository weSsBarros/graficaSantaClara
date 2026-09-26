import { html, icon, LOGO, api, initials, spinner, toastError, $ } from './lib.js';
import { destroyCharts } from './charts.js';
import * as login from './views/login.js';
import * as home from './views/home.js';
import * as stock from './views/stock.js';
import * as item from './views/item.js';
import * as forms from './views/forms.js';
import * as dashboard from './views/dashboard.js';
import * as historyView from './views/history.js';
import * as maintenance from './views/maintenance.js';
import * as logs from './views/logs.js';
import * as config from './views/config.js';
import * as more from './views/more.js';
import * as pin from './views/pin.js';

const state = { me: null };

const ROUTES = [
  ['/', home],
  ['/estoque', stock],
  ['/item/:id', item],
  ['/lancar/:tipo', forms],
  ['/producao/:id', forms],
  ['/painel', dashboard],
  ['/historico', historyView],
  ['/manutencao', maintenance],
  ['/logs', logs],
  ['/config', config],
  ['/config/:tab', config],
  ['/mais', more],
  ['/pin', pin],
];

function match(path) {
  for (const [pattern, view] of ROUTES) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    const m = re.exec(path);
    if (m) return { view, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = h.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs)) };
}

export const go = (hash) => { location.hash = hash; };

// ---------- estrutura (menu lateral no PC, barra inferior no celular) ----------

function navItems() {
  const p = state.me.perms;
  return [
    { href: '#/', label: 'Início', icon: 'home', match: ['/'] },
    { href: '#/estoque', label: 'Estoque', icon: 'box', match: ['/estoque', '/item'] },
    { href: '#/painel', label: 'Painel', icon: 'chart', match: ['/painel'] },
    { href: '#/historico', label: 'Histórico', icon: 'clock', match: ['/historico'] },
    { href: '#/manutencao', label: 'Manutenção', icon: 'wrench', match: ['/manutencao'], side: true },
    p.includes('ver_logs') && { href: '#/logs', label: 'Registro de atividades', icon: 'log', match: ['/logs'], side: true },
    p.includes('cadastros') && { href: '#/config', label: 'Configurações', icon: 'settings', match: ['/config'], side: true },
  ].filter(Boolean);
}

function renderShell() {
  const u = state.me.user;
  const items = navItems();
  document.getElementById('app').innerHTML = String(html`
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">${LOGO}<div><b>Gráfica Santa Clara</b><span>Estoque e produção</span></div></div>
        ${items.map((n) => html`<a class="nav" href="${n.href}" data-match="${n.match.join(',')}">${icon(n.icon)}${n.label}</a>`)}
        <div class="spacer"></div>
        <a class="nav" href="#/pin" data-match="/pin">${icon('key')}Trocar meu PIN</a>
        <div class="me">
          <div class="avatar">${initials(u.name)}</div>
          <div style="flex:1;min-width:0"><b>${u.name}</b><div class="xs muted">${u.role_label}</div></div>
          <button class="btn ghost sm" data-logout title="Sair">${icon('logout')}<span class="sr-only">Sair</span></button>
        </div>
      </aside>
      <div>
        <header class="topbar">
          <button class="back hidden" data-back aria-label="Voltar">${icon('back')}</button>
          <div class="title" id="page-title">Gráfica Santa Clara</div>
          <a class="avatar" href="#/mais" aria-label="Minha conta">${initials(u.name)}</a>
        </header>
        <main class="main" id="view"></main>
      </div>
      <nav class="bottomnav" aria-label="Navegação principal">
        ${items.filter((n) => !n.side).map((n) => html`<a href="${n.href}" data-match="${n.match.join(',')}">${icon(n.icon)}${n.label}</a>`)}
        <a href="#/mais" data-match="/mais,/manutencao,/logs,/config,/pin">${icon('menu')}Mais</a>
      </nav>
    </div>`);
  $('[data-logout]').onclick = logout;
  $('[data-back]').onclick = () => (history.length > 1 ? history.back() : go('#/'));
}

function highlightNav(path) {
  const base = `/${path.split('/')[1] || ''}`;
  for (const a of document.querySelectorAll('[data-match]')) {
    const list = a.dataset.match.split(',');
    a.classList.toggle('active', list.includes(base) || list.includes(path));
  }
}

function setTitle(title, { back = false } = {}) {
  document.title = `${title} · Gráfica Santa Clara`;
  const t = document.getElementById('page-title');
  if (t) t.textContent = title;
  const b = document.querySelector('[data-back]');
  if (b) b.classList.toggle('hidden', !back);
}

// ---------- sessão ----------

async function loadMe() {
  try {
    state.me = await api('/me');
  } catch {
    state.me = null;
  }
  return state.me;
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* sai mesmo assim */ }
  state.me = null;
  go('#/login');
  route();
}

window.addEventListener('gsc:logout', () => {
  if (state.me) {
    state.me = null;
    go('#/login');
    route();
  }
});

// ---------- roteamento ----------

let renderSeq = 0;

async function route() {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  destroyCharts();

  if (!state.me) await loadMe();
  if (seq !== renderSeq) return;

  if (!state.me || path === '/login') {
    if (state.me && path === '/login') return go('#/');
    document.getElementById('app').innerHTML = '<div id="view"></div>';
    document.title = 'Entrar · Gráfica Santa Clara';
    return login.render({
      el: document.getElementById('view'),
      onLogin: async () => {
        await loadMe();
        renderShell();
        go(state.me.user.must_change_pin ? '#/pin' : '#/');
        route();
      },
    });
  }

  if (!document.querySelector('.shell')) renderShell();
  if (state.me.user.must_change_pin && path !== '/pin') return go('#/pin');

  const found = match(path);
  const el = document.getElementById('view');
  if (!found) {
    el.innerHTML = String(html`<div class="empty">Página não encontrada. <a href="#/">Voltar ao início</a></div>`);
    return;
  }
  highlightNav(path);
  el.innerHTML = String(spinner());
  window.scrollTo(0, 0);
  const ctx = {
    el,
    params: found.params,
    query,
    me: state.me,
    setTitle,
    go,
    isCurrent: () => seq === renderSeq,
    refreshMe: async () => { await loadMe(); renderShell(); highlightNav(path); },
    logout,
  };
  try {
    await found.view.render(ctx);
  } catch (err) {
    if (seq !== renderSeq) return;
    el.innerHTML = String(html`<div class="empty">${err.message || 'Não foi possível carregar.'}<br><br>
      <button class="btn secondary" data-retry>Tentar de novo</button></div>`);
    el.querySelector('[data-retry]').onclick = route;
    if (err.status !== 401) toastError(err);
  }
}

window.addEventListener('hashchange', route);
// Redesenha (cores dos gráficos) quando o aparelho alterna entre modo claro e escuro.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.me && route());
route();
