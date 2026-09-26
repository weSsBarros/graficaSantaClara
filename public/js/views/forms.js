// Telas de lançamento: entrada, retirada, contagem (ajuste) e produção (impressão / empacotamento).
import {
  html, api, icon, fmtNum, fmtQty, plural, packText, parseNum, confirmDialog, toast, toastError,
  localInputValue, cap, CATEGORY_LABELS, $, $$,
} from '../lib.js';
import { bindUndo } from './components.js';

const REASONS = ['Uso na máquina', 'Perda / avaria', 'Amostra / teste', 'Uso interno'];

const KINDS = {
  entrada: { title: 'Entrada de material', button: 'Registrar entrada', perm: 'entrada', icon: 'in' },
  retirada: { title: 'Retirada de material', button: 'Registrar retirada', perm: 'retirada', icon: 'out' },
  ajuste: { title: 'Contagem de estoque', button: 'Salvar contagem', perm: 'ajuste', icon: 'count' },
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento local, tudo bem */ } },
};

export async function render(ctx) {
  const { el, me, params, query } = ctx;
  const [items, sugg] = await Promise.all([api('/items'), api('/suggestions')]);
  if (!ctx.isCurrent()) return;
  const byId = new Map(items.map((i) => [i.id, i]));

  let proc = null;
  let kind = params.tipo;
  if (params.id) {
    proc = me.processes.find((x) => x.id === Number(params.id));
    if (!proc) throw new Error('Processo não encontrado.');
    if (!proc.can_run) throw new Error(`Você não tem permissão para registrar ${proc.name.toLowerCase()}.`);
    kind = proc.kind;
  } else {
    if (!KINDS[kind]) throw new Error('Tipo de lançamento desconhecido.');
    if (!me.perms.includes(KINDS[kind].perm)) throw new Error('Você não tem permissão para este lançamento.');
  }
  const isProd = kind === 'impressao' || kind === 'empacotamento';
  const cfg = isProd
    ? { title: `Registrar ${proc.name.toLowerCase()}`, button: `Registrar ${proc.name.toLowerCase()}`, icon: kind === 'impressao' ? 'printer' : 'package' }
    : KINDS[kind];
  ctx.setTitle(cfg.title, { back: true });

  const input = isProd ? byId.get(proc.input_item_id) : null;
  const output = isProd && proc.output_item_id ? byId.get(proc.output_item_id) : null;
  if (isProd && !input) throw new Error('O item usado neste processo está desativado. Fale com a administração.');

  const state = {
    itemId: isProd ? input.id : Number(query.item) || (items[0] && items[0].id),
    unit: 'base',
    when: 'now',
  };
  const currentItem = () => (isProd ? input : byId.get(state.itemId));
  const manager = me.perms.includes('cadastros');
  const minDate = new Date(Date.now() - (manager ? 365 : me.config.max_backdate_days) * 86400000);
  const perKey = proc ? `gsc.perPackage.${proc.id}` : '';

  const unitSeg = (item) =>
    item && item.pack_unit && item.pack_size > 0
      ? html`<div class="seg" role="group" aria-label="Unidade">
          <button type="button" data-unit="base" aria-pressed="${state.unit === 'base'}">${plural(item.unit, 2)}</button>
          <button type="button" data-unit="pack" aria-pressed="${state.unit === 'pack'}">${plural(item.pack_unit, 2)}</button>
        </div>`
      : html`<span class="muted" style="align-self:center;padding:0 6px">${plural(item ? item.unit : '', 2)}</span>`;

  const itemSelect = () => {
    const cats = [...new Set(items.map((i) => i.category))];
    return html`<label class="field"><span>Item</span>
      <select class="input" name="item_id" data-item>
        ${cats.map((c) => html`<optgroup label="${CATEGORY_LABELS[c]}">
          ${items.filter((i) => i.category === c).map((i) => html`<option value="${i.id}" ${i.id === state.itemId ? 'selected' : ''}>${i.name}</option>`)}
        </optgroup>`)}
      </select></label>`;
  };

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

  const qtyField = (label, name = 'quantity', withUnit = true) => html`
    <label class="field"><span>${label}</span>
      <div class="input-group">
        <input class="input big" name="${name}" inputmode="decimal" autocomplete="off" placeholder="0" required>
        ${withUnit ? html`<div data-unit-slot style="display:flex">${unitSeg(currentItem())}</div>` : ''}
      </div>
    </label>`;

  let fields;
  if (kind === 'entrada') {
    fields = html`${itemSelect()}${qtyField('Quantidade que chegou')}
      <div class="calc" data-calc></div>
      <label class="field"><span>Fornecedor <span class="muted">(opcional)</span></span>
        <input class="input" name="supplier" list="dl-suppliers" autocomplete="off" maxlength="120"></label>
      ${whenField()}
      <label class="field"><span>Observação <span class="muted">(opcional)</span></span>
        <textarea class="input" name="note" maxlength="500" placeholder="Ex.: nota fiscal nº 1234"></textarea></label>`;
  } else if (kind === 'retirada') {
    fields = html`${itemSelect()}${qtyField('Quantidade retirada')}
      <div class="calc" data-calc></div>
      <div class="field"><span class="label">Motivo</span>
        <div class="chips" style="flex-wrap:wrap;margin-bottom:8px">${REASONS.map((r, i) => html`<button type="button" class="chip" data-reason="${r}" aria-pressed="${i === 0}">${r}</button>`)}
          <button type="button" class="chip" data-reason="" aria-pressed="false">Outro</button></div>
        <input class="input hidden" name="reason_other" maxlength="120" placeholder="Qual o motivo?">
      </div>
      ${whenField()}
      <label class="field"><span>Observação <span class="muted">(opcional)</span></span>
        <textarea class="input" name="note" maxlength="500"></textarea></label>`;
  } else if (kind === 'ajuste') {
    fields = html`
      <div class="notice info">${icon('info')}<span>Conte o que existe fisicamente agora e digite o total. O sistema calcula a diferença e registra o ajuste no histórico.</span></div>
      ${itemSelect()}${qtyField('Quantidade contada agora')}
      <div class="calc" data-calc></div>
      <label class="field"><span>Observação <span class="muted">(opcional)</span></span>
        <textarea class="input" name="note" maxlength="500" placeholder="Ex.: contagem mensal"></textarea></label>`;
  } else if (kind === 'impressao') {
    fields = html`
      <p class="muted" style="margin-bottom:16px">${input.name} ${icon('arrow')} ${output ? output.name : 'impressa'}</p>
      ${qtyField(`Quanto de ${input.name} você usou?`, 'input_qty')}
      <label class="field"><span>Quantas ${plural(input.unit, 2)} estragaram? <span class="muted">(perda)</span></span>
        <input class="input" name="waste_qty" inputmode="numeric" autocomplete="off" value="0"></label>
      <div class="calc" data-calc></div>
      ${whenField()}
      <label class="field"><span>Observação <span class="muted">(opcional)</span></span>
        <textarea class="input" name="note" maxlength="500"></textarea></label>`;
  } else {
    fields = html`
      <div class="form-grid cols-2">
        <label class="field"><span>Quantos pacotes?</span>
          <input class="input big" name="packages" inputmode="numeric" autocomplete="off" placeholder="0" required></label>
        <label class="field"><span>${cap(plural(input.unit, 2))} em cada pacote</span>
          <input class="input big" name="per_package" inputmode="numeric" autocomplete="off" placeholder="0" value="${store.get(perKey) || ''}" required></label>
      </div>
      <label class="field"><span>${cap(plural(input.unit, 2))} estragadas <span class="muted">(perda, se houver)</span></span>
        <input class="input" name="waste_qty" inputmode="numeric" autocomplete="off" value="0"></label>
      <div class="calc" data-calc></div>
      <label class="field"><span>Cliente <span class="muted">(opcional)</span></span>
        <input class="input" name="client" list="dl-clients" autocomplete="off" maxlength="120"></label>
      ${whenField()}
      <label class="field"><span>Observação <span class="muted">(opcional)</span></span>
        <textarea class="input" name="note" maxlength="500"></textarea></label>`;
  }

  el.innerHTML = String(html`
    <div class="page-title"><h1>${cfg.title}</h1></div>
    <form class="card" data-form style="max-width:640px" novalidate>
      ${fields}
      <button class="btn block" type="submit" style="min-height:54px;font-size:1.05rem">${icon(cfg.icon)} ${cfg.button}</button>
    </form>
    <datalist id="dl-suppliers">${sugg.suppliers.map((s) => html`<option value="${s}">`)}</datalist>
    <datalist id="dl-clients">${sugg.clients.map((s) => html`<option value="${s}">`)}</datalist>`);

  const form = $('[data-form]', el);
  const calc = $('[data-calc]', el);
  const val = (name) => (form.elements[name] ? form.elements[name].value : '');

  // Calcula tudo em unidade base a partir do que foi digitado.
  function compute() {
    const item = currentItem();
    const toBase = (n) => (state.unit === 'pack' && item.pack_size ? n * item.pack_size : n);
    if (kind === 'impressao') {
      const used = toBase(parseNum(val('input_qty')));
      const waste = parseNum(val('waste_qty')) || 0;
      return { item, used, waste, good: used - waste, after: item.quantity - used };
    }
    if (kind === 'empacotamento') {
      const packages = parseNum(val('packages'));
      const per = parseNum(val('per_package'));
      const waste = parseNum(val('waste_qty')) || 0;
      const packed = packages * per;
      return { item, packages, per, waste, packed, used: packed + waste, after: item.quantity - packed - waste };
    }
    const q = toBase(parseNum(val('quantity')));
    if (kind === 'entrada') return { item, q, after: item.quantity + q };
    if (kind === 'retirada') return { item, q, after: item.quantity - q };
    return { item, q, after: q, diff: q - item.quantity };
  }

  const balanceLine = (item, after) =>
    html`<span class="small muted">Saldo de ${item.name}: ${fmtNum(item.quantity)} → <b class="num" style="color:${after < 0 ? 'var(--critical-ink)' : 'inherit'}">${fmtNum(after)}</b></span>`;

  function updateCalc() {
    const c = compute();
    const u = c.item.unit;
    let main = '';
    if (kind === 'impressao') {
      if (!(c.used > 0)) main = html`<span class="muted">Digite quanto foi usado.</span>`;
      else if (c.waste > c.used) main = html`<span style="color:var(--critical-ink)">A perda é maior que o total usado.</span>`;
      else {
        main = html`<span>Saem <b>${fmtQty(c.good, (output || c.item).unit)}</b> ${output ? `de ${output.name}` : 'boas'}
          ${c.waste > 0 ? html`<br><span class="small muted">Perda: ${fmtNum((100 * c.waste) / c.used, 1)}%</span>` : ''}</span>`;
      }
      calc.innerHTML = String(html`${main}${c.used > 0 ? balanceLine(c.item, c.after) : ''}`);
      return;
    }
    if (kind === 'empacotamento') {
      main = c.packed > 0
        ? html`<span>Total: <b>${fmtQty(c.packed, u)}</b> em ${fmtNum(c.packages)} ${plural('pacote', c.packages)}</span>`
        : html`<span class="muted">Digite o número de pacotes e quantas ${plural(u, 2)} vão em cada um.</span>`;
      calc.innerHTML = String(html`${main}${c.packed > 0 ? balanceLine(c.item, c.after) : ''}`);
      return;
    }
    if (!(c.q >= 0) || val('quantity') === '') {
      calc.innerHTML = String(html`<span class="muted">Saldo atual: <b>${fmtQty(c.item.quantity, u)}</b>${packText(c.item, c.item.quantity) ? ` (${packText(c.item, c.item.quantity)})` : ''}</span>`);
      return;
    }
    if (kind === 'ajuste') {
      const d = c.diff;
      main = html`<span>Sistema: ${fmtQty(c.item.quantity, u)} · Contado: <b>${fmtQty(c.q, u)}</b></span>
        <span class="small">${d === 0 ? 'Confere, sem diferença.' : html`Diferença: <b>${d > 0 ? '+' : ''}${fmtNum(d)}</b> ${plural(u, d)}`}</span>`;
    } else {
      main = html`<span><b>${fmtQty(c.q, u)}</b>${state.unit === 'pack' ? '' : packText(c.item, c.q) ? ` (${packText(c.item, c.q)})` : ''}</span>${balanceLine(c.item, c.after)}`;
    }
    calc.innerHTML = String(main);
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
  bindUnitSeg();

  const itemSel = $('[data-item]', el);
  if (itemSel) {
    itemSel.onchange = () => {
      state.itemId = Number(itemSel.value);
      state.unit = 'base';
      $('[data-unit-slot]', el).innerHTML = String(unitSeg(currentItem()));
      bindUnitSeg();
      updateCalc();
    };
  }

  let reason = REASONS[0];
  $$('[data-reason]', el).forEach((b) => {
    b.onclick = () => {
      reason = b.dataset.reason;
      $$('[data-reason]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const other = form.elements.reason_other;
      other.classList.toggle('hidden', reason !== '');
      if (reason === '') other.focus();
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
  const first = form.querySelector('.input.big');
  if (first && matchMedia('(pointer: fine)').matches) first.focus();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const c = compute();
    const item = c.item;
    const u = item.unit;
    const body = { note: val('note') || undefined };
    if (state.when === 'other') {
      if (!val('occurred_at')) return toast('Escolha a data e a hora.', { error: true });
      body.occurred_at = val('occurred_at');
    }
    let lines = [];
    let url;

    if (kind === 'impressao') {
      if (!(c.used > 0)) return toast('Digite quanto foi usado.', { error: true });
      if (!(c.waste >= 0) || c.waste > c.used) return toast('Confira a perda.', { error: true });
      url = '/ops/producao';
      Object.assign(body, { process_id: proc.id, input_qty: parseNum(val('input_qty')), input_unit: state.unit, waste_qty: c.waste });
      lines = [
        html`Usou: <b>${fmtQty(c.used, u)}</b>${packText(item, c.used) ? ` (${packText(item, c.used)})` : ''} de ${item.name}`,
        html`Perda: <b>${fmtQty(c.waste, u)}</b>`,
        html`Resultado: <b>${fmtQty(c.good, (output || item).unit)}</b> ${output ? `de ${output.name}` : 'boas'}`,
      ];
    } else if (kind === 'empacotamento') {
      if (!(c.packages > 0) || !Number.isInteger(c.packages)) return toast('Digite o número de pacotes (inteiro).', { error: true });
      if (!(c.per > 0)) return toast(`Digite quantas ${plural(u, 2)} vão em cada pacote.`, { error: true });
      if (!(c.waste >= 0)) return toast('Confira a perda.', { error: true });
      url = '/ops/producao';
      Object.assign(body, { process_id: proc.id, packages: c.packages, per_package: c.per, waste_qty: c.waste, client: val('client') || undefined });
      store.set(perKey, String(c.per));
      lines = [
        html`<b>${fmtNum(c.packages)} ${plural('pacote', c.packages)}</b> × ${fmtQty(c.per, u)} = <b>${fmtQty(c.packed, u)}</b>`,
        c.waste > 0 ? html`Perda: <b>${fmtQty(c.waste, u)}</b>` : '',
        val('client') ? html`Cliente: <b>${val('client')}</b>` : '',
      ];
    } else {
      if (!(c.q > 0) && !(kind === 'ajuste' && c.q === 0 && val('quantity') !== '')) {
        return toast('Digite a quantidade.', { error: true });
      }
      url = `/ops/${kind}`;
      Object.assign(body, { item_id: item.id, unit: state.unit });
      if (kind === 'ajuste') body.counted = parseNum(val('quantity'));
      else body.quantity = parseNum(val('quantity'));
      const qtyText = html`<b>${fmtQty(c.q, u)}</b>${packText(item, c.q) ? ` (${packText(item, c.q)})` : ''} de ${item.name}`;
      if (kind === 'entrada') {
        body.supplier = val('supplier') || undefined;
        lines = [html`Entrada de ${qtyText}`, body.supplier ? html`Fornecedor: <b>${body.supplier}</b>` : ''];
      } else if (kind === 'retirada') {
        body.reason = reason || val('reason_other').trim();
        if (!body.reason) return toast('Escreva o motivo da retirada.', { error: true });
        lines = [html`Retirada de ${qtyText}`, html`Motivo: <b>${body.reason}</b>`];
      } else {
        lines = [html`Contado: ${qtyText}`, html`No sistema: ${fmtQty(item.quantity, u)} (diferença ${c.diff > 0 ? '+' : ''}${fmtNum(c.diff)})`];
      }
    }
    if (state.when === 'other') lines.push(html`Quando: <b>${new Date(body.occurred_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</b>`);

    const negative = kind !== 'entrada' && kind !== 'ajuste' && c.after < 0;
    const ok = await confirmDialog({
      title: 'Confira antes de salvar',
      body: html`${lines.filter(Boolean).map((l) => html`<p style="margin:4px 0;color:var(--text)">${l}</p>`)}
        ${negative ? html`<div class="notice warn" style="margin:12px 0 0">${icon('alert')}<span>O sistema só tem <b>${fmtQty(item.quantity, u)}</b> de ${item.name}.
          Se salvar, o saldo fica negativo — provavelmente falta lançar uma entrada. A administração será avisada pelo histórico.</span></div>` : ''}`,
      confirmText: 'Salvar',
    });
    if (!ok) return;

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api(url, { method: 'POST', body });
      showSuccess(res);
    } catch (err) {
      toastError(err);
      btn.disabled = false;
    }
  };

  function showSuccess(res) {
    const op = res.operation;
    el.innerHTML = String(html`
      <div class="card success" style="max-width:640px">
        <div class="big-ico">${icon('check')}</div>
        <h2>Registrado!</h2>
        <p class="muted" style="margin-top:6px">${op.summary}</p>
        ${res.warnings.map((w) => html`<div class="notice warn" style="margin:14px 0 0;text-align:left">${icon('alert')}<span>${w}</span></div>`)}
        <div class="row wrap" style="justify-content:center;margin-top:20px" data-ops>
          <button class="btn" data-again>Registrar outro</button>
          <a class="btn secondary" href="#/">Ir para o início</a>
          ${op.can_undo ? html`<button class="btn danger" data-undo="${op.id}">${icon('undo')} Desfazer</button>` : ''}
        </div>
      </div>`);
    $('[data-again]', el).onclick = () => render(ctx);
    bindUndo($('[data-ops]', el), () => ctx.go('#/'));
  }
}
