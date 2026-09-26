import { html, api, icon, fmtNum, plural, packText, statusBadge, runoutText, colorDot, toast, CATEGORY_LABELS, $, $$ } from '../lib.js';
import { meter } from './components.js';
import { scanBarcode } from '../scanner.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export async function render(ctx) {
  const { el, me, query } = ctx;
  ctx.setTitle('Estoque');
  const items = await api('/items');
  if (!ctx.isCurrent()) return;
  let filter = query.f || 'todos';
  let search = '';

  const cats = Object.keys(CATEGORY_LABELS).filter((c) => items.some((i) => i.category === c));
  const alertCount = items.filter((i) => i.forecast.status !== 'ok').length;
  const filters = [['todos', 'Todos'], ...cats.map((c) => [c, CATEGORY_LABELS[c]]), ['alerta', `Em alerta (${alertCount})`]];

  const card = (i) => html`
    <a class="card item-card" href="#/item/${i.id}">
      <div class="row between"><span class="cat">${CATEGORY_LABELS[i.category] || i.category}</span>${statusBadge(i.forecast, i.quantity)}</div>
      <h3 style="margin-top:6px">${colorDot(i)}${i.name}</h3>
      <div class="qty">${fmtNum(i.quantity)} <small>${plural(i.unit, i.quantity)}</small></div>
      <div class="small muted">${packText(i, i.quantity) || html`&nbsp;`}</div>
      ${meter(i)}
      <div class="small">${runoutText(i)}</div>
    </a>`;

  el.innerHTML = String(html`
    <div class="page-title"><h1>Estoque</h1>
      ${me.perms.includes('entrada') ? html`<a class="btn" href="#/lancar/entrada">${icon('in')} Registrar entrada</a>` : ''}
    </div>
    <div class="toolbar">
      <label class="search">${icon('search')}<input class="input" type="search" data-search placeholder="Buscar item, modelo, formato, cor..." aria-label="Buscar item"></label>
      <button class="btn secondary" data-scan>${icon('scan')} Ler código</button>
      ${me.perms.includes('entrada') ? html`<a class="btn hide-lg" href="#/lancar/entrada">${icon('in')} Entrada</a>` : ''}
    </div>
    <div class="chips" role="group" aria-label="Filtrar itens">
      ${filters.map(([k, label]) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${label}</button>`)}
    </div>
    <div data-list></div>`);

  const draw = () => {
    const q = norm(search);
    const list = items.filter((i) => {
      if (filter === 'alerta' ? i.forecast.status === 'ok' : filter !== 'todos' && i.category !== filter) return false;
      if (!q) return true;
      return norm([i.name, i.model, i.size, i.color_name, i.brand, i.code, i.barcode].join(' ')).includes(q);
    });
    let body;
    if (!list.length) body = html`<div class="empty">Nenhum item encontrado.</div>`;
    else if (filter === 'todos' && !q) {
      body = cats.map((c) => {
        const group = list.filter((i) => i.category === c);
        return group.length ? html`<div class="section"><h2 style="margin-bottom:12px">${CATEGORY_LABELS[c]}</h2><div class="items">${group.map(card)}</div></div>` : '';
      });
    } else body = html`<div class="items">${list.map(card)}</div>`;
    $('[data-list]', el).innerHTML = String(html`${body}`);
  };

  $$('[data-f]', el).forEach((b) => {
    b.onclick = () => {
      filter = b.dataset.f;
      $$('[data-f]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      draw();
    };
  });
  $('[data-search]', el).oninput = (e) => { search = e.target.value; draw(); };
  $('[data-scan]', el).onclick = async () => {
    const code = await scanBarcode({ title: 'Encontrar item pelo código' });
    if (!code) return;
    try {
      const item = await api(`/items/barcode/${encodeURIComponent(code)}`);
      ctx.go(`#/item/${item.id}`);
    } catch (err) {
      toast(`${err.message} (${code})`, { error: true });
    }
  };
  draw();
}
