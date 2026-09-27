import { html, api, icon, todayStr, $, $$ } from '../lib.js';
import { opItem, bindUndo } from './components.js';

const TYPES = [
  ['', 'Todos os tipos'],
  ['impressao', 'Impressão'],
  ['empacotamento', 'Empacotamento'],
  ['entrada', 'Entrada'],
  ['retirada', 'Retirada'],
  ['ajuste', 'Ajuste de inventário'],
  ['estorno', 'Estorno'],
];

export async function render(ctx) {
  const { el, me, query } = ctx;
  ctx.setTitle('Histórico');
  const [users, items] = await Promise.all([api('/auth/users'), api('/items')]);
  if (!ctx.isCurrent()) return;
  const f = { type: query.type || '', user_id: query.user_id || '', item_id: query.item_id || '', from: query.from || '', to: query.to || '' };
  const canExport = me.perms.includes('ver_logs');

  el.innerHTML = String(html`
    <div class="page-title"><h1>Histórico de lançamentos</h1>
      ${canExport ? html`<a class="btn secondary" data-export href="#">${icon('download')} Exportar planilha</a>` : ''}</div>
    <form class="filters" data-filters>
      <label><span>Tipo</span><select class="input" name="type">${TYPES.map(([v, l]) => html`<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`)}</select></label>
      <label><span>Pessoa</span><select class="input" name="user_id"><option value="">Todas</option>
        ${users.map((u) => html`<option value="${u.id}" ${String(u.id) === f.user_id ? 'selected' : ''}>${u.name}</option>`)}</select></label>
      <label><span>Item</span><select class="input" name="item_id"><option value="">Todos</option>
        ${items.map((i) => html`<option value="${i.id}" ${String(i.id) === f.item_id ? 'selected' : ''}>${i.name}</option>`)}</select></label>
      <label><span>De</span><input class="input" type="date" name="from" value="${f.from}" max="${todayStr()}"></label>
      <label><span>Até</span><input class="input" type="date" name="to" value="${f.to}" max="${todayStr()}"></label>
    </form>
    <div class="card"><ul class="list" data-list></ul>
      <div style="text-align:center;margin-top:12px"><button class="btn secondary hidden" data-more>Carregar mais</button></div>
    </div>`);

  const list = $('[data-list]', el);
  const more = $('[data-more]', el);
  let offset = 0;

  const qs = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

  async function load(reset) {
    if (reset) { offset = 0; list.innerHTML = ''; }
    const res = await api(`/ops?${qs()}&limit=40&offset=${offset}`);
    if (!ctx.isCurrent()) return;
    offset += res.operations.length;
    if (reset && !res.operations.length) list.innerHTML = String(html`<li class="empty">Nenhum lançamento encontrado.</li>`);
    list.insertAdjacentHTML('beforeend', res.operations.map((o) => String(opItem(o, me, { undo: 'all' }))).join(''));
    more.classList.toggle('hidden', !res.has_more);
    bindUndo(list, () => load(true));
  }

  $('[data-filters]', el).onchange = (e) => {
    f[e.target.name] = e.target.value;
    history.replaceState(null, '', `#/historico?${qs()}`);
    load(true);
  };
  more.onclick = () => load(false);
  const exp = $('[data-export]', el);
  if (exp) {
    exp.onclick = (e) => {
      e.preventDefault();
      const p = new URLSearchParams({ from: f.from, to: f.to });
      location.href = `/api/export/movimentos.csv?${p}`;
    };
  }
  $$('select, input', el).forEach((x) => x.setAttribute('autocomplete', 'off'));
  await load(true);
}
