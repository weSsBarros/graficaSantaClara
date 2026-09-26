import { html, api, fmtNum, plural, packText, statusBadge, runoutText, CATEGORY_LABELS, $, $$ } from '../lib.js';
import { meter } from './components.js';

export async function render(ctx) {
  const { el, me, query } = ctx;
  ctx.setTitle('Estoque');
  const items = await api('/items');
  if (!ctx.isCurrent()) return;
  let filter = query.f || 'todos';

  const cats = [...new Set(items.map((i) => i.category))];
  const alertCount = items.filter((i) => i.forecast.status !== 'ok').length;
  const filters = [
    ['todos', 'Todos'],
    ...cats.map((c) => [c, CATEGORY_LABELS[c]]),
    ['alerta', `Em alerta (${alertCount})`],
  ];

  const draw = () => {
    const list = items.filter((i) => filter === 'todos' || (filter === 'alerta' ? i.forecast.status !== 'ok' : i.category === filter));
    el.innerHTML = String(html`
      <div class="page-title"><h1>Estoque</h1>
        ${me.perms.includes('entrada') ? html`<a class="btn" href="#/lancar/entrada">Registrar entrada</a>` : ''}
      </div>
      <div class="chips" role="group" aria-label="Filtrar itens">
        ${filters.map(([k, label]) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${label}</button>`)}
      </div>
      ${list.length ? html`<div class="items">${list.map((i) => html`
        <a class="card item-card" href="#/item/${i.id}">
          <div class="row between"><span class="cat">${CATEGORY_LABELS[i.category]}</span>${statusBadge(i.forecast, i.quantity)}</div>
          <h3 style="margin-top:6px">${i.name}</h3>
          <div class="qty">${fmtNum(i.quantity)} <small>${plural(i.unit, i.quantity)}</small></div>
          <div class="small muted">${packText(i, i.quantity) || html`&nbsp;`}</div>
          ${meter(i)}
          <div class="small">${runoutText(i)}</div>
        </a>`)}</div>` : html`<div class="empty">Nenhum item aqui.</div>`}`);
    $$('[data-f]', el).forEach((b) => {
      b.onclick = () => { filter = b.dataset.f; draw(); };
    });
  };
  draw();
}
