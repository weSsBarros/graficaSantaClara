import { html, api, icon, fmtNum, fmtAvg, fmtQty, plural, packText, statusBadge, runoutText, fmtDay, fmtDateTime, CATEGORY_LABELS, $, $$ } from '../lib.js';
import { stockChart, consumptionChart, destroyChart } from '../charts.js';
import { opsList, bindUndo, meter } from './components.js';

export async function render(ctx) {
  const { el, me, params } = ctx;
  const id = Number(params.id);
  const [item, ops] = await Promise.all([api(`/items/${id}`), api(`/ops?item_id=${id}&limit=20`)]);
  if (!ctx.isCurrent()) return;
  ctx.setTitle(item.name, { back: true });
  const f = item.forecast;
  const p = me.perms;
  const pack = packText(item, item.quantity);
  let days = 60;

  el.innerHTML = String(html`
    <div class="page-head">
      <div>
        <span class="cat">${CATEGORY_LABELS[item.category]}${item.source === 'producao' ? ' · produzido aqui' : ''}${item.active ? '' : ' · DESATIVADO'}</span>
        <h1 style="margin-top:4px">${item.name}</h1>
      </div>
      ${statusBadge(f, item.quantity)}
    </div>

    <div class="card">
      <div class="hero-qty">${fmtNum(item.quantity)} <small>${plural(item.unit, item.quantity)}</small></div>
      ${pack ? html`<div class="muted" style="margin-top:4px">${pack}</div>` : ''}
      <div style="margin:14px 0 6px">${meter(item)}</div>
      <p><b>${runoutText(item)}</b></p>
      ${f.suggested_order > 0 ? html`<div class="notice warn" style="margin:12px 0 0">${icon('alert')}<span>
        Sugestão de compra: <b>${fmtQty(f.suggested_order, item.unit)}</b>${packText(item, f.suggested_order) ? ` (${packText(item, f.suggested_order)})` : ''} —
        cobre o prazo de entrega e mais um mês no ritmo atual.</span></div>` : ''}
      <div class="row wrap" style="margin-top:16px">
        ${p.includes('entrada') ? html`<a class="btn" href="#/lancar/entrada?item=${item.id}">${icon('in')} Entrada</a>` : ''}
        ${p.includes('retirada') ? html`<a class="btn secondary" href="#/lancar/retirada?item=${item.id}">${icon('out')} Retirada</a>` : ''}
        ${p.includes('ajuste') ? html`<a class="btn secondary" href="#/lancar/ajuste?item=${item.id}">${icon('count')} Contagem</a>` : ''}
        ${p.includes('cadastros') ? html`<a class="btn ghost" href="#/config/itens?edit=${item.id}">${icon('edit')} Editar item</a>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="stats">
        <div class="stat"><p class="label">Consumo médio por dia</p><div class="value">${fmtAvg(f.avg_daily)}</div><div class="sub">${plural(item.unit, 2)} · últimos ${fmtNum(Math.max(1, Math.round(f.history_days)), 0)} dias</div></div>
        <div class="stat"><p class="label">Média dos últimos 7 dias</p><div class="value">${fmtAvg(f.avg_daily_7d)}</div><div class="sub">${plural(item.unit, 2)} por dia</div></div>
        <div class="stat"><p class="label">Previsão de acabar</p><div class="value">${f.runout_date && item.quantity > 0 ? fmtDay(f.runout_date) : '—'}</div><div class="sub">${f.days_left !== null && item.quantity > 0 ? `~${fmtNum(Math.floor(f.days_left), 0)} dias` : 'sem consumo'}</div></div>
        <div class="stat"><p class="label">Estoque mínimo</p><div class="value">${fmtNum(item.min_stock)}</div><div class="sub">${item.source === 'compra' ? `reposição em ${item.lead_time_days} dias` : 'produzido internamente'}</div></div>
      </div>
      <p class="small muted" style="margin-top:12px">
        Última contagem: ${item.last_count ? `${fmtDateTime(item.last_count.occurred_at)} por ${item.last_count.user_name}` : 'nunca'}
        ${item.notes ? html`<br>${item.notes}` : ''}
      </p>
    </div>

    <div class="card">
      <div class="card-head"><h2>Evolução do estoque</h2>
        <div class="seg" role="group" aria-label="Período">
          ${[30, 60, 90].map((d) => html`<button data-days="${d}" aria-pressed="${d === days}">${d} dias</button>`)}
        </div>
      </div>
      <div class="legend">
        <span><i style="border-color:var(--series-1)"></i>Saldo</span>
        <span><i class="dash" style="border-color:var(--series-1)"></i>Previsão no ritmo atual</span>
        ${item.min_stock > 0 ? html`<span><i class="dash" style="border-color:var(--serious)"></i>Estoque mínimo</span>` : ''}
      </div>
      <div class="chart-box" data-chart-box><canvas data-stock aria-label="Gráfico da evolução do estoque"></canvas></div>
      <h3 style="margin:18px 0 8px">Consumo por dia</h3>
      <div class="chart-box short" data-chart-box><canvas data-cons aria-label="Gráfico do consumo diário"></canvas></div>
      <details class="data-table"><summary>Ver dados em tabela</summary><div data-table class="table-wrap"></div></details>
    </div>

    <div class="card">
      <div class="card-head"><h2>Últimos lançamentos</h2><a class="small" href="#/historico?item_id=${item.id}">Ver histórico completo</a></div>
      <div data-ops>${opsList(ops.operations, me)}</div>
    </div>`);

  let charts = [];
  async function drawCharts() {
    $$('[data-chart-box]', el).forEach((b) => b.classList.add('loading'));
    const hist = await api(`/items/${id}/history?days=${days}`);
    if (!ctx.isCurrent()) return;
    charts.forEach(destroyChart);
    $$('[data-chart-box]', el).forEach((b) => b.classList.remove('loading'));
    charts = [stockChart($('[data-stock]', el), hist), consumptionChart($('[data-cons]', el), hist)];
    $('[data-table]', el).innerHTML = String(html`<table class="table">
      <thead><tr><th>Dia</th><th class="r">Consumo</th><th class="r">Saldo no fim do dia</th></tr></thead>
      <tbody>${[...hist.series].reverse().map((r) => html`<tr><td>${fmtDay(r.day)}</td><td class="r">${fmtNum(r.consumed)}</td><td class="r">${fmtNum(r.balance)}</td></tr>`)}</tbody>
    </table>`);
  }
  $$('[data-days]', el).forEach((b) => {
    b.onclick = () => {
      days = Number(b.dataset.days);
      $$('[data-days]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      drawCharts();
    };
  });
  bindUndo($('[data-ops]', el), () => render(ctx));
  await drawCharts();
}
