import { html, api, icon, fmtDateTime, todayStr, $ } from '../lib.js';

const ACTION_LABELS = {
  login: 'Entrou no sistema',
  logout: 'Saiu do sistema',
  login_falhou: 'PIN incorreto',
  login_bloqueado: 'Acesso bloqueado',
  pin_alterado: 'Trocou o PIN',
  pin_redefinido: 'PIN redefinido',
  entrada: 'Entrada',
  retirada: 'Retirada',
  ajuste: 'Ajuste de inventário',
  impressao: 'Impressão',
  empacotamento: 'Empacotamento',
  estorno: 'Estorno',
  manutencao: 'Manutenção',
  alerta: 'Alerta de estoque',
  alerta_resolvido: 'Alerta resolvido',
  item_criado: 'Item cadastrado',
  item_alterado: 'Item alterado',
  processo_criado: 'Processo cadastrado',
  processo_alterado: 'Processo alterado',
  pessoa_criada: 'Pessoa cadastrada',
  pessoa_alterada: 'Pessoa alterada',
  configuracao: 'Configuração',
  backup_baixado: 'Backup baixado',
  teste_aviso: 'Teste de aviso',
  instalacao: 'Instalação',
  pedido_criado: 'Pedido criado',
  pedido_alterado: 'Pedido alterado',
  pedido_saiu: 'Saiu para entrega',
  pedido_entregue: 'Pedido entregue',
  pedido_cancelado: 'Pedido cancelado',
  cliente_criado: 'Cliente cadastrado',
  cliente_alterado: 'Cliente alterado',
  financeiro_lancado: 'Financeiro: lançamento',
  financeiro_alterado: 'Financeiro: alteração',
  financeiro_pago: 'Financeiro: pagamento',
  financeiro_cancelado: 'Financeiro: cancelamento',
  financeiro_categoria: 'Financeiro: categoria',
  permissoes: 'Permissões',
  aviso_enviado: 'Aviso enviado',
  aviso_falhou: 'Aviso não enviado',
};

export async function render(ctx) {
  const { el } = ctx;
  ctx.setTitle('Registro de atividades');
  const users = await api('/auth/users');
  if (!ctx.isCurrent()) return;
  const f = { user_id: '', action: '', from: '', to: '', q: '' };
  let offset = 0;

  el.innerHTML = String(html`
    <div class="page-title"><h1>Registro de atividades</h1>
      <a class="btn secondary" data-export href="#">${icon('download')} Exportar planilha</a></div>
    <p class="muted" style="margin-bottom:16px">Tudo o que foi feito no sistema, por quem e quando. Este registro não pode ser apagado nem alterado.</p>
    <form class="filters" data-filters>
      <label><span>Pessoa</span><select class="input" name="user_id"><option value="">Todas</option>
        ${users.map((u) => html`<option value="${u.id}">${u.name}</option>`)}</select></label>
      <label><span>Ação</span><select class="input" name="action" data-actions><option value="">Todas</option></select></label>
      <label><span>De</span><input class="input" type="date" name="from" max="${todayStr()}"></label>
      <label><span>Até</span><input class="input" type="date" name="to" max="${todayStr()}"></label>
      <label><span>Buscar</span><input class="input" type="search" name="q" placeholder="Ex.: tinta"></label>
    </form>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>O que aconteceu</th></tr></thead>
      <tbody data-rows></tbody></table></div>
      <div style="text-align:center;margin-top:12px"><button class="btn secondary hidden" data-more>Carregar mais</button></div>
    </div>`);

  const rows = $('[data-rows]', el);
  const more = $('[data-more]', el);
  const actionsSel = $('[data-actions]', el);
  const qs = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

  async function load(reset) {
    if (reset) { offset = 0; rows.innerHTML = ''; }
    const res = await api(`/logs?${qs()}&limit=100&offset=${offset}`);
    if (!ctx.isCurrent()) return;
    offset += res.logs.length;
    if (actionsSel.options.length === 1) {
      actionsSel.insertAdjacentHTML('beforeend', String(html`${res.actions.map((a) => html`<option value="${a}">${ACTION_LABELS[a] || a}</option>`)}`));
    }
    if (reset && !res.logs.length) rows.innerHTML = String(html`<tr><td colspan="4" class="empty">Nada encontrado.</td></tr>`);
    rows.insertAdjacentHTML('beforeend', String(html`${res.logs.map((a) => html`<tr>
      <td class="nowrap">${fmtDateTime(a.created_at)}</td>
      <td class="nowrap">${a.user_name || 'Sistema'}</td>
      <td class="nowrap"><span class="tag">${ACTION_LABELS[a.action] || a.action}</span></td>
      <td>${a.summary}${a.ip ? html`<div class="xs muted">IP ${a.ip}</div>` : ''}</td></tr>`)}`));
    more.classList.toggle('hidden', !res.has_more);
  }

  let timer;
  $('[data-filters]', el).oninput = (e) => {
    f[e.target.name] = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => load(true), e.target.name === 'q' ? 350 : 0);
  };
  $('[data-filters]', el).onsubmit = (e) => e.preventDefault();
  more.onclick = () => load(false);
  $('[data-export]', el).onclick = (e) => {
    e.preventDefault();
    location.href = `/api/logs.csv?${qs()}`;
  };
  await load(true);
}
