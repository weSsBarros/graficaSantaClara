import { html, api, icon, fmtNum, fmtQty, greeting, packText, statusBadge, runoutText, $ } from '../lib.js';
import { opsList, bindUndo } from './components.js';

function quickActions(me) {
  const p = me.perms;
  const manager = p.includes('cadastros');
  const list = [];
  for (const proc of me.processes.filter((x) => x.can_run)) {
    const isPrint = proc.kind === 'impressao';
    list.push({
      href: `#/producao/${proc.id}`,
      icon: isPrint ? 'printer' : 'package',
      label: `Registrar ${proc.name.toLowerCase()}`,
      sub: isPrint ? `${proc.input_name} → ${proc.output_name || 'impressa'}` : `${proc.input_name} em pacotes`,
      primary: !manager,
    });
  }
  if (p.includes('entrada')) list.push({ href: '#/lancar/entrada', icon: 'in', label: 'Entrada de material', sub: 'Compra ou recebimento' });
  if (p.includes('retirada')) list.push({ href: '#/lancar/retirada', icon: 'out', label: 'Retirada de material', sub: 'Ex.: tinta para a máquina' });
  if (p.includes('manutencao')) list.push({ href: '#/manutencao', icon: 'wrench', label: 'Manutenção da máquina', sub: 'Limpeza, conserto, peças' });
  if (p.includes('ajuste')) list.push({ href: '#/lancar/ajuste', icon: 'count', label: 'Contagem de estoque', sub: 'Conferir e corrigir o saldo' });
  if (manager) list.push({ href: '#/painel', icon: 'chart', label: 'Painel', sub: 'Produção e previsões' });
  return list;
}

export async function render(ctx) {
  const { el, me } = ctx;
  ctx.setTitle('Início');
  const data = await api('/home');
  if (!ctx.isCurrent()) return;
  const t = data.today;
  const actions = quickActions(me);

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
      <div class="tiles" style="grid-template-columns:repeat(3,1fr)">
        <div class="tile"><p class="label">Folhas impressas</p><div class="value">${fmtNum(t.printed)}</div></div>
        <div class="tile"><p class="label">Folhas empacotadas</p><div class="value">${fmtNum(t.packed)}</div></div>
        <div class="tile"><p class="label">Pacotes</p><div class="value">${fmtNum(t.packages)}</div></div>
      </div>
    </div>

    <div class="section card">
      <div class="card-head"><h2>Meus últimos lançamentos</h2><a class="small" href="#/historico?user_id=${me.user.id}">Ver todos</a></div>
      <div data-ops>${opsList(data.my_operations, me, { showUser: false })}</div>
    </div>`);
  bindUndo($('[data-ops]', el), () => render(ctx));
}
