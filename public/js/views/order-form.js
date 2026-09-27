// Novo pedido / editar pedido.
import { html, api, icon, fmtNum, brl, parseNum, todayStr, hasPerm, toast, toastError, $, $$ } from '../lib.js';

export async function render(ctx) {
  const { el, me, params } = ctx;
  if (!hasPerm(me, 'pedidos')) throw new Error('Você não tem permissão para criar ou editar pedidos.');
  const editing = params.id ? Number(params.id) : null;
  const [items, clients, order] = await Promise.all([
    api('/items'),
    api('/clients'),
    editing ? api(`/orders/${editing}`) : Promise.resolve(null),
  ]);
  if (!ctx.isCurrent()) return;
  ctx.setTitle(editing ? `Editar pedido #${editing}` : 'Novo pedido', { back: true });
  const products = items.filter((i) => i.source === 'producao');
  const others = items.filter((i) => i.source !== 'producao');
  // últimos preços usados por produto (lembrados neste aparelho)
  const lastPrice = (id) => { try { return localStorage.getItem(`gsc.price.${id}`) || ''; } catch { return ''; } };
  const rememberPrice = (id, v) => { try { localStorage.setItem(`gsc.price.${id}`, v); } catch { /* ok */ } };

  const lines = order
    ? order.items.map((l) => ({ id: l.id, item_id: l.item_id, quantity: l.quantity, unit_price: l.unit_price ?? 0, packed: l.packed }))
    : [{ id: null, item_id: products[0] ? products[0].id : null, quantity: '', unit_price: '', packed: 0 }];

  const productOptions = (sel) => html`
    <optgroup label="Impressos">${products.map((p) => html`<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${p.name}</option>`)}</optgroup>
    ${others.length ? html`<optgroup label="Outros itens">${others.map((p) => html`<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${p.name}</option>`)}</optgroup>` : ''}`;

  el.innerHTML = String(html`
    <div class="page-title"><h1>${editing ? `Editar pedido #${editing}` : 'Novo pedido'}</h1></div>
    <form class="card" data-form style="max-width:760px" novalidate>
      <div class="form-grid cols-2">
        <label class="field"><span>Cliente</span>
          <input class="input" name="client_name" list="dl-clients" required maxlength="120" value="${order ? order.client_name : ''}" placeholder="Ex.: Supermercado Cohama" autocomplete="off">
          <span class="hint" data-client-hint>Escolha da lista ou digite um nome novo (o cliente é cadastrado automaticamente).</span></label>
        <label class="field"><span>Entrega combinada para</span>
          <input class="input" type="date" name="due_date" value="${order ? order.due_date || '' : ''}" min="${todayStr(-365)}"></label>
      </div>
      <div class="label">Produtos</div>
      <div class="lines-editor" data-lines></div>
      <button type="button" class="btn secondary sm" data-add>${icon('plus')} Adicionar produto</button>
      <div class="calc" style="margin-top:16px" data-total></div>
      <label class="field"><span>Observações <span class="muted">(opcional)</span></span>
        <textarea class="input" name="notes" maxlength="1000" placeholder="Ex.: separar em pacotes de 250; entregar pela manhã">${order ? order.notes || '' : ''}</textarea></label>
      <button class="btn block" type="submit" style="min-height:52px">${icon('check')} ${editing ? 'Salvar alterações' : 'Criar pedido'}</button>
    </form>
    <datalist id="dl-clients">${clients.map((c) => html`<option value="${c.name}">`)}</datalist>`);

  const box = $('[data-lines]', el);
  const drawLines = () => {
    box.innerHTML = String(html`${lines.map((l, i) => html`
      <div class="line-row" data-i="${i}">
        <label><span class="xs muted">Produto</span><select class="input" data-f="item_id" ${l.packed > 0 ? 'disabled' : ''}>${productOptions(l.item_id)}</select></label>
        <label><span class="xs muted">Quantidade (folhas)</span><input class="input" data-f="quantity" inputmode="numeric" value="${l.quantity}" placeholder="0"></label>
        <label><span class="xs muted">Preço por folha</span><input class="input" data-f="unit_price" inputmode="decimal" value="${l.unit_price === '' ? '' : String(l.unit_price).replace('.', ',')}" placeholder="R$ 0,00"></label>
        <button type="button" class="icon-btn" data-del="${i}" title="Remover" ${lines.length === 1 || l.packed > 0 ? 'disabled' : ''}>${icon('trash')}</button>
        ${l.packed > 0 ? html`<span class="xs muted" style="grid-column:1/-1">${fmtNum(l.packed)} já empacotadas</span>` : ''}
      </div>`)}`);
    $$('[data-del]', box).forEach((b) => { b.onclick = () => { lines.splice(Number(b.dataset.del), 1); drawLines(); }; });
    updateTotal();
  };
  box.addEventListener('input', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const l = lines[Number(row.dataset.i)];
    l[e.target.dataset.f] = e.target.dataset.f === 'item_id' ? Number(e.target.value) : e.target.value;
    if (e.target.dataset.f === 'item_id' && !l.unit_price) {
      l.unit_price = lastPrice(l.item_id);
      row.querySelector('[data-f=unit_price]').value = l.unit_price;
    }
    updateTotal();
  });

  function updateTotal() {
    const total = lines.reduce((a, l) => a + (parseNum(l.quantity) || 0) * (parseNum(l.unit_price) || 0), 0);
    const sheets = lines.reduce((a, l) => a + (parseNum(l.quantity) || 0), 0);
    $('[data-total]', el).innerHTML = String(html`<span>${fmtNum(sheets)} folhas no total</span><span>Valor do pedido: <b>${brl(total)}</b></span>`);
  }

  $('[data-add]', el).onclick = () => {
    const used = new Set(lines.map((l) => l.item_id));
    const next = products.find((p) => !used.has(p.id)) || products[0];
    lines.push({ id: null, item_id: next ? next.id : null, quantity: '', unit_price: next ? lastPrice(next.id) : '', packed: 0 });
    drawLines();
  };
  if (!order && lines[0].item_id) lines[0].unit_price = lastPrice(lines[0].item_id);
  drawLines();

  const form = $('[data-form]', el);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const clientName = form.elements.client_name.value.trim();
    if (!clientName) return toast('Informe o cliente.', { error: true });
    const payload = [];
    for (const l of lines) {
      const q = parseNum(l.quantity);
      const price = l.unit_price === '' ? 0 : parseNum(l.unit_price);
      if (!(q > 0)) return toast('Confira as quantidades dos produtos.', { error: true });
      if (!(price >= 0)) return toast('Confira os preços.', { error: true });
      payload.push({ id: l.id || undefined, item_id: l.item_id, quantity: q, unit_price: price });
    }
    const body = { client_name: clientName, due_date: form.elements.due_date.value || null, notes: form.elements.notes.value, items: payload };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const saved = await api(editing ? `/orders/${editing}` : '/orders', { method: editing ? 'PUT' : 'POST', body });
      payload.forEach((p) => p.unit_price && rememberPrice(p.item_id, String(p.unit_price).replace('.', ',')));
      toast(editing ? 'Pedido atualizado.' : `Pedido #${saved.id} criado.`);
      ctx.go(`#/pedido/${saved.id}`);
    } catch (err) {
      toastError(err);
      btn.disabled = false;
    }
  };
}
