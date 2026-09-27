import { html, api, fmtNum, fmtAvg, fmtQty, fmtDay, fmtCompact, packText, statusBadge, plural, $, $$ } from '../lib.js';
import { productionChart, coverageChart, stockChart, consumptionChart, productChart, destroyCharts, destroyChart } from '../charts.js';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ok */ } },
};

function delta(cur, prev, { upIsGood = true } = {}) {
  if (!prev) return html`<span>sem dados do período anterior</span>`;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return html`<span>igual ao período anterior</span>`;
  const good = pct > 0 === upIsGood;
  return html`<span class="${good ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(pct), 0)}%</span> vs. período anterior`;
}

export async function render(ctx) {
  const { el } = ctx;
  ctx.setTitle('Painel');
  let days = Number(store.get('gsc.dash.days')) || 30;
  let data = await api(`/dashboard?days=${days}`);
  if (!ctx.isCurrent()) return;
  let selectedItem = Number(store.get('gsc.dash.item')) || (data.items[0] && data.items[0].id);
  if (!data.items.some((i) => i.id === selectedItem) && data.items[0]) selectedItem = data.items[0].id;

  el.innerHTML = String(html`
    <div class="page-title"><h1>Painel</h1></div>
    <div class="row wrap" style="margin-bottom:16px">
      <div class="seg" role="group" aria-label="Período">
        ${[[7, '7 dias'], [30, '30 dias'], [90, '90 dias']].map(([d, l]) => html`<button data-days="${d}" aria-pressed="${d === days}">${l}</button>`)}
      </div>
      <span class="small muted" data-period></span>
    </div>
    <div data-body></div>`);

  const draw = () => {
    destroyCharts();
    itemCharts = [];
    const c = data.current;
    const p = data.previous;
    $('[data-period]', el).textContent = `${fmtDay(data.period.from)} a ${fmtDay(data.period.to)}`;
    const withUse = data.items.filter((i) => i.forecast.days_left !== null);
    $('[data-body]', el).innerHTML = String(html`
      <div class="tiles">
        <div class="tile hero"><p class="label">Produzido</p><div class="value">${fmtCompact(c.printed)}</div>
          <div class="delta">${delta(c.printed, p.printed)}</div></div>
        <div class="tile"><p class="label">Empacotado</p><div class="value">${fmtCompact(c.packed)}</div>
          <div class="delta">${delta(c.packed, p.packed)}</div></div>
        <div class="tile"><p class="label">Pacotes feitos</p><div class="value">${fmtNum(c.packages)}</div>
          <div class="delta">${fmtNum(c.pack_orders)} ${plural('lançamento', c.pack_orders)}</div></div>
        <div class="tile"><p class="label">Perda na produção</p><div class="value">${fmtNum(c.waste_pct, 1)}%</div>
          <div class="delta">${fmtNum(c.print_waste)} perdidas · ${delta(c.waste_pct, p.waste_pct, { upIsGood: false })}</div></div>
        <a class="tile" href="#/pedidos" style="text-decoration:none;color:inherit"><p class="label">Pedidos entregues</p><div class="value">${fmtNum(data.orders.delivered)}</div>
          <div class="delta">${fmtNum(data.orders.open)} em andamento${data.orders.late ? html` · <span class="down">${data.orders.late} atrasado(s)</span>` : ''}</div></a>
      </div>
      <p class="small muted" style="margin-top:10px">${fmtNum(data.alerts)} ${data.alerts === 1 ? 'item' : 'itens'} em alerta</p>

      <div class="card section">
        <div class="card-head"><h2>Produção por dia</h2>
          <p class="small muted">Quanto ficou pronto (depois de cortar e separar) e quanto foi empacotado em cada dia.</p></div>
        <div class="legend">
          <span><i style="border-color:var(--series-1)"></i>Produzido</span>
          <span><i style="border-color:var(--series-2)"></i>Empacotado</span>
        </div>
        <div class="chart-box"><canvas data-prod aria-label="Gráfico de produção diária"></canvas></div>
        <details class="data-table"><summary>Ver dados em tabela</summary>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Dia</th><th class="r">Produzido</th><th class="r">Perda</th><th class="r">Empacotado</th><th class="r">Pacotes</th></tr></thead>
            <tbody>${[...data.daily].reverse().map((d) => html`<tr><td>${fmtDay(d.day)}</td><td class="r">${fmtNum(d.printed)}</td>
              <td class="r">${fmtNum(d.waste)}</td><td class="r">${fmtNum(d.packed)}</td><td class="r">${fmtNum(d.packages)}</td></tr>`)}</tbody>
          </table></div>
        </details>
      </div>

      <div class="card section">
        <div class="card-head"><h2>Produção por produto</h2><p class="small muted">Quanto foi produzido e empacotado de cada produto no período.</p></div>
        ${data.by_product.length ? html`<div class="legend">
            <span><i class="box" style="background:var(--series-1)"></i>Produzido</span>
            <span><i class="box" style="background:var(--series-2)"></i>Empacotado</span></div>
          <div class="chart-box"><canvas data-byprod aria-label="Gráfico de produção por produto"></canvas></div>
          <details class="data-table"><summary>Ver dados em tabela</summary><div class="table-wrap"><table class="table">
            <thead><tr><th>Produto</th><th class="r">Produzido</th><th class="r">Empacotado</th></tr></thead>
            <tbody>${data.by_product.map((p) => html`<tr><td>${p.name}</td><td class="r">${fmtNum(p.printed)}</td><td class="r">${fmtNum(p.packed)}</td></tr>`)}</tbody>
          </table></div></details>` : html`<div class="empty">Nenhuma produção no período.</div>`}
      </div>

      <div class="card section">
        <div class="card-head"><h2>Previsão de estoque</h2></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Item</th><th class="r">Saldo</th><th class="r hide-sm">Média/dia</th><th class="r">Acaba em</th><th>Situação</th></tr></thead>
          <tbody>${data.items.map((i) => html`<tr>
            <td><a href="#/item/${i.id}">${i.name}</a>
              ${i.forecast.suggested_order > 0 ? html`<div class="xs muted">Comprar ~${fmtQty(i.forecast.suggested_order, i.unit)}${packText(i, i.forecast.suggested_order) ? ` (${packText(i, i.forecast.suggested_order)})` : ''}</div>` : ''}</td>
            <td class="r nowrap">${fmtNum(i.quantity)} <span class="xs muted">${plural(i.unit, i.quantity)}</span></td>
            <td class="r hide-sm">${fmtAvg(i.forecast.avg_daily)}</td>
            <td class="r nowrap">${i.quantity <= 0 ? 'já acabou' : i.forecast.days_left === null ? 'sem consumo' : html`${fmtDay(i.forecast.runout_date)}<div class="xs muted">${i.forecast.days_left < 1 ? 'menos de 1 dia' : `~${fmtNum(Math.floor(i.forecast.days_left), 0)} dias`}</div>`}</td>
            <td>${statusBadge(i.forecast, i.quantity)}</td></tr>`)}</tbody>
        </table></div>
      </div>
      <div class="card section">
        <div class="card-head"><h2>Quanto tempo o estoque dura</h2>
          <p class="small muted">Dias até acabar, no ritmo de consumo atual.</p></div>
        <div class="legend">
          <span><i class="box" style="background:var(--good)"></i>OK</span>
          <span><i class="box" style="background:var(--warning)"></i>Repor já</span>
          <span><i class="box" style="background:var(--serious)"></i>Estoque baixo</span>
          <span><i class="box" style="background:var(--critical)"></i>Sem estoque</span>
          <span><i class="tick"></i>Prazo de reposição</span>
        </div>
        ${withUse.length ? html`<div class="chart-box"><canvas data-cov aria-label="Gráfico de dias de estoque por item"></canvas></div>`
          : html`<div class="empty">Ainda não há consumo registrado para prever.</div>`}
      </div>
      <div class="card section">
        <div class="card-head"><h2>Evolução de um item</h2></div>
        <div class="chips" role="group" aria-label="Escolher item">
          ${data.items.map((i) => html`<button class="chip" data-item="${i.id}" aria-pressed="${i.id === selectedItem}">${i.name}</button>`)}
        </div>
        <div class="legend">
          <span><i style="border-color:var(--series-1)"></i>Saldo</span>
          <span><i class="dash" style="border-color:var(--series-1)"></i>Previsão no ritmo atual</span>
          <span><i class="dash" style="border-color:var(--serious)"></i>Estoque mínimo</span>
        </div>
        <div class="chart-box"><canvas data-stock aria-label="Gráfico da evolução do estoque do item"></canvas></div>
        <h3 style="margin:18px 0 8px">Consumo por dia</h3>
        <div class="chart-box short"><canvas data-cons aria-label="Gráfico de consumo diário do item"></canvas></div>
      </div>`);

    productionChart($('[data-prod]', el), data.daily);
    if (data.by_product.length) productChart($('[data-byprod]', el), data.by_product);
    if (withUse.length) coverageChart($('[data-cov]', el), data.items);
    drawItem();
    $$('[data-item]', el).forEach((b) => {
      b.onclick = () => {
        selectedItem = Number(b.dataset.item);
        store.set('gsc.dash.item', String(selectedItem));
        $$('[data-item]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        drawItem();
      };
    });
  };

  let itemCharts = [];
  async function drawItem() {
    if (!selectedItem) return;
    const hist = await api(`/items/${selectedItem}/history?days=${Math.max(days, 30)}`);
    if (!ctx.isCurrent()) return;
    itemCharts.forEach(destroyChart);
    itemCharts = [stockChart($('[data-stock]', el), hist), consumptionChart($('[data-cons]', el), hist)];
  }

  $$('[data-days]', el).forEach((b) => {
    b.onclick = async () => {
      days = Number(b.dataset.days);
      store.set('gsc.dash.days', String(days));
      $$('[data-days]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('[data-body]', el).style.opacity = '0.5';
      data = await api(`/dashboard?days=${days}`);
      if (!ctx.isCurrent()) return;
      $('[data-body]', el).style.opacity = '';
      draw();
    };
  });
  draw();
}

