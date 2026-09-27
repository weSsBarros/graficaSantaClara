// Pedaços de tela usados em mais de um lugar.
import { html, icon, api, fmtNum, fmtDateTime, plural, promptDialog, toast, toastError, $$ } from '../lib.js';

export const OP_ICONS = {
  entrada: 'in',
  retirada: 'out',
  ajuste: 'count',
  impressao: 'printer',
  empacotamento: 'package',
  estorno: 'undo',
};

/**
 * Um lançamento na lista (histórico, início, página do item).
 * `undo`: 'all' mostra o botão sempre que permitido (histórico); 'recent' só nos
 * lançamentos da própria pessoa ainda dentro do prazo de desfazer (telas resumidas).
 */
export function opItem(op, me, { showUser = true, undo = 'recent' } = {}) {
  const lateMin = (Date.parse(op.created_at) - Date.parse(op.occurred_at)) / 60000;
  const mine = op.user_id === me.user.id;
  const recentMine = mine && (Date.now() - Date.parse(op.created_at)) / 60000 <= me.config.self_undo_minutes;
  const showUndo = op.can_undo && (undo === 'all' || recentMine);
  const undoLabel = recentMine ? 'Desfazer' : 'Estornar';
  return html`
    <li class="op ${op.reversed_by_id ? 'reversed' : ''}">
      <div class="dot">${icon(OP_ICONS[op.type])}</div>
      <div class="sum">${op.summary}</div>
      <div class="meta">
        #${op.id} · ${op.type_label} · ${fmtDateTime(op.occurred_at)}${showUser ? ` · ${op.user_name}` : ''}
        ${lateMin > 30 ? html` · <span title="Data em que foi registrado no sistema">lançado ${fmtDateTime(op.created_at)}</span>` : ''}
        ${op.reversed_by_id ? html` · <span class="tag">estornado pelo #${op.reversed_by_id}</span>` : ''}
      </div>
      <div>
        ${op.movements.length ? html`<div class="movs">${op.movements.map((m) => html`
          <span class="mv ${m.delta > 0 ? 'pos' : m.delta < 0 ? 'neg' : ''}">${m.item_name}: <b>${m.delta > 0 ? '+' : ''}${fmtNum(m.delta)}</b>
          → ${fmtNum(m.balance_after)} ${plural(m.unit, m.balance_after)}</span>`)}</div>` : ''}
        ${op.note ? html`<div class="meta" style="margin-top:4px">Obs.: ${op.note}</div>` : ''}
        ${showUndo ? html`<div class="tools"><button class="btn danger sm" data-undo="${op.id}">${icon('undo')} ${undoLabel}</button></div>` : ''}
      </div>
    </li>`;
}

export function opsList(ops, me, opts) {
  if (!ops.length) return html`<div class="empty">Nenhum lançamento ainda.</div>`;
  return html`<ul class="list">${ops.map((o) => opItem(o, me, opts))}</ul>`;
}

/** Liga os botões "Desfazer/Estornar" da lista. */
export function bindUndo(root, onDone) {
  $$('[data-undo]', root).forEach((b) => {
    b.onclick = async () => {
      const reason = await promptDialog({
        title: `Desfazer lançamento #${b.dataset.undo}?`,
        body: 'O lançamento continua no histórico, marcado como estornado, e o estoque volta ao que era. Fica registrado quem desfez e por quê.',
        label: 'Motivo',
        placeholder: 'Ex.: digitei a quantidade errada',
        confirmText: 'Desfazer',
        danger: true,
      });
      if (!reason) return;
      try {
        const r = await api(`/ops/${b.dataset.undo}/estorno`, { method: 'POST', body: { reason } });
        toast('Lançamento desfeito.');
        r.warnings.forEach((w) => toast(w, { error: true, ms: 8000 }));
        onDone();
      } catch (err) {
        toastError(err);
      }
    };
  });
}

/** Barra de nível do estoque, com marca no estoque mínimo. */
export function meter(item) {
  if (!(item.min_stock > 0)) return '';
  const max = Math.max(item.min_stock * 3, item.quantity, 1);
  const pct = Math.max(0, Math.min(100, (item.quantity / max) * 100));
  const minPct = (item.min_stock / max) * 100;
  return html`<div class="meter ${item.forecast.status}" role="img" aria-label="Nível do estoque em relação ao mínimo">
    <i style="width:${pct.toFixed(1)}%"></i><b style="left:${minPct.toFixed(1)}%" title="Estoque mínimo"></b></div>`;
}
