// Financeiro: resumo do mês, lançamentos (despesas/receitas), contas em aberto e categorias.
import {
  html, api, icon, fmtNum, brl, fmtMonth, fmtDmy, todayStr, parseNum, hasPerm, toast, toastError,
  promptDialog, formDialog, $, $$,
} from '../lib.js';
import { financeChart, categoryChart } from '../charts.js';

const TABS = [
  ['resumo', 'Resumo'],
  ['lancamentos', 'Lançamentos'],
  ['contas', 'Contas em aberto'],
  ['categorias', 'Categorias'],
];
const STATUS_LABELS = { aberto: 'Em aberto', vencido: 'Vencido', pago: 'Pago', cancelado: 'Cancelado' };

const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

export async function render(ctx) {
  const { el, me, params } = ctx;
  if (!hasPerm(me, 'financeiro')) throw new Error('Você não tem permissão para ver o financeiro.');
  const tab = params.tab || 'resumo';
  ctx.setTitle('Financeiro');
  el.innerHTML = String(html`
    <div class="page-title"><h1>Financeiro</h1>
      <div class="row"><button class="btn secondary" data-new="receita">${icon('plus')} Receita</button><button class="btn" data-new="despesa">${icon('plus')} Despesa</button></div></div>
    <nav class="tabs">${TABS.map(([k, l]) => html`<a href="#/financeiro/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</nav>
    <div class="toolbar hide-lg"><button class="btn secondary" data-new="receita">${icon('plus')} Receita</button><button class="btn" data-new="despesa">${icon('plus')} Despesa</button></div>
    <div data-tab></div>`);
  const meta = await api('/finance/categories');
  if (!ctx.isCurrent()) return;
  const box = $('[data-tab]', el);
  const env = { ctx, meta, reload: () => render(ctx) };
  $$('[data-new]', el).forEach((b) => { b.onclick = () => entryForm(env, { kind: b.dataset.new }); });
  if (ctx.query.novo) entryForm(env, { kind: ctx.query.novo === 'receita' ? 'receita' : 'despesa' });
  const views = { resumo: summaryTab, lancamentos: entriesTab, contas: openTab, categorias: categoriesTab };
  await (views[tab] || summaryTab)(box, env);
}

// ---------- formulário de lançamento ----------

async function entryForm(env, entry) {
  const { meta } = env;
  const editing = Boolean(entry.id);
  const kind = entry.kind;
  const cats = meta.categories.filter((c) => c.kind === kind && (c.active || c.id === entry.category_id));
  const v = { date: todayStr(), due_date: '', paid: kind === 'despesa' ? '0' : '1', ...entry };
  const data = await formDialog({
    title: editing ? `Editar ${kind}` : kind === 'despesa' ? 'Nova despesa' : 'Nova receita',
    confirmText: 'Salvar',
    body: html`
      <label class="field"><span>Descrição</span><input class="input" name="description" required maxlength="200" value="${v.description || ''}"
        placeholder="${kind === 'despesa' ? 'Ex.: Chapas (nota 123), conta de luz' : 'Ex.: Venda avulsa'}"></label>
      <div class="form-grid cols-2">
        <label class="field"><span>Valor (R$)</span><input class="input" name="amount" required inputmode="decimal" value="${v.amount ? String(v.amount).replace('.', ',') : ''}" placeholder="0,00"></label>
        <label class="field"><span>Categoria</span><select class="input" name="category_id" required>
          ${cats.map((c) => html`<option value="${c.id}" ${c.id === v.category_id ? 'selected' : ''}>${c.name}</option>`)}</select></label>
        <label class="field"><span>Data</span><input class="input" type="date" name="date" required value="${v.date}"></label>
        <label class="field"><span>Vencimento <span class="muted">(opcional)</span></span><input class="input" type="date" name="due_date" value="${v.due_date || ''}"></label>
        <label class="field"><span>${kind === 'despesa' ? 'Fornecedor' : 'Cliente'} <span class="muted">(opcional)</span></span><input class="input" name="counterparty" maxlength="120" value="${v.counterparty || ''}"></label>
        <label class="field"><span>Forma de pagamento</span><select class="input" name="payment_method"><option value="">—</option>
          ${meta.payment_methods.map((m) => html`<option ${m === v.payment_method ? 'selected' : ''}>${m}</option>`)}</select></label>
      </div>
      ${editing ? '' : html`
        <label class="check"><input type="checkbox" name="paid" value="1" ${v.paid === '1' ? 'checked' : ''}> ${kind === 'despesa' ? 'Já foi paga' : 'Já foi recebida'}</label>
        <label class="field" style="margin-top:8px"><span>Repetir todo mês por</span>
          <select class="input" name="repeat_months">${[1, 2, 3, 4, 6, 12, 24].map((n) => html`<option value="${n}">${n === 1 ? 'Não repetir' : `${n} meses`}</option>`)}</select>
          <span class="hint">Para contas fixas (aluguel, energia, internet). Cria uma conta por mês, em aberto.</span></label>`}
      <label class="field"><span>Observações</span><textarea class="input" name="notes" maxlength="500">${v.notes || ''}</textarea></label>`,
  });
  if (!data) return;
  const amount = parseNum(data.amount);
  if (!(amount > 0)) return toast('Confira o valor.', { error: true });
  const body = { ...data, kind, amount, category_id: Number(data.category_id), paid: data.paid === '1', due_date: data.due_date || null, payment_method: data.payment_method || null };
  try {
    if (editing) await api(`/finance/entries/${entry.id}`, { method: 'PUT', body });
    else await api('/finance/entries', { method: 'POST', body });
    toast('Lançamento salvo.');
    history.replaceState(null, '', location.hash.replace(/[?&]novo=\w+/, ''));
    env.reload();
  } catch (err) { toastError(err); }
}

async function payEntry(env, e) {
  const data = await formDialog({
    title: e.kind === 'despesa' ? 'Registrar pagamento' : 'Registrar recebimento',
    confirmText: e.kind === 'despesa' ? 'Pago' : 'Recebido',
    body: html`<p style="margin-bottom:14px"><b>${e.description}</b> — ${brl(e.amount)}</p>
      <div class="form-grid cols-2">
        <label class="field"><span>Data</span><input class="input" type="date" name="paid_at" value="${todayStr()}" required></label>
        <label class="field"><span>Forma</span><select class="input" name="payment_method"><option value="">—</option>
          ${env.meta.payment_methods.map((m) => html`<option ${m === e.payment_method ? 'selected' : ''}>${m}</option>`)}</select></label>
      </div>`,
  });
  if (!data) return;
  try {
    await api(`/finance/entries/${e.id}/pay`, { method: 'POST', body: { paid_at: data.paid_at, payment_method: data.payment_method || undefined } });
    toast('Registrado.');
    env.reload();
  } catch (err) { toastError(err); }
}

function entryRow(e) {
  const sign = e.kind === 'despesa' ? '−' : '+';
  return html`<li data-id="${e.id}">
    <div class="row between wrap" style="align-items:flex-start">
      <div style="min-width:0;flex:1">
        <b>${e.description}</b>
        <div class="small muted">${e.category_name}${e.counterparty ? ` · ${e.counterparty}` : ''} · ${fmtDmy(e.date)}
          ${e.due_date && !e.paid_at && !e.canceled_at ? html` · vence <span class="${e.status === 'vencido' ? 'late' : ''}">${fmtDmy(e.due_date)}</span>` : ''}
          ${e.paid_at ? ` · ${e.kind === 'despesa' ? 'pago' : 'recebido'} em ${fmtDmy(e.paid_at)}${e.payment_method ? ` (${e.payment_method})` : ''}` : ''}
          ${e.order_id ? html` · <a href="#/pedido/${e.order_id}">pedido #${e.order_id}</a>` : ''}
          ${e.operation_id ? ' · compra de estoque' : ''}</div>
        ${e.canceled_at ? html`<div class="xs muted">Cancelado: ${e.cancel_reason}</div>` : ''}
      </div>
      <div style="text-align:right">
        <div class="money ${e.kind === 'despesa' ? 'neg' : 'pos'}" style="font-weight:700${e.canceled_at ? ';text-decoration:line-through' : ''}">${sign} ${brl(e.amount)}</div>
        <span class="status ${e.status}">${STATUS_LABELS[e.status]}</span>
      </div>
    </div>
    ${e.canceled_at ? '' : html`<div class="tools">
      ${e.paid_at ? html`<button class="btn ghost sm" data-unpay>Desmarcar ${e.kind === 'despesa' ? 'pagamento' : 'recebimento'}</button>`
        : html`<button class="btn sm" data-pay>${icon('check')} ${e.kind === 'despesa' ? 'Pagar' : 'Receber'}</button>`}
      ${e.order_id ? '' : html`<button class="btn ghost sm" data-edit>${icon('edit')} Editar</button>`}
      ${e.order_id ? '' : html`<button class="btn danger sm" data-cancel>Cancelar</button>`}
    </div>`}
  </li>`;
}

function bindEntryActions(box, env, entries) {
  const find = (b) => entries.find((e) => e.id === Number(b.closest('[data-id]').dataset.id));
  $$('[data-pay]', box).forEach((b) => { b.onclick = () => payEntry(env, find(b)); });
  $$('[data-edit]', box).forEach((b) => { b.onclick = () => entryForm(env, find(b)); });
  $$('[data-unpay]', box).forEach((b) => {
    b.onclick = async () => {
      try { await api(`/finance/entries/${find(b).id}/unpay`, { method: 'POST', body: {} }); env.reload(); } catch (err) { toastError(err); }
    };
  });
  $$('[data-cancel]', box).forEach((b) => {
    b.onclick = async () => {
      const e = find(b);
      const reason = await promptDialog({ title: 'Cancelar lançamento?', body: `${e.description} — ${brl(e.amount)}. Ele continua no histórico, marcado como cancelado.`, label: 'Motivo', confirmText: 'Cancelar lançamento', danger: true });
      if (!reason) return;
      try { await api(`/finance/entries/${e.id}/cancel`, { method: 'POST', body: { reason } }); toast('Cancelado.'); env.reload(); } catch (err) { toastError(err); }
    };
  });
}

// ---------- abas ----------

async function summaryTab(box, env) {
  const { ctx } = env;
  let month = ctx.query.mes || todayStr().slice(0, 7);
  const s = await api(`/finance/summary?month=${month}`);
  if (!ctx.isCurrent()) return;
  const o = s.open;
  const upcoming = await api('/finance/entries?status=aberto&kind=despesa&limit=8');
  if (!ctx.isCurrent()) return;
  const mat = s.material;

  box.innerHTML = String(html`
    <div class="row wrap" style="margin-bottom:16px">
      <div class="seg"><button data-m="-1" aria-label="Mês anterior">‹</button><button aria-pressed="true" style="min-width:170px">${fmtMonth(s.month)}</button><button data-m="1" aria-label="Próximo mês">›</button></div>
      <a class="btn ghost sm" href="/api/finance/entries.csv?month=${s.month}">${icon('download')} Planilha do mês</a>
    </div>
    <div class="tiles">
      <div class="tile hero"><p class="label">Resultado do mês</p><div class="value money ${s.resultado >= 0 ? 'pos' : 'neg'}">${brl(s.resultado)}</div>
        <div class="delta">receitas − despesas</div></div>
      <div class="tile"><p class="label">Receitas</p><div class="value">${brl(s.receitas)}</div><div class="delta">recebido no mês: ${brl(s.recebido)}</div></div>
      <div class="tile"><p class="label">Despesas</p><div class="value">${brl(s.despesas)}</div><div class="delta">pago no mês: ${brl(s.pago)}</div></div>
      <a class="tile" href="#/financeiro/contas" style="text-decoration:none;color:inherit"><p class="label">A receber</p><div class="value">${brl(o.receber_total.total)}</div>
        <div class="delta">${o.receber_vencido.count ? html`<span class="down">${o.receber_vencido.count} em atraso</span>` : `${o.receber_total.count} em aberto`}</div></a>
      <a class="tile" href="#/financeiro/contas" style="text-decoration:none;color:inherit"><p class="label">A pagar</p><div class="value">${brl(o.pagar_total.total)}</div>
        <div class="delta">${o.pagar_vencido.count ? html`<span class="down">${o.pagar_vencido.count} vencida(s)</span>` : `${o.pagar_7dias.count} nos próximos 7 dias`}</div></a>
    </div>

    <div class="card section">
      <div class="card-head"><h2>Receitas e despesas</h2><p class="small muted">Últimos 12 meses, pela data de cada lançamento.</p></div>
      <div class="legend"><span><i class="box" style="background:var(--series-1)"></i>Receitas</span><span><i class="box" style="background:var(--series-2)"></i>Despesas</span></div>
      <div class="chart-box"><canvas data-fin aria-label="Gráfico de receitas e despesas por mês"></canvas></div>
      <details class="data-table"><summary>Ver dados em tabela</summary><div class="table-wrap"><table class="table">
        <thead><tr><th>Mês</th><th class="r">Receitas</th><th class="r">Despesas</th><th class="r">Resultado</th></tr></thead>
        <tbody>${[...s.monthly].reverse().map((m) => html`<tr><td>${fmtMonth(m.month)}</td><td class="r">${brl(m.receitas)}</td><td class="r">${brl(m.despesas)}</td>
          <td class="r money ${m.receitas - m.despesas >= 0 ? 'pos' : 'neg'}">${brl(m.receitas - m.despesas)}</td></tr>`)}</tbody></table></div></details>
    </div>

    <div class="grid-2 section">
      <div class="card">
        <div class="card-head"><h2>Despesas por categoria</h2><p class="small muted">${fmtMonth(s.month)}</p></div>
        ${s.by_category.filter((c) => c.kind === 'despesa').length
          ? html`<div class="chart-box"><canvas data-cat aria-label="Gráfico de despesas por categoria"></canvas></div>`
          : html`<div class="empty">Nenhuma despesa neste mês.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Custo de material por folha</h2><p class="small muted">Papel, tinta e chapa usados na produção do mês.</p></div>
        ${mat.per_sheet
          ? html`<div class="hero-qty" style="font-size:2rem">${brl(mat.per_sheet)} <small>por folha impressa${mat.missing_costs.length ? ' (parcial)' : ''}</small></div>
            <p class="small muted" style="margin:4px 0 12px">${brl(mat.total)} em material ÷ ${fmtNum(mat.printed)} folhas impressas</p>`
          : html`<p class="muted" style="margin-bottom:12px">Sem dados suficientes neste mês.</p>`}
        ${mat.items.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Material</th><th class="r">Usado</th><th class="r">Custo unit.</th><th class="r">Total</th></tr></thead>
          <tbody>${mat.items.map((x) => html`<tr><td>${x.name}</td><td class="r">${fmtNum(x.qty)}</td><td class="r">${x.unit_cost === null ? '—' : brl(x.unit_cost)}</td><td class="r">${x.total === null ? '—' : brl(x.total)}</td></tr>`)}</tbody>
        </table></div>` : ''}
        ${mat.missing_costs.length ? html`<p class="xs muted" style="margin-top:8px">Sem custo conhecido: ${mat.missing_costs.join(', ')}. Informe o valor pago nas próximas entradas desses itens.</p>` : ''}
      </div>
    </div>

    <div class="card section">
      <div class="card-head"><h2>Próximas contas a pagar</h2><a class="small" href="#/financeiro/contas">Ver todas</a></div>
      ${upcoming.entries.length ? html`<ul class="list" data-list>${upcoming.entries.map(entryRow)}</ul>` : html`<div class="empty">Nenhuma conta em aberto.</div>`}
    </div>`);

  $$('[data-m]', box).forEach((b) => {
    b.onclick = () => {
      month = shiftMonth(s.month, Number(b.dataset.m));
      history.replaceState(null, '', `#/financeiro/resumo?mes=${month}`);
      ctx.query.mes = month;
      summaryTab(box, env);
    };
  });
  financeChart($('[data-fin]', box), s.monthly);
  const cat = $('[data-cat]', box);
  if (cat) categoryChart(cat, s.by_category.filter((c) => c.kind === 'despesa'));
  const list = $('[data-list]', box);
  if (list) bindEntryActions(list, env, upcoming.entries);
}

async function entriesTab(box, env) {
  const { ctx, meta } = env;
  const f = { kind: '', status: '', month: todayStr().slice(0, 7), category_id: '', q: '' };
  box.innerHTML = String(html`
    <form class="filters" data-filters>
      <label><span>Tipo</span><select class="input" name="kind"><option value="">Todos</option><option value="despesa">Despesas</option><option value="receita">Receitas</option></select></label>
      <label><span>Situação</span><select class="input" name="status"><option value="">Todas</option>
        ${Object.entries(STATUS_LABELS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
      <label><span>Mês</span><input class="input" type="month" name="month" value="${f.month}"></label>
      <label><span>Categoria</span><select class="input" name="category_id"><option value="">Todas</option>
        ${meta.categories.map((c) => html`<option value="${c.id}">${c.kind === 'despesa' ? 'Despesa' : 'Receita'}: ${c.name}</option>`)}</select></label>
      <label><span>Buscar</span><input class="input" type="search" name="q" placeholder="Descrição ou fornecedor"></label>
    </form>
    <div class="card"><div class="row between" style="margin-bottom:8px"><b data-totals></b><a class="btn ghost sm" data-csv href="#">${icon('download')} Planilha</a></div>
      <ul class="list" data-list></ul></div>`);
  const list = $('[data-list]', box);
  const qs = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  async function load() {
    const res = await api(`/finance/entries?${qs()}&limit=500`);
    if (!ctx.isCurrent()) return;
    const active = res.entries.filter((e) => !e.canceled_at);
    const rec = active.filter((e) => e.kind === 'receita').reduce((a, e) => a + e.amount, 0);
    const des = active.filter((e) => e.kind === 'despesa').reduce((a, e) => a + e.amount, 0);
    $('[data-totals]', box).textContent = `${res.entries.length} lançamento(s) · receitas ${brl(rec)} · despesas ${brl(des)}`;
    list.innerHTML = res.entries.length ? String(html`${res.entries.map(entryRow)}`) : String(html`<li class="empty">Nada encontrado.</li>`);
    bindEntryActions(list, env, res.entries);
  }
  let timer;
  $('[data-filters]', box).oninput = (e) => {
    f[e.target.name] = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(load, e.target.name === 'q' ? 350 : 0);
  };
  $('[data-csv]', box).onclick = (e) => { e.preventDefault(); location.href = `/api/finance/entries.csv?${qs()}`; };
  await load();
}

async function openTab(box, env) {
  const { ctx } = env;
  const [pay, rec] = await Promise.all([
    api('/finance/entries?status=aberto&kind=despesa&limit=500'),
    api('/finance/entries?status=aberto&kind=receita&limit=500'),
  ]);
  if (!ctx.isCurrent()) return;
  const sum = (list) => brl(list.reduce((a, e) => a + e.amount, 0));
  box.innerHTML = String(html`<div class="grid-2">
    <div class="card"><div class="card-head"><h2>A pagar</h2><b class="money neg">${sum(pay.entries)}</b></div>
      ${pay.entries.length ? html`<ul class="list" data-pay-list>${pay.entries.map(entryRow)}</ul>` : html`<div class="empty">Nada a pagar.</div>`}</div>
    <div class="card"><div class="card-head"><h2>A receber</h2><b class="money pos">${sum(rec.entries)}</b></div>
      ${rec.entries.length ? html`<ul class="list" data-rec-list>${rec.entries.map(entryRow)}</ul>` : html`<div class="empty">Nada a receber.</div>`}</div>
  </div>`);
  const pl = $('[data-pay-list]', box);
  if (pl) bindEntryActions(pl, env, pay.entries);
  const rl = $('[data-rec-list]', box);
  if (rl) bindEntryActions(rl, env, rec.entries);
}

async function categoriesTab(box, env) {
  const { meta } = env;
  const group = (kind) => meta.categories.filter((c) => c.kind === kind);
  box.innerHTML = String(html`<div class="grid-2">
    ${['despesa', 'receita'].map((kind) => html`<div class="card">
      <h2 style="margin-bottom:8px">Categorias de ${kind}</h2>
      <ul class="list">${group(kind).map((c) => html`<li class="row between">
        <span>${c.name} ${c.active ? '' : html`<span class="tag">Desativada</span>`}</span>
        <span class="row"><button class="btn ghost sm" data-rename="${c.id}" data-name="${c.name}">${icon('edit')} Renomear</button>
          <button class="btn ghost sm" data-toggle="${c.id}" data-active="${c.active}">${c.active ? 'Desativar' : 'Reativar'}</button></span></li>`)}</ul>
      <form class="input-group" style="margin-top:12px" data-add="${kind}"><input class="input" name="name" placeholder="Nova categoria de ${kind}" maxlength="60" required><button class="btn" type="submit">${icon('plus')}</button></form>
    </div>`)}
  </div>`);
  $$('[data-add]', box).forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/finance/categories', { method: 'POST', body: { kind: form.dataset.add, name: form.elements.name.value } }); toast('Categoria criada.'); env.reload(); } catch (err) { toastError(err); }
    };
  });
  $$('[data-rename]', box).forEach((b) => {
    b.onclick = async () => {
      const name = await promptDialog({ title: 'Renomear categoria', label: 'Novo nome', placeholder: b.dataset.name, confirmText: 'Salvar' });
      if (!name) return;
      try { await api(`/finance/categories/${b.dataset.rename}`, { method: 'PUT', body: { name } }); env.reload(); } catch (err) { toastError(err); }
    };
  });
  $$('[data-toggle]', box).forEach((b) => {
    b.onclick = async () => {
      try { await api(`/finance/categories/${b.dataset.toggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }); env.reload(); } catch (err) { toastError(err); }
    };
  });
}
