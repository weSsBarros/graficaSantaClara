// Novo pedido / editar pedido.
import { html, api, icon, fmtNum, brl, parseNum, todayStr, hasPerm, confirmDialog, toast, toastError, $, $$ } from '../lib.js';

export async function render(ctx) {
  const { el, me, params } = ctx;
  if (!hasPerm(me, 'pedidos')) throw new Error('Você não tem permissão para criar ou editar pedidos.');
  const editing = params.id ? Number(params.id) : null;
  const [items, clients, order, rules] = await Promise.all([
    api('/items'),
    api('/clients'),
    editing ? api(`/orders/${editing}`) : Promise.resolve(null),
    api('/orders/rules'),
  ]);
  if (!ctx.isCurrent()) return;
  ctx.setTitle(editing ? `Editar pedido #${editing}` : 'Novo pedido', { back: true });
  const products = items.filter((i) => i.source === 'producao');
  const papers = items.filter((i) => i.source !== 'producao' && i.category === 'papel');
  const others = items.filter((i) => i.source !== 'producao' && i.category !== 'papel');
  const byName = new Map(clients.map((c) => [c.name.toLowerCase(), c]));
  const norm = (c) => String(c || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*[-/,]\s*ma$/, '').trim();
  const outside = (city) => !!norm(city) && norm(city) !== norm(rules.home_city);
  // últimos preços usados por produto (lembrados neste aparelho)
  const lastPrice = (id) => { try { return localStorage.getItem(`gsc.price.${id}`) || ''; } catch { return ''; } };
  const rememberPrice = (id, v) => { try { localStorage.setItem(`gsc.price.${id}`, v); } catch { /* ok */ } };

  const lines = order
    ? order.items.map((l) => ({ id: l.id, item_id: l.item_id, quantity: l.quantity, unit_price: l.unit_price ?? 0, packed: l.packed }))
    : [{ id: null, item_id: products[0] ? products[0].id : null, quantity: '', unit_price: '', packed: 0 }];

  const group = (label, list, sel) => (list.length
    ? html`<optgroup label="${label}">${list.map((p) => html`<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${p.name}</option>`)}</optgroup>`
    : '');
  const productOptions = (sel) => html`${group('Produtos', products, sel)}${group('Papel (vendido branco)', papers, sel)}${group('Outros itens', others, sel)}`;

  el.innerHTML = String(html`
    <div class="page-title"><h1>${editing ? `Editar pedido #${editing}` : 'Novo pedido'}</h1></div>
    <form class="card" data-form style="max-width:760px" novalidate>
      <div class="form-grid cols-2">
        <label class="field"><span>Cliente</span>
          <input class="input" name="client_name" list="dl-clients" required maxlength="120" value="${order ? order.client_name : ''}" placeholder="Ex.: Supermercado Cohama" autocomplete="off">
          <span class="hint" data-client-hint>Escolha da lista ou digite um nome novo (o cliente é cadastrado automaticamente).</span></label>
        <label class="field"><span>Entrega combinada para</span>
          <input class="input" type="date" name="due_date" value="${order ? order.due_date || '' : ''}" min="${todayStr(-365)}"></label>
        <label class="field hidden" data-city-wrap><span>Cidade do cliente novo</span>
          <input class="input" name="client_city" maxlength="60" placeholder="${rules.home_city}">
          <span class="hint">Em branco = ${rules.home_city}.</span></label>
      </div>
      <div class="form-grid cols-2">
        <label class="field"><span>Chegou por</span>
          <select class="input" name="channel"><option value="">—</option>
            ${rules.channels.map((c) => html`<option ${order && order.channel === c ? 'selected' : ''}>${c}</option>`)}</select></label>
        <label class="field"><span>Nota fiscal nº <span class="muted">(se já foi emitida)</span></span>
          <input class="input" name="invoice_number" maxlength="40" value="${order ? order.invoice_number || '' : ''}" autocomplete="off"></label>
      </div>
      <div class="label">Produtos</div>
      <div class="lines-editor" data-lines></div>
      <button type="button" class="btn secondary sm" data-add>${icon('plus')} Adicionar produto</button>
      <div class="calc" style="margin-top:16px" data-total></div>
      <label class="field"><span>Observações <span class="muted">(opcional)</span></span>
        <textarea class="input" name="notes" maxlength="1000" placeholder="Ex.: separar em pacotes de 150; entregar pela manhã">${order ? order.notes || '' : ''}</textarea></label>
      <button class="btn block" type="submit" style="min-height:52px">${icon('check')} ${editing ? 'Salvar alterações' : 'Criar pedido'}</button>
    </form>
    <datalist id="dl-clients">${clients.map((c) => html`<option value="${c.name}">`)}</datalist>`);

  const box = $('[data-lines]', el);
  const drawLines = () => {
    box.innerHTML = String(html`${lines.map((l, i) => html`
      <div class="line-row" data-i="${i}">
        <label><span class="xs muted">Produto</span><select class="input" data-f="item_id" ${l.packed > 0 ? 'disabled' : ''}>${productOptions(l.item_id)}</select></label>
        <label><span class="xs muted">Quantidade</span><input class="input" data-f="quantity" inputmode="numeric" value="${l.quantity}" placeholder="0"></label>
        <label><span class="xs muted">Preço unitário</span><input class="input" data-f="unit_price" inputmode="decimal" value="${l.unit_price === '' ? '' : String(l.unit_price).replace('.', ',')}" placeholder="R$ 0,00"></label>
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

  // Cliente escolhido (ou novo) e se é de fora de São Luís.
  function clientInfo() {
    const name = form.elements.client_name.value.trim();
    const known = byName.get(name.toLowerCase());
    const city = known ? known.city : form.elements.client_city.value.trim();
    return { name, known, city, outside: outside(city) };
  }

  function updateClient() {
    const c = clientInfo();
    $('[data-city-wrap]', el).classList.toggle('hidden', !c.name || !!c.known);
    $('[data-client-hint]', el).textContent = c.known
      ? `Cliente cadastrado · ${c.known.city || rules.home_city}${c.known.phone ? ` · ${c.known.phone}` : ''}`
      : c.name ? 'Cliente novo: será cadastrado com o pedido.' : 'Escolha da lista ou digite um nome novo (o cliente é cadastrado automaticamente).';
    updateTotal();
  }

  function updateTotal() {
    const total = lines.reduce((a, l) => a + (parseNum(l.quantity) || 0) * (parseNum(l.unit_price) || 0), 0);
    const units = lines.reduce((a, l) => a + (parseNum(l.quantity) || 0), 0);
    const c = clientInfo();
    const warn = [];
    if (rules.min_units > 0 && units < rules.min_units) warn.push(`Pedido mínimo: ${fmtNum(rules.min_units)} unidades (faltam ${fmtNum(rules.min_units - units)}).`);
    if (c.outside && rules.min_value_outside > 0 && total < rules.min_value_outside) {
      warn.push(`Fora de ${rules.home_city} (${c.city}): valor mínimo ${brl(rules.min_value_outside)}.`);
    }
    $('[data-total]', el).innerHTML = String(html`<span>${fmtNum(units)} unidades no total</span><span>Valor do pedido: <b>${brl(total)}</b></span>
      ${warn.map((w) => html`<span class="small late">${w}</span>`)}`);
  }

  $('[data-add]', el).onclick = () => {
    const used = new Set(lines.map((l) => l.item_id));
    const next = products.find((p) => !used.has(p.id)) || products[0];
    lines.push({ id: null, item_id: next ? next.id : null, quantity: '', unit_price: next ? lastPrice(next.id) : '', packed: 0 });
    drawLines();
  };
  const form = $('[data-form]', el);
  if (!order && lines[0].item_id) lines[0].unit_price = lastPrice(lines[0].item_id);
  drawLines();
  form.elements.client_name.addEventListener('input', updateClient);
  form.elements.client_city.addEventListener('input', updateTotal);
  updateClient();
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
    const body = {
      client_name: clientName, client_city: form.elements.client_city.value.trim() || undefined,
      due_date: form.elements.due_date.value || null, notes: form.elements.notes.value, items: payload,
      channel: form.elements.channel.value || null, invoice_number: form.elements.invoice_number.value.trim() || null,
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const send = () => api(editing ? `/orders/${editing}` : '/orders', { method: editing ? 'PUT' : 'POST', body });
    try {
      let saved;
      try {
        saved = await send();
      } catch (err) {
        // Abaixo do mínimo: só a Administração pode liberar (fica registrado como exceção).
        if (!(err.data && err.data.code === 'abaixo_do_minimo' && err.data.pode_liberar)) throw err;
        const ok = await confirmDialog({
          title: 'Pedido abaixo do mínimo',
          body: html`${err.message}<br><br>Liberar este pedido como exceção? Fica registrado no histórico.`,
          confirmText: 'Liberar exceção',
        });
        if (!ok) { btn.disabled = false; return; }
        body.ignore_minimum = true;
        saved = await send();
      }
      payload.forEach((p) => p.unit_price && rememberPrice(p.item_id, String(p.unit_price).replace('.', ',')));
      toast(editing ? 'Pedido atualizado.' : `Pedido #${saved.id} criado.`);
      ctx.go(`#/pedido/${saved.id}`);
    } catch (err) {
      toastError(err);
      btn.disabled = false;
    }
  };
}
