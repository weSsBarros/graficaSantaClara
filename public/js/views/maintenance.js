import { html, api, icon, fmtDateTime, fmtNum, localInputValue, toast, toastError, $ } from '../lib.js';

export async function render(ctx) {
  const { el, me } = ctx;
  ctx.setTitle('Manutenção');
  const [data, sugg] = await Promise.all([api('/maintenance?limit=50'), api('/suggestions')]);
  if (!ctx.isCurrent()) return;
  const canAdd = me.perms.includes('manutencao');
  const manager = me.perms.includes('cadastros');
  const minDate = new Date(Date.now() - (manager ? 365 : me.config.max_backdate_days) * 86400000);

  el.innerHTML = String(html`
    <div class="page-title"><h1>Manutenção das máquinas</h1></div>
    <div class="grid-2">
      ${canAdd ? html`
      <form class="card" data-form>
        <h2 style="margin-bottom:14px">${icon('wrench')} Registrar manutenção</h2>
        <label class="field"><span>Máquina</span>
          <input class="input" name="machine" list="dl-machines" value="${sugg.machines[0] || 'Impressora'}" maxlength="80" required></label>
        <label class="field"><span>Tipo</span>
          <select class="input" name="type">${Object.entries(data.types).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
        <label class="field"><span>O que foi feito?</span>
          <textarea class="input" name="description" maxlength="1000" required placeholder="Ex.: limpeza dos rolos e troca do feltro"></textarea></label>
        <div class="form-grid cols-2">
          <label class="field"><span>Máquina parada (minutos)</span>
            <input class="input" name="downtime_minutes" inputmode="numeric" placeholder="0"></label>
          <label class="field"><span>Quando</span>
            <input class="input" type="datetime-local" name="occurred_at" value="${localInputValue()}" min="${localInputValue(minDate)}" max="${localInputValue()}"></label>
        </div>
        <p class="small muted" style="margin-bottom:14px">Se usou tinta ou peça do estoque, registre também uma <a href="#/lancar/retirada">retirada</a>.</p>
        <button class="btn block" type="submit">Salvar</button>
      </form>` : ''}
      <div class="card">
        <h2 style="margin-bottom:8px">Últimos registros</h2>
        ${data.records.length ? html`<ul class="list">${data.records.map((r) => html`
          <li class="log-row"><b>${r.type_label} — ${r.machine}</b><span>${r.description}</span>
            <span class="meta">${fmtDateTime(r.occurred_at)} · ${r.user_name}${r.downtime_minutes ? ` · parada ${fmtNum(r.downtime_minutes)} min` : ''}</span></li>`)}</ul>`
          : html`<div class="empty">Nenhuma manutenção registrada ainda.</div>`}
      </div>
    </div>
    <datalist id="dl-machines">${sugg.machines.map((m) => html`<option value="${m}">`)}</datalist>`);

  const form = $('[data-form]', el);
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.description.trim()) return toast('Descreva o que foi feito.', { error: true });
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/maintenance', {
        method: 'POST',
        body: { ...fd, downtime_minutes: fd.downtime_minutes ? Number(fd.downtime_minutes) : undefined },
      });
      toast('Manutenção registrada.');
      render(ctx);
    } catch (err) {
      toastError(err);
      btn.disabled = false;
    }
  };
}
