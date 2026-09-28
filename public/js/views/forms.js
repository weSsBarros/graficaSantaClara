// Telas de lançamento: entrada, retirada, contagem (ajuste), impressão e empacotamento.
import {
  html, api, icon, fmtNum, fmtQty, plural, packText, parseNum, confirmDialog, toast, toastError,
  localInputValue, brl, colorDot, fmtDay, todayStr, hasPerm, CATEGORY_LABELS, $, $$,
} from '../lib.js';
import { bindUndo } from './components.js';
import { scanBarcode } from '../scanner.js';

const REASONS = ['Uso na máquina', 'Perda / avaria', 'Amostra / teste', 'Uso interno'];
const PAYMENT_METHODS = ['Pix', 'Dinheiro', 'Boleto', 'Cartão de débito', 'Cartão de crédito', 'Transferência', 'Cheque', 'Outro'];

const KINDS = {
  entrada: { title: 'Entrada de material', button: 'Registrar entrada', perm: 'entrada', icon: 'in' },
  retirada: { title: 'Retirada de material', button: 'Registrar retirada', perm: 'retirada', icon: 'out' },
  ajuste: { title: 'Contagem de estoque', button: 'Salvar contagem', perm: 'ajuste', icon: 'count' },
  impressao: { title: 'Impressão ou corte', button: 'Registrar produção', perm: 'impressao', icon: 'printer' },
  empacotamento: { title: 'Registrar empacotamento', button: 'Registrar empacotamento', perm: 'empacotamento', icon: 'package' },
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento local, tudo bem */ } },
};

const qtyWithPack = (item, n) => html`<b>${fmtQty(n, item.unit)}</b>${packText(item, n) ? ` (${packText(item, n)})` : ''}`;

export async function render(ctx) {
  const { el, me, params, query } = ctx;
  const kind = params.tipo;
  const cfg = KINDS[kind];
  if (!cfg) throw new Error('Tipo de lançamento desconhecido.');
  if (!hasPerm(me, cfg.perm)) throw new Error('Você não tem permissão para este lançamento.');
  ctx.setTitle(cfg.title, { back: true });

  const [items, sugg, packable] = await Promise.all([
    api('/items'),
    api('/suggestions'),
    kind === 'empacotamento' ? api('/packable-orders') : Promise.resolve([]),
  ]);
  if (!ctx.isCurrent()) return;
  const byId = new Map(items.map((i) => [i.id, i]));
  const products = items.filter((i) => i.source === 'producao');
  const papers = items.filter((i) => i.source === 'compra' && i.category === 'papel');
  const consumables = items.filter((i) => ['chapa', 'tinta'].includes(i.category));
  const finance = hasPerm(me, 'financeiro');
  const manager = me.manager;
  const minDate = new Date(Date.now() - (manager ? 365 : me.config.max_backdate_days) * 86400000);

  const state = {
    itemId: Number(query.item) || (items[0] && items[0].id),
    unit: 'base',
    when: 'now',
    paid: true,
    reason: REASONS[0],
    productId: Number(query.produto) || Number(store.get('gsc.lastProduct')) || (products[0] && products[0].id),
    paperId: null,
    orderId: query.pedido ? Number(query.pedido) : packable.length ? packable[0].id : 0,
    lineId: null,
  };
  if (!byId.has(state.productId) && products[0]) state.productId = products[0].id;
  if (kind === 'empacotamento' && state.orderId && !packable.some((o) => o.id === state.orderId)) state.orderId = packable.length ? packable[0].id : 0;

  const currentOrder = () => packable.find((o) => o.id === state.orderId) || null;
  const currentLine = () => {
    const o = currentOrder();
    if (!o) return null;
    return o.items.find((l) => l.id === state.lineId) || o.items.find((l) => l.remaining > 0) || o.items[0];
  };
  const product = () => {
    if (kind === 'empacotamento' && currentLine()) return byId.get(currentLine().item_id) || { id: currentLine().item_id, name: currentLine().item_name, unit: currentLine().unit, quantity: currentLine().stock };
    return byId.get(state.productId);
  };
  const paper = () => {
    const p = product();
    return byId.get(state.paperId || (p && p.made_from_item_id)) || null;
  };
  // Item cuja quantidade o campo principal mede (para a troca folhas/resmas).
  const measured = () => (kind === 'impressao' ? paper() : kind === 'empacotamento' ? product() : byId.get(state.itemId));

  // ---------- pedaços do formulário ----------

  const unitSeg = (item) =>
    item && item.pack_unit && item.pack_size > 0
      ? html`<div class="seg" role="group" aria-label="Unidade">
          <button type="button" data-unit="base" aria-pressed="${state.unit === 'base'}">${plural(item.unit, 2)}</button>
          <button type="button" data-unit="pack" aria-pressed="${state.unit === 'pack'}">${plural(item.pack_unit, 2)}</button>
        </div>`
      : html`<span class="muted" style="align-self:center;padding:0 6px">${plural(item ? item.unit : '', 2)}</span>`;

  const itemSelect = () => html`
    <div class="field"><span class="label">Item</span>
      <div class="input-group">
        <select class="input" name="item_id" data-item>
          ${Object.keys(CATEGORY_LABELS).filter((c) => items.some((i) => i.category === c)).map((c) => html`<optgroup label="${CATEGORY_LABELS[c]}">
            ${items.filter((i) => i.category === c).map((i) => html`<option value="${i.id}" ${i.id === state.itemId ? 'selected' : ''}>${i.name}</option>`)}
          </optgroup>`)}
        </select>
        ${kind === 'entrada' ? html`<button type="button" class="btn secondary" data-scan title="Ler código de barras">${icon('scan')}<span class="sr-only">Ler código de barras</span></button>` : ''}
      </div></div>`;

  const whenField = () => html`
    <div class="field">
      <span class="label">Quando aconteceu?</span>
      <div class="seg" role="group" aria-label="Quando">
        <button type="button" data-when="now" aria-pressed="true">Agora</button>
        <button type="button" data-when="other" aria-pressed="false">Outro dia ou horário</button>
      </div>
      <input class="input hidden" style="margin-top:10px" type="datetime-local" name="occurred_at" data-when-input
        min="${localInputValue(minDate)}" max="${localInputValue()}">
    </div>`;

  const qtyField = (label, name = 'quantity') => html`
    <label class="field"><span data-qty-label>${label}</span>
      <div class="input-group">
        <input class="input big" name="${name}" inputmode="decimal" autocomplete="off" placeholder="0" required>
        <div data-unit-slot style="display:flex">${unitSeg(measured())}</div>
      </div>
    </label>`;

  const noteField = (ph = '') => html`<label class="field"><span>Observação <span class="muted">(opcional)</span></span>
    <textarea class="input" name="note" maxlength="500" placeholder="${ph}"></textarea></label>`;

  const perSheet = (p) => (p && p.yield_per_sheet > 0 ? p.yield_per_sheet : 1);
  const madeFromText = (p) => {
    const base = byId.get(p.made_from_item_id);
    const n = fmtNum(perSheet(p));
    return base && base.source === 'producao' ? `${n} por folha de ${base.name}` : `${n} por folha`;
  };
  const productPick = () => html`<div class="field"><span class="label">O que foi produzido?</span>
    <div class="pick">${products.map((p) => html`
      <button type="button" data-product="${p.id}" aria-pressed="${p.id === state.productId}">${colorDot(p)}${p.name}
        <small>${madeFromText(p)} · ${fmtNum(p.quantity)} em estoque</small></button>`)}
    </div></div>`;

  // É corte (e não impressão) quando o material de origem é outro produto: Amarelo grande → Amarelo pequeno.
  const isCut = () => !!(paper() && paper().source === 'producao');
  const paperField = () => {
    const pp = paper();
    const p = product();
    const base = p && byId.get(p.made_from_item_id);
    const options = [...(base && !papers.includes(base) ? [base] : []), ...papers];
    return html`<div class="field" data-paper>
      <span class="label">${isCut() ? 'Cortado de' : 'Papel usado'}</span>
      <select class="input" name="paper_id" data-paper-select>
        ${!pp ? html`<option value="">Escolha o papel</option>` : ''}
        ${options.map((i) => html`<option value="${i.id}" ${pp && pp.id === i.id ? 'selected' : ''}>${i.name} — ${fmtNum(i.quantity)} ${plural(i.unit, i.quantity)} em estoque</option>`)}
      </select></div>`;
  };
  const inputLabel = () => (isCut() ? `Quantas folhas de ${paper().name} você cortou?` : 'Quantas folhas brancas você usou?');

  const extrasField = () => (consumables.length ? html`
    <div class="field" data-extras><span class="label">Usou chapa ou tinta nesta impressão? <span class="muted">(opcional)</span></span>
      <div class="extras">${consumables.map((c) => html`
        <div class="row"><label for="extra-${c.id}">${colorDot(c)}${c.name} <span class="xs muted">(${fmtNum(c.quantity)} em estoque)</span></label>
          <input class="input" id="extra-${c.id}" data-extra="${c.id}" inputmode="decimal" placeholder="0" style="width:110px">
          <span class="small muted" style="width:56px">${plural(c.unit, 2)}</span></div>`)}
      </div></div>` : '');

  const orderPick = () => html`<div class="field"><span class="label">Para qual pedido?</span>
    <div class="pick">
      ${packable.map((o) => html`<button type="button" data-order="${o.id}" aria-pressed="${o.id === state.orderId}">
        #${o.id} ${o.client_name}
        <small>${o.due_date ? html`entrega ${fmtDay(o.due_date)}${o.late ? html` · <span class="late">atrasado</span>` : ''}` : 'sem data'} · faltam ${fmtNum(o.quantity_total - o.packed_total)}</small></button>`)}
      <button type="button" data-order="0" aria-pressed="${state.orderId === 0}">Sem pedido<small>estoque ou avulso</small></button>
    </div></div>`;

  const linePick = () => {
    const o = currentOrder();
    if (!o) {
      return html`${productPickSimple()}<label class="field"><span>Cliente <span class="muted">(opcional)</span></span>
        <input class="input" name="client" list="dl-clients" autocomplete="off" maxlength="120"></label>`;
    }
    const line = currentLine();
    return html`<div class="field"><span class="label">Qual produto do pedido #${o.id}?</span>
      <div class="pick">${o.items.map((l) => html`<button type="button" data-line="${l.id}" aria-pressed="${line && l.id === line.id}">
        ${l.item_name}<small>${l.remaining > 0 ? `faltam ${fmtNum(l.remaining)} de ${fmtNum(l.quantity)}` : 'completo'}</small></button>`)}</div></div>`;
  };

  // Sem pedido: qualquer produto vendido (inclusive o papel branco, que também é vendido assim).
  const productPickSimple = () => html`<label class="field"><span>Produto</span>
    <select class="input" data-product-select>${[...products, ...papers].map((p) => html`<option value="${p.id}" ${p.id === state.productId ? 'selected' : ''}>${p.name} — ${fmtNum(p.quantity)} em estoque</option>`)}</select></label>`;

  const costFields = () => (finance ? html`
    <fieldset class="group"><legend>Valor da compra <span class="muted small">(opcional)</span></legend>
      <div class="form-grid cols-2">
        <label class="field"><span>Valor total pago (R$)</span><input class="input" name="total_cost" inputmode="decimal" placeholder="0,00" autocomplete="off">
          <span class="hint" data-unitcost></span></label>
        <div class="field"><span class="label">Já foi pago?</span>
          <div class="seg" role="group"><button type="button" data-paid="1" aria-pressed="true">Sim</button><button type="button" data-paid="0" aria-pressed="false">Não, vou pagar</button></div></div>
        <label class="field hidden" data-due><span>Vencimento</span><input class="input" type="date" name="due_date" value="${todayStr(30)}"></label>
        <label class="field"><span>Forma de pagamento</span><select class="input" name="payment_method"><option value="">—</option>
          ${PAYMENT_METHODS.map((m) => html`<option>${m}</option>`)}</select></label>
      </div>
      <p class="hint" style="margin:-6px 0 14px">Com valor, a compra entra no Financeiro como despesa e o sistema calcula o custo por folha.</p>
    </fieldset>` : '');

  // ---------- montagem ----------

  let fields;
  if (kind === 'entrada') {
    fields = html`${itemSelect()}${qtyField('Quantidade que chegou')}<div class="calc" data-calc></div>
      <label class="field"><span>Fornecedor <span class="muted">(opcional)</span></span>
        <input class="input" name="supplier" list="dl-suppliers" autocomplete="off" maxlength="120"></label>
      ${costFields()}${whenField()}${noteField('Ex.: nota fiscal nº 1234')}`;
  } else if (kind === 'retirada') {
    fields = html`${itemSelect()}${qtyField('Quantidade retirada')}<div class="calc" data-calc></div>
      <div class="field"><span class="label">Motivo</span>
        <div class="chips" style="flex-wrap:wrap;margin-bottom:8px">${REASONS.map((r, i) => html`<button type="button" class="chip" data-reason="${r}" aria-pressed="${i === 0}">${r}</button>`)}
          <button type="button" class="chip" data-reason="" aria-pressed="false">Outro</button></div>
        <input class="input hidden" name="reason_other" maxlength="120" placeholder="Qual o motivo?">
      </div>${whenField()}${noteField()}`;
  } else if (kind === 'ajuste') {
    fields = html`<div class="notice info">${icon('info')}<span>Conte o que existe fisicamente agora e digite o total. O sistema calcula a diferença e registra o ajuste no histórico.</span></div>
      ${itemSelect()}${qtyField('Quantidade contada agora')}<div class="calc" data-calc></div>${noteField('Ex.: contagem mensal')}`;
  } else if (kind === 'impressao') {
    if (!products.length) throw new Error('Nenhum produto impresso cadastrado. Peça à administração para cadastrar em Configurações → Itens.');
    fields = html`${productPick()}<div data-paper-slot>${paperField()}</div>
      ${qtyField(inputLabel(), 'input_qty')}
      <label class="field"><span data-waste-label>Quantas saíram ruins? <span class="muted">(depois de cortar e separar)</span></span>
        <input class="input" name="waste_qty" inputmode="numeric" autocomplete="off" value="0"></label>
      <div class="calc" data-calc></div>${extrasField()}${whenField()}${noteField()}`;
  } else {
    if (!products.length) throw new Error('Nenhum produto impresso cadastrado.');
    fields = html`${orderPick()}<div data-line-slot>${linePick()}</div>
      <div class="form-grid cols-2">
        <label class="field"><span>Quantos pacotes?</span>
          <input class="input big" name="packages" inputmode="numeric" autocomplete="off" placeholder="0" required></label>
        <label class="field"><span>Quantas em cada pacote</span>
          <input class="input big" name="per_package" inputmode="numeric" autocomplete="off" placeholder="0" required></label>
      </div>
      <div class="chips" data-per-chips style="margin:-6px 0 14px"></div>
      <label class="field"><span>Quantas estragaram <span class="muted">(perda, se houver)</span></span>
        <input class="input" name="waste_qty" inputmode="numeric" autocomplete="off" value="0"></label>
      <div class="calc" data-calc></div>${whenField()}${noteField()}`;
  }

  el.innerHTML = String(html`
    <div class="page-title"><h1>${cfg.title}</h1></div>
    <form class="card" data-form style="max-width:720px" novalidate>
      ${fields}
      <button class="btn block" type="submit" style="min-height:54px;font-size:1.05rem">${icon(cfg.icon)} ${cfg.button}</button>
    </form>
    <datalist id="dl-suppliers">${sugg.suppliers.map((s) => html`<option value="${s}">`)}</datalist>
    <datalist id="dl-clients">${sugg.clients.map((s) => html`<option value="${s}">`)}</datalist>`);

  const form = $('[data-form]', el);
  const calc = $('[data-calc]', el);
  const val = (name) => (form.elements[name] ? form.elements[name].value : '');

  const perKey = () => `gsc.perPackage.${product() ? product().id : 0}`;
  const packSizes = () => String((product() && product().package_sizes) || '').split(',').filter(Boolean);
  function fillPerPackage() {
    const input = form.elements.per_package;
    if (!input) return;
    if (!input.value) input.value = store.get(perKey()) || packSizes()[0] || '';
    const chips = $('[data-per-chips]', el);
    chips.innerHTML = String(html`${packSizes().map((n) => html`<button type="button" class="chip" data-per="${n}" aria-pressed="${input.value === n}">Pacote de ${fmtNum(Number(n))}</button>`)}`);
    $$('[data-per]', chips).forEach((b) => {
      b.onclick = () => {
        input.value = b.dataset.per;
        $$('[data-per]', chips).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        updateCalc();
      };
    });
  }

  function refreshUnit() {
    state.unit = 'base';
    const slot = $('[data-unit-slot]', el);
    if (slot) slot.innerHTML = String(unitSeg(measured()));
    bindUnitSeg();
  }

  // Calcula tudo em unidade base a partir do que foi digitado.
  function compute() {
    const m = measured();
    const toBase = (n) => (m && state.unit === 'pack' && m.pack_size ? n * m.pack_size : n);
    if (kind === 'impressao') {
      const used = toBase(parseNum(val('input_qty')));
      const waste = parseNum(val('waste_qty')) || 0;
      const expected = used * perSheet(product());
      return { item: m, used, waste, expected, good: expected - waste, after: m ? m.quantity - used : 0 };
    }
    if (kind === 'empacotamento') {
      const packages = parseNum(val('packages'));
      const per = parseNum(val('per_package'));
      const waste = parseNum(val('waste_qty')) || 0;
      const packed = packages * per;
      return { item: m, packages, per, waste, packed, used: packed + waste, after: m.quantity - packed - waste };
    }
    const q = toBase(parseNum(val('quantity')));
    if (kind === 'entrada') return { item: m, q, after: m.quantity + q };
    if (kind === 'retirada') return { item: m, q, after: m.quantity - q };
    return { item: m, q, after: q, diff: q - m.quantity };
  }

  const balanceLine = (item, after) =>
    html`<span class="small muted">Saldo de ${item.name}: ${fmtNum(item.quantity)} → <b class="num" style="color:${after < 0 ? 'var(--critical-ink)' : 'inherit'}">${fmtNum(after)}</b></span>`;

  function updateCalc() {
    const c = compute();
    const item = c.item;
    if (kind === 'impressao') {
      const p = product();
      if (!item) calc.innerHTML = String(html`<span class="muted">Escolha o papel usado.</span>`);
      else if (!(c.used > 0)) calc.innerHTML = String(html`<span class="muted">Digite quantas folhas brancas foram usadas.</span>${balanceLine(item, item.quantity)}`);
      else if (c.waste > c.expected) calc.innerHTML = String(html`<span style="color:var(--critical-ink)">A perda é maior que o total produzido (${fmtQty(c.expected, p.unit)}).</span>`);
      else {
        calc.innerHTML = String(html`<span>${perSheet(p) !== 1 ? html`${fmtNum(c.used)} ${plural(item.unit, c.used)} × ${fmtNum(perSheet(p))} = ${fmtNum(c.expected)}<br>` : ''}
          Ficam <b>${fmtQty(c.good, p.unit)}</b> boas de ${p.name}
          ${c.waste > 0 ? html`<br><span class="small muted">Perda: ${fmtQty(c.waste, p.unit)} (${fmtNum((100 * c.waste) / c.expected, 1)}%)</span>` : ''}</span>${balanceLine(item, c.after)}`);
      }
      return;
    }
    if (kind === 'empacotamento') {
      const line = currentLine();
      let main = c.packed > 0
        ? html`<span>Total: <b>${fmtQty(c.packed, item.unit)}</b> em ${fmtNum(c.packages)} ${plural('pacote', c.packages)}</span>`
        : html`<span class="muted">Digite o número de pacotes e quantas vão em cada um.</span>`;
      if (line && c.packed > 0) {
        const left = line.remaining - c.packed;
        main = html`${main}<span class="small ${left < 0 ? 'late' : 'muted'}">${left > 0 ? `Pedido: faltarão ${fmtNum(left)}` : left === 0 ? 'Completa este produto do pedido' : `Passa ${fmtNum(-left)} do pedido`}</span>`;
      }
      calc.innerHTML = String(html`${main}${c.packed > 0 ? balanceLine(item, c.after) : ''}`);
      return;
    }
    if (!(c.q >= 0) || val('quantity') === '') {
      calc.innerHTML = String(html`<span class="muted">Saldo atual: ${qtyWithPack(item, item.quantity)}</span>`);
    } else if (kind === 'ajuste') {
      const d = c.diff;
      calc.innerHTML = String(html`<span>Sistema: ${fmtQty(item.quantity, item.unit)} · Contado: <b>${fmtQty(c.q, item.unit)}</b></span>
        <span class="small">${d === 0 ? 'Confere, sem diferença.' : html`Diferença: <b>${d > 0 ? '+' : ''}${fmtNum(d)}</b> ${plural(item.unit, d)}`}</span>`);
    } else {
      calc.innerHTML = String(html`<span><b>${fmtQty(c.q, item.unit)}</b>${state.unit === 'pack' ? '' : packText(item, c.q) ? ` (${packText(item, c.q)})` : ''}</span>${balanceLine(item, c.after)}`);
    }
    const uc = $('[data-unitcost]', el);
    if (uc) {
      const total = parseNum(val('total_cost'));
      uc.textContent = total > 0 && c.q > 0 ? `${brl(total / c.q)} por ${item.unit}` : '';
    }
  }

  function bindUnitSeg() {
    $$('[data-unit]', el).forEach((b) => {
      b.onclick = () => {
        state.unit = b.dataset.unit;
        $$('[data-unit]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        updateCalc();
      };
    });
  }

  function bindPicks() {
    $$('[data-product]', el).forEach((b) => {
      b.onclick = () => {
        state.productId = Number(b.dataset.product);
        state.paperId = null;
        $$('[data-product]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('[data-paper-slot]', el).innerHTML = String(paperField());
        bindPaper();
        refreshUnit();
        refreshProduction();
        updateCalc();
      };
    });
    $$('[data-order]', el).forEach((b) => {
      b.onclick = () => {
        state.orderId = Number(b.dataset.order);
        state.lineId = null;
        $$('[data-order]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('[data-line-slot]', el).innerHTML = String(linePick());
        form.elements.per_package.value = '';
        bindPicks();
        fillPerPackage();
        updateCalc();
      };
    });
    $$('[data-line]', el).forEach((b) => {
      b.onclick = () => {
        state.lineId = Number(b.dataset.line);
        $$('[data-line]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        form.elements.per_package.value = '';
        fillPerPackage();
        updateCalc();
      };
    });
    const ps = $('[data-product-select]', el);
    if (ps) {
      ps.onchange = () => {
        state.productId = Number(ps.value);
        form.elements.per_package.value = '';
        fillPerPackage();
        updateCalc();
      };
    }
  }

  function bindPaper() {
    const sel = $('[data-paper-select]', el);
    if (sel) {
      sel.onchange = () => {
        state.paperId = Number(sel.value) || null;
        $('[data-paper-slot]', el).innerHTML = String(paperField());
        bindPaper();
        refreshUnit();
        refreshProduction();
        updateCalc();
      };
    }
  }

  // Impressão x corte: muda a pergunta e esconde chapa/tinta, que não se usa na guilhotina.
  function refreshProduction() {
    if (kind !== 'impressao') return;
    const label = $('[data-qty-label]', el);
    if (label) label.textContent = inputLabel();
    const extras = $('[data-extras]', el);
    if (extras) extras.classList.toggle('hidden', isCut());
  }

  bindUnitSeg();
  bindPicks();
  bindPaper();
  refreshProduction();
  fillPerPackage();

  const itemSel = $('[data-item]', el);
  if (itemSel) {
    itemSel.onchange = () => {
      state.itemId = Number(itemSel.value);
      refreshUnit();
      updateCalc();
    };
  }

  const scanBtn = $('[data-scan]', el);
  if (scanBtn) {
    scanBtn.onclick = async () => {
      const code = await scanBarcode();
      if (!code) return;
      try {
        const found = await api(`/items/barcode/${encodeURIComponent(code)}`);
        state.itemId = found.id;
        itemSel.value = String(found.id);
        refreshUnit();
        updateCalc();
        toast(`${found.name} selecionado.`);
      } catch {
        const cur = byId.get(state.itemId);
        if (hasPerm(me, 'cadastros') && cur && await confirmDialog({
          title: 'Código não cadastrado',
          body: html`O código <b>${code}</b> não está em nenhum item. Quer ligar este código ao item <b>${cur.name}</b>? Nas próximas vezes ele será reconhecido.`,
          confirmText: 'Ligar ao item',
        })) {
          try {
            await api(`/items/${cur.id}`, { method: 'PUT', body: { barcode: code } });
            toast('Código ligado ao item.');
          } catch (err) { toastError(err); }
        } else if (!hasPerm(me, 'cadastros')) {
          toast(`Código ${code} não cadastrado. Peça à administração para ligar ao item.`, { error: true });
        }
      }
    };
  }

  $$('[data-reason]', el).forEach((b) => {
    b.onclick = () => {
      state.reason = b.dataset.reason;
      $$('[data-reason]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const other = form.elements.reason_other;
      other.classList.toggle('hidden', state.reason !== '');
      if (state.reason === '') other.focus();
    };
  });

  $$('[data-paid]', el).forEach((b) => {
    b.onclick = () => {
      state.paid = b.dataset.paid === '1';
      $$('[data-paid]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('[data-due]', el).classList.toggle('hidden', state.paid);
    };
  });

  $$('[data-when]', el).forEach((b) => {
    b.onclick = () => {
      state.when = b.dataset.when;
      $$('[data-when]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const inp = $('[data-when-input]', el);
      inp.classList.toggle('hidden', state.when === 'now');
      if (state.when === 'other') {
        inp.max = localInputValue();
        if (!inp.value) inp.value = localInputValue();
        inp.focus();
      }
    };
  });

  form.addEventListener('input', updateCalc);
  updateCalc();

  // ---------- salvar ----------

  form.onsubmit = async (e) => {
    e.preventDefault();
    const c = compute();
    const item = c.item;
    const body = { note: val('note') || undefined };
    if (state.when === 'other') {
      if (!val('occurred_at')) return toast('Escolha a data e a hora.', { error: true });
      body.occurred_at = val('occurred_at');
    }
    let lines = [];
    const url = `/ops/${kind}`;

    if (kind === 'impressao') {
      const p = product();
      if (!item) return toast('Escolha o papel usado.', { error: true });
      if (!(c.used > 0)) return toast('Digite quanto papel foi usado.', { error: true });
      if (!(c.waste >= 0) || c.waste > c.expected) return toast('Confira a perda.', { error: true });
      const extras = $$('[data-extra]', el)
        .map((x) => ({ item_id: Number(x.dataset.extra), quantity: parseNum(x.value) }))
        .filter((x) => x.quantity > 0);
      if ($$('[data-extra]', el).some((x) => x.value && !(parseNum(x.value) > 0))) return toast('Confira a quantidade de chapa/tinta.', { error: true });
      Object.assign(body, { product_id: p.id, input_item_id: item.id, input_qty: parseNum(val('input_qty')), input_unit: state.unit, waste_qty: c.waste, extras });
      store.set('gsc.lastProduct', String(p.id));
      lines = [
        html`Produto: <b>${p.name}</b>`,
        html`Usou: ${qtyWithPack(item, c.used)} de ${item.name}${perSheet(p) !== 1 ? ` (rende ${fmtNum(perSheet(p))} por folha)` : ''}`,
        html`Perda: <b>${fmtQty(c.waste, p.unit)}</b>`,
        html`Resultado: <b>${fmtQty(c.good, p.unit)}</b> boas`,
        ...extras.map((x) => html`Também usou: <b>${fmtQty(x.quantity, byId.get(x.item_id).unit)}</b> de ${byId.get(x.item_id).name}`),
      ];
    } else if (kind === 'empacotamento') {
      if (!(c.packages > 0) || !Number.isInteger(c.packages)) return toast('Digite o número de pacotes (inteiro).', { error: true });
      if (!(c.per > 0)) return toast('Digite quantas vão em cada pacote.', { error: true });
      if (!(c.waste >= 0)) return toast('Confira a perda.', { error: true });
      const line = currentLine();
      const o = currentOrder();
      Object.assign(body, { packages: c.packages, per_package: c.per, waste_qty: c.waste });
      if (line) body.order_item_id = line.id;
      else Object.assign(body, { product_id: item.id, client: val('client') || undefined });
      store.set(perKey(), String(c.per));
      lines = [
        o ? html`Pedido: <b>#${o.id} ${o.client_name}</b>` : val('client') ? html`Cliente: <b>${val('client')}</b>` : html`Sem pedido`,
        html`Produto: <b>${item.name}</b>`,
        html`<b>${fmtNum(c.packages)} ${plural('pacote', c.packages)}</b> × ${fmtQty(c.per, item.unit)} = <b>${fmtQty(c.packed, item.unit)}</b>`,
        c.waste > 0 ? html`Perda: <b>${fmtQty(c.waste, item.unit)}</b>` : '',
      ];
    } else {
      if (!(c.q > 0) && !(kind === 'ajuste' && c.q === 0 && val('quantity') !== '')) return toast('Digite a quantidade.', { error: true });
      Object.assign(body, { item_id: item.id, unit: state.unit });
      if (kind === 'ajuste') body.counted = parseNum(val('quantity'));
      else body.quantity = parseNum(val('quantity'));
      const qtyText = html`${qtyWithPack(item, c.q)} de ${item.name}`;
      if (kind === 'entrada') {
        body.supplier = val('supplier') || undefined;
        lines = [html`Entrada de ${qtyText}`, body.supplier ? html`Fornecedor: <b>${body.supplier}</b>` : ''];
        const total = parseNum(val('total_cost'));
        if (finance && val('total_cost')) {
          if (!(total > 0)) return toast('Confira o valor pago.', { error: true });
          Object.assign(body, { total_cost: total, paid: state.paid, due_date: state.paid ? undefined : val('due_date'), payment_method: val('payment_method') || undefined });
          lines.push(html`Valor: <b>${brl(total)}</b> (${brl(total / c.q)} por ${item.unit}) — ${state.paid ? 'pago' : `a pagar até ${val('due_date').split('-').reverse().join('/')}`}`);
        }
      } else if (kind === 'retirada') {
        body.reason = state.reason || val('reason_other').trim();
        if (!body.reason) return toast('Escreva o motivo da retirada.', { error: true });
        lines = [html`Retirada de ${qtyText}`, html`Motivo: <b>${body.reason}</b>`];
      } else {
        lines = [html`Contado: ${qtyText}`, html`No sistema: ${fmtQty(item.quantity, item.unit)} (diferença ${c.diff > 0 ? '+' : ''}${fmtNum(c.diff)})`];
      }
    }
    if (state.when === 'other') lines.push(html`Quando: <b>${new Date(body.occurred_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</b>`);

    const negative = kind !== 'entrada' && kind !== 'ajuste' && c.after < 0;
    const ok = await confirmDialog({
      title: 'Confira antes de salvar',
      body: html`${lines.filter(Boolean).map((l) => html`<p style="margin:4px 0;color:var(--text)">${l}</p>`)}
        ${negative ? html`<div class="notice warn" style="margin:12px 0 0">${icon('alert')}<span>O sistema só tem <b>${fmtQty(item.quantity, item.unit)}</b> de ${item.name}.
          Se salvar, o saldo fica negativo — provavelmente falta lançar uma entrada ou uma impressão. Fica registrado no histórico.</span></div>` : ''}`,
      confirmText: 'Salvar',
    });
    if (!ok) return;

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api(url, { method: 'POST', body });
      let orderAfter = null;
      if (res.operation.order_id) orderAfter = await api(`/orders/${res.operation.order_id}`).catch(() => null);
      showSuccess(res, orderAfter);
    } catch (err) {
      toastError(err);
      btn.disabled = false;
    }
  };

  function showSuccess(res, order) {
    const op = res.operation;
    el.innerHTML = String(html`
      <div class="card success" style="max-width:720px">
        <div class="big-ico">${icon('check')}</div>
        <h2>Registrado!</h2>
        <p class="muted" style="margin-top:6px">${op.summary}</p>
        ${order && order.status === 'pronto' ? html`<div class="notice info" style="margin:14px 0 0;text-align:left">${icon('truck')}<span><b>Pedido #${order.id} completo!</b> Está pronto para entrega.</span></div>` : ''}
        ${res.warnings.map((w) => html`<div class="notice warn" style="margin:14px 0 0;text-align:left">${icon('alert')}<span>${w}</span></div>`)}
        <div class="row wrap" style="justify-content:center;margin-top:20px" data-ops>
          <button class="btn" data-again>Registrar outro</button>
          ${order ? html`<a class="btn secondary" href="#/pedido/${order.id}">Ver pedido #${order.id}</a>` : ''}
          <a class="btn secondary" href="#/">Ir para o início</a>
          ${op.can_undo ? html`<button class="btn danger" data-undo="${op.id}">${icon('undo')} Desfazer</button>` : ''}
        </div>
      </div>`);
    $('[data-again]', el).onclick = () => render(ctx);
    bindUndo($('[data-ops]', el), () => ctx.go('#/'));
  }
}
