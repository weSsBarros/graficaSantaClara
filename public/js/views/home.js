import { html, api, icon, fmtNum, fmtQty, greeting, packText, statusBadge, runoutText, hasPerm, $ } from '../lib.js';
import { opsList, bindUndo } from './components.js';

function quickActions(me, data) {
  const p = (x) => hasPerm(me, x);
  const o = data.orders;
  const list = [];
  if (p('impressao')) list.push({ href: '#/lancar/impressao', icon: 'printer', label: 'Registrar impressão', sub: 'Papel branco → folha impressa', primary: !me.manager });
  if (p('empacotamento')) {
    list.push({ href: '#/lancar/empacotamento', icon: 'package', label: 'Registrar empacotamento', sub: o.open ? `${o.open} ${o.open === 1 ? 'pedido' : 'pedidos'} em andamento` : 'Separar em pacotes', primary: !me.manager });
  }
  if (p('pedidos')) list.push({ href: '#/pedido/novo', icon: 'plus', label: 'Novo pedido', sub: 'Cliente, produtos e prazo' });
  if (p('entrega')) list.push({ href: '#/pedidos?status=para_entregar', icon: 'truck', label: 'Entregas', sub: o.ready ? `${o.ready} ${o.ready === 1 ? 'pronto' : 'prontos'} para entregar` : 'Saída e entrega de pedidos' });
  if (p('entrada')) list.push({ href: '#/lancar/entrada', icon: 'in', label: 'Entrada de material', sub: 'Compra ou recebimento' });
  if (p('retirada')) list.push({ href: '#/lancar/retirada', icon: 'out', label: 'Retirada de material', sub: 'Ex.: tinta, chapa' });
  if (p('manutencao')) list.push({ href: '#/manutencao', icon: 'wrench', label: 'Manutenção da máquina', sub: 'Limpeza, conserto, peças' });
  if (p('ajuste')) list.push({ href: '#/lancar/ajuste', icon: 'count', label: 'Contagem de estoque', sub: 'Conferir e corrigir o saldo' });
  if (p('financeiro')) list.push({ href: '#/financeiro/lancamentos?novo=despesa', icon: 'money', label: 'Lançar despesa', sub: 'Contas, gastos, chapa...' });
  if (me.manager) list.push({ href: '#/painel', icon: 'chart', label: 'Painel', sub: 'Produção e previsões' });
  return list;
}

export async function render(ctx) {
  const { el, me } = ctx;
  ctx.setTitle('Início');
  const data = await api('/home');
  if (!ctx.isCurrent()) return;
  const t = data.today;
  const o = data.orders;
  const actions = quickActions(me, data);

  el.innerHTML = String(html`
    <div class="page-head">
      <div><h1>${greeting()}, ${me.user.name}</h1><p class="muted">${me.user.role_label}</p></div>
    </div>

    ${data.alerts.length ? html`
      <div class="card" style="border-color:var(--serious)">
        <div class="card-head"><h2>${icon('alert')} Precisa de atenção</h2><a href="#/estoque?f=alerta" class="small">Ver estoque</a></div>
        <ul class="list">${data.alerts.map((i) => html`
          <li><a href="#/item/${i.id}" class="row between" style="text-decoration:none;color:inherit;align-items:flex-start">
            <div><b>${i.name}</b>
              <div class="small muted">${fmtQty(i.quantity, i.unit)}${packText(i, i.quantity) ? ` (${packText(i, i.quantity)})` : ''} · ${runoutText(i)}</div>
              ${i.forecast.suggested_order > 0 ? html`<div class="small">Sugestão de compra: <b>${fmtQty(i.forecast.suggested_order, i.unit)}</b>${packText(i, i.forecast.suggested_order) ? ` (${packText(i, i.forecast.suggested_order)})` : ''}</div>` : ''}
            </div>
            ${statusBadge(i.forecast, i.quantity)}
          </a></li>`)}
        </ul>
      </div>` : ''}

    ${o.late ? html`<a class="notice warn" href="#/pedidos?status=atrasados" style="text-decoration:none;color:inherit;margin-top:16px">${icon('alert')}
      <span><b>${o.late} ${o.late === 1 ? 'pedido atrasado' : 'pedidos atrasados'}</b> — passou da data de entrega combinada. Ver pedidos.</span></a>` : ''}

    <div class="section">
      <h2>O que você quer registrar?</h2>
      <div class="actions">
        ${actions.map((a) => html`
          <a class="action ${a.primary ? 'primary' : ''}" href="${a.href}">
            <span class="ico">${icon(a.icon)}</span>
            <span>${a.label}<br><small>${a.sub}</small></span>
          </a>`)}
      </div>
    </div>

    <div class="section">
      <h2>Hoje</h2>
      <div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <div class="tile"><p class="label">Folhas impressas</p><div class="value">${fmtNum(t.printed)}</div></div>
        <div class="tile"><p class="label">Folhas empacotadas</p><div class="value">${fmtNum(t.packed)}</div></div>
        <div class="tile"><p class="label">Pacotes</p><div class="value">${fmtNum(t.packages)}</div></div>
        <a class="tile" href="#/pedidos" style="text-decoration:none;color:inherit"><p class="label">Pedidos em andamento</p><div class="value">${fmtNum(o.open)}</div>
          <div class="delta">${o.ready ? `${o.ready} pronto(s) para entregar` : 'nenhum pronto para entregar'}</div></a>
      </div>
    </div>

    <div class="section card">
      <div class="card-head"><h2>Meus últimos lançamentos</h2><a class="small" href="#/historico?user_id=${me.user.id}">Ver todos</a></div>
      <div data-ops>${opsList(data.my_operations, me, { showUser: false })}</div>
    </div>`);
  bindUndo($('[data-ops]', el), () => render(ctx));
}
