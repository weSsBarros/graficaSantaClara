// Um pedido: itens e andamento do empacotamento, linha do tempo até a entrega, pagamento.
import { html, api, icon, fmtNum, fmtDay, fmtDateTime, brl, hasPerm, promptDialog, confirmDialog, toast, toastError, $ } from '../lib.js';
import { statusChip } from './orders.js';
import { opsList, bindUndo } from './components.js';

export async function render(ctx) {
  const { el, me, params } = ctx;
  const o = await api(`/orders/${Number(params.id)}`);
  if (!ctx.isCurrent()) return;
  ctx.setTitle(`Pedido #${o.id}`, { back: true });
  const open = !['entregue', 'cancelado'].includes(o.status);
  const prices = o.total !== undefined;
  const can = (p) => hasPerm(me, p);

  const timeline = [
    [o.created_at, `Pedido registrado por ${o.created_by_name}`],
    ...o.operations.filter((op) => op.type === 'empacotamento' && !op.reversed_by_id).map((op) => [op.occurred_at, `${op.user_name} empacotou ${fmtNum(op.output_qty)} folhas (${op.packages} × ${fmtNum(op.per_package)})`]),
    o.shipped_at && [o.shipped_at, `Saiu para entrega${o.carrier ? ` com ${o.carrier}` : ''} (${o.shipped_by_name})`],
    o.delivered_at && [o.delivered_at, `Entregue${o.received_by ? ` — recebido por ${o.received_by}` : ''} (${o.delivered_by_name})`],
    o.canceled_at && [o.canceled_at, `Cancelado: ${o.cancel_reason}`],
  ].filter(Boolean).sort((a, b) => a[0].localeCompare(b[0]));

  el.innerHTML = String(html`
    <div class="page-head">
      <div><span class="cat">Pedido #${o.id}</span><h1 style="margin-top:4px">${o.client_name}</h1>
        <p class="muted">${[o.client_phone, o.client_address].filter(Boolean).join(' · ')}</p></div>
      ${statusChip(o)}
    </div>

    <div class="card">
      <div class="row wrap between">
        <div>
          <div class="small muted">Entrega combinada</div>
          <b class="${o.late ? 'late' : ''}">${o.due_date ? fmtDay(o.due_date) : 'sem data'}${o.late ? ' — atrasado' : ''}</b>
        </div>
        ${prices ? html`<div><div class="small muted">Valor</div><b>${brl(o.total)}</b>
          ${o.payment ? html` <span class="status ${o.payment.status === 'pago' ? 'pago' : o.payment.status === 'sem_valor' ? '' : 'aberto'}">${{ pago: 'Pago', parcial: 'Pago em parte', pendente: 'A receber', sem_valor: 'Sem valor' }[o.payment.status]}</span>` : ''}</div>` : ''}
      </div>
      <div class="table-wrap" style="margin-top:14px"><table class="table">
        <thead><tr><th>Produto</th><th class="r">Pedido</th><th class="r">Empacotado</th><th class="r">Falta</th>${prices ? html`<th class="r">Preço</th>` : ''}</tr></thead>
        <tbody>${o.items.map((l) => html`<tr>
          <td>${l.item_name}<div class="progress ${l.packed >= l.quantity ? 'done' : ''}" style="margin-top:6px;max-width:220px"><i style="width:${Math.min(100, (100 * l.packed) / l.quantity).toFixed(1)}%"></i></div></td>
          <td class="r">${fmtNum(l.quantity)}</td><td class="r">${fmtNum(l.packed)}</td><td class="r">${fmtNum(l.remaining)}</td>
          ${prices ? html`<td class="r money">${brl(l.unit_price)}</td>` : ''}</tr>`)}</tbody>
      </table></div>
      ${o.notes ? html`<p class="small" style="margin-top:10px">Obs.: ${o.notes}</p>` : ''}
      <div class="row wrap" style="margin-top:16px">
        ${open && can('empacotamento') && o.items.some((l) => l.remaining > 0) ? html`<a class="btn" href="#/lancar/empacotamento?pedido=${o.id}">${icon('package')} Registrar empacotamento</a>` : ''}
        ${['aberto', 'parcial', 'pronto'].includes(o.status) && can('entrega') ? html`<button class="btn ${o.status === 'pronto' ? '' : 'secondary'}" data-ship>${icon('truck')} Saiu para entrega</button>` : ''}
        ${open && can('entrega') ? html`<button class="btn ${o.status === 'saiu' ? '' : 'secondary'}" data-deliver>${icon('check')} Registrar entrega</button>` : ''}
        ${open && can('pedidos') ? html`<a class="btn ghost" href="#/pedido/${o.id}/editar">${icon('edit')} Editar</a>` : ''}
        ${open && can('pedidos') ? html`<button class="btn danger" data-cancel>Cancelar pedido</button>` : ''}
      </div>
    </div>

    <div class="grid-2 section">
      <div class="card"><h2 style="margin-bottom:12px">Andamento</h2>
        <ul class="timeline">${timeline.map(([t, text]) => html`<li><div class="small muted">${fmtDateTime(t)}</div><div>${text}</div></li>`)}</ul>
      </div>
      <div class="card"><h2 style="margin-bottom:4px">Empacotamentos</h2>
        <div data-ops>${opsList(o.operations, me, { undo: open ? 'all' : 'recent' })}</div>
      </div>
    </div>`);

  const reload = () => render(ctx);
  bindUndo($('[data-ops]', el), reload);
  const ship = $('[data-ship]', el);
  if (ship) {
    ship.onclick = async () => {
      const carrier = await promptDialog({
        title: 'Saiu para entrega',
        body: o.status !== 'pronto' ? 'Atenção: o pedido ainda não está todo empacotado.' : '',
        label: 'Quem levou? (motorista, motoboy, transportadora)',
        placeholder: 'Ex.: Seu Zé da moto',
        confirmText: 'Confirmar saída',
      });
      if (carrier === null) return;
      try { await api(`/orders/${o.id}/ship`, { method: 'POST', body: { carrier } }); toast('Saída registrada.'); reload(); } catch (err) { toastError(err); }
    };
  }
  const deliver = $('[data-deliver]', el);
  if (deliver) {
    deliver.onclick = async () => {
      if (!['pronto', 'saiu'].includes(o.status) && !(await confirmDialog({
        title: 'Entregar sem terminar de empacotar?',
        body: 'Ainda falta empacotar parte deste pedido. Registrar a entrega mesmo assim?',
        confirmText: 'Sim, foi entregue',
      }))) return;
      const receivedBy = await promptDialog({ title: `Entrega do pedido #${o.id}`, label: 'Quem recebeu?', placeholder: 'Nome de quem recebeu no cliente', confirmText: 'Registrar entrega' });
      if (receivedBy === null) return;
      try { await api(`/orders/${o.id}/deliver`, { method: 'POST', body: { received_by: receivedBy } }); toast('Entrega registrada!'); reload(); } catch (err) { toastError(err); }
    };
  }
  const cancel = $('[data-cancel]', el);
  if (cancel) {
    cancel.onclick = async () => {
      const reason = await promptDialog({
        title: `Cancelar o pedido #${o.id}?`,
        body: o.packed_total > 0 ? 'Parte do pedido já foi empacotada: essas folhas continuam fora do estoque até alguém fazer uma contagem/ajuste.' : 'A conta a receber do pedido também será cancelada.',
        label: 'Motivo', confirmText: 'Cancelar pedido', danger: true,
      });
      if (!reason) return;
      try { await api(`/orders/${o.id}/cancel`, { method: 'POST', body: { reason } }); toast('Pedido cancelado.'); reload(); } catch (err) { toastError(err); }
    };
  }
}
