// Lista de pedidos (com filtros) e aba de clientes.
import { html, api, icon, fmtNum, fmtDay, brl, hasPerm, toast, toastError, $, $$ } from '../lib.js';

const FILTERS = [
  ['em_andamento', 'Em andamento'],
  ['abertos', 'A empacotar'],
  ['para_entregar', 'Para entregar'],
  ['atrasados', 'Atrasados'],
  ['entregue', 'Entregues'],
  ['cancelado', 'Cancelados'],
  ['', 'Todos'],
];

export function statusChip(o) {
  return html`<span class="status ${o.status}">${o.status_label}</span>`;
}

export function orderCard(o) {
  const pct = o.quantity_total ? Math.min(100, (100 * o.packed_total) / o.quantity_total) : 0;
  return html`<a class="card order-card" href="#/pedido/${o.id}">
    <div class="row between wrap"><b>#${o.id} · ${o.client_name}</b>${statusChip(o)}</div>
    <div class="small muted" style="margin-top:4px">
      ${o.due_date ? html`Entrega: <span class="${o.late ? 'late' : ''}">${fmtDay(o.due_date)}${o.late ? ' (atrasado)' : ''}</span>` : 'Sem data de entrega'}
      ${o.total !== undefined && o.total > 0 ? html` · ${brl(o.total)}` : ''}
      ${o.payment && o.payment.status === 'pago' ? ' · pago' : ''}
    </div>
    <ul class="order-lines">${o.items.map((l) => html`<li>
      <div class="row between small"><span>${l.item_name}</span><span class="num">${fmtNum(Math.min(l.packed, l.quantity))} / ${fmtNum(l.quantity)}</span></div>
    </li>`)}</ul>
    ${!['entregue', 'cancelado'].includes(o.status) ? html`<div class="progress ${pct >= 100 ? 'done' : ''}" style="margin-top:10px" role="img" aria-label="${fmtNum(pct, 0)}% empacotado"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
  </a>`;
}

export async function render(ctx) {
  const { el, me, params, query } = ctx;
  ctx.setTitle('Pedidos');
  if (params.tab === 'clientes') return clientsTab(ctx);
  let status = query.status ?? 'em_andamento';
  let q = query.q || '';

  el.innerHTML = String(html`
    <div class="page-title"><h1>Pedidos</h1>
      ${hasPerm(me, 'pedidos') ? html`<a class="btn" href="#/pedido/novo">${icon('plus')} Novo pedido</a>` : ''}</div>
    <nav class="tabs"><a href="#/pedidos" class="active">Pedidos</a><a href="#/pedidos/clientes">Clientes</a></nav>
    <div class="toolbar">
      <label class="search">${icon('search')}<input class="input" type="search" data-q placeholder="Cliente ou nº do pedido" value="${q}"></label>
      ${hasPerm(me, 'pedidos') ? html`<a class="btn hide-lg" href="#/pedido/novo">${icon('plus')} Novo</a>` : ''}
    </div>
    <div class="chips" role="group" aria-label="Filtrar pedidos" data-chips></div>
    <div data-list></div>
    <div style="text-align:center;margin-top:12px"><button class="btn secondary hidden" data-more>Carregar mais</button></div>`);

  let offset = 0;
  const list = $('[data-list]', el);
  const more = $('[data-more]', el);

  async function load(reset) {
    if (reset) offset = 0;
    const qs = new URLSearchParams({ status, q, limit: 30, offset });
    const res = await api(`/orders?${qs}`);
    if (!ctx.isCurrent()) return;
    const c = res.counts;
    const counts = { em_andamento: (c.abertos || 0) + (c.para_entregar || 0), abertos: c.abertos, para_entregar: c.para_entregar, atrasados: c.atrasados };
    $('[data-chips]', el).innerHTML = String(html`${FILTERS.map(([k, l]) => html`<button class="chip" data-s="${k}" aria-pressed="${status === k}">${l}${counts[k] ? ` (${counts[k]})` : ''}</button>`)}`);
    $$('[data-s]', el).forEach((b) => {
      b.onclick = () => {
        status = b.dataset.s;
        history.replaceState(null, '', `#/pedidos?${new URLSearchParams({ status, q })}`);
        load(true);
      };
    });
    const cards = res.orders.map((o) => String(orderCard(o))).join('');
    if (reset) list.innerHTML = res.orders.length ? `<div class="items">${cards}</div>` : String(html`<div class="empty">Nenhum pedido aqui.</div>`);
    else list.querySelector('.items').insertAdjacentHTML('beforeend', cards);
    offset += res.orders.length;
    more.classList.toggle('hidden', !res.has_more);
  }

  let timer;
  $('[data-q]', el).oninput = (e) => {
    q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => load(true), 300);
  };
  more.onclick = () => load(false);
  await load(true);
}

async function clientsTab(ctx) {
  const { el, me } = ctx;
  const clients = await api('/clients?all=1');
  if (!ctx.isCurrent()) return;
  const canEdit = hasPerm(me, 'pedidos');
  el.innerHTML = String(html`
    <div class="page-title"><h1>Pedidos</h1></div>
    <nav class="tabs"><a href="#/pedidos">Pedidos</a><a href="#/pedidos/clientes" class="active">Clientes</a></nav>
    <div class="grid-2">
      <div class="card">
        <h2 style="margin-bottom:8px">Clientes (${clients.length})</h2>
        ${clients.length ? html`<ul class="list">${clients.map((c) => html`<li>
          <div class="row between wrap"><div><b>${c.name}</b> ${c.active ? '' : html`<span class="tag">Desativado</span>`}
            <div class="small muted">${[c.phone, c.address].filter(Boolean).join(' · ') || 'sem contato cadastrado'}</div>
            <div class="xs muted">${c.orders} ${c.orders === 1 ? 'pedido' : 'pedidos'}</div></div>
            <div class="row">
              <a class="btn ghost sm" href="#/pedidos?${new URLSearchParams({ status: '', q: c.name })}">Pedidos</a>
              ${canEdit ? html`<button class="btn ghost sm" data-edit="${c.id}">${icon('edit')} Editar</button>` : ''}
            </div></div></li>`)}</ul>` : html`<div class="empty">Nenhum cliente ainda. Eles são criados junto com os pedidos.</div>`}
      </div>
      ${canEdit ? html`<form class="card" data-form>
        <h2 style="margin-bottom:14px" data-form-title>Novo cliente</h2>
        <input type="hidden" name="id">
        <label class="field"><span>Nome</span><input class="input" name="name" required maxlength="120"></label>
        <label class="field"><span>Telefone / WhatsApp</span><input class="input" name="phone" inputmode="tel" maxlength="40"></label>
        <label class="field"><span>Endereço de entrega</span><input class="input" name="address" maxlength="300"></label>
        <div class="form-grid cols-2">
          <label class="field"><span>E-mail</span><input class="input" name="email" type="email" maxlength="120"></label>
          <label class="field"><span>CPF/CNPJ</span><input class="input" name="document" maxlength="30"></label>
        </div>
        <label class="field"><span>Observações</span><textarea class="input" name="notes" maxlength="500"></textarea></label>
        <label class="check hidden" data-active-wrap><input type="checkbox" name="active" checked> Cliente ativo</label>
        <div class="row wrap"><button class="btn" type="submit">Salvar</button><button class="btn secondary" type="reset">Limpar</button></div>
      </form>` : ''}
    </div>`);

  const form = $('[data-form]', el);
  if (!form) return;
  $$('[data-edit]', el).forEach((b) => {
    b.onclick = () => {
      const c = clients.find((x) => String(x.id) === b.dataset.edit);
      for (const k of ['id', 'name', 'phone', 'address', 'email', 'document', 'notes']) form.elements[k].value = c[k] || '';
      form.elements.active.checked = !!c.active;
      $('[data-active-wrap]', el).classList.remove('hidden');
      $('[data-form-title]', el).textContent = `Editar: ${c.name}`;
      form.scrollIntoView({ behavior: 'smooth' });
    };
  });
  form.onreset = () => {
    $('[data-active-wrap]', el).classList.add('hidden');
    $('[data-form-title]', el).textContent = 'Novo cliente';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const body = { ...d, active: form.elements.active.checked };
    try {
      if (d.id) await api(`/clients/${d.id}`, { method: 'PUT', body });
      else await api('/clients', { method: 'POST', body });
      toast('Cliente salvo.');
      clientsTab(ctx);
    } catch (err) { toastError(err); }
  };
}
