import { html, icon, initials, $ } from '../lib.js';

export async function render(ctx) {
  const { el, me } = ctx;
  ctx.setTitle('Mais');
  const p = me.perms;
  el.innerHTML = String(html`
    <div class="card">
      <div class="row" style="gap:14px">
        <div class="avatar lg">${initials(me.user.name)}</div>
        <div><h2>${me.user.name}</h2><p class="muted">${me.user.role_label}</p></div>
      </div>
    </div>
    <div class="card">
      <ul class="menu">
        ${p.includes('ver_financeiro') ? html`<li><a href="#/financeiro">${icon('money')}Financeiro</a></li>` : ''}
        <li><a href="#/historico">${icon('clock')}Histórico de lançamentos</a></li>
        ${p.includes('ver_logs') ? html`<li><a href="#/logs">${icon('log')}Registro de atividades</a></li>` : ''}
        ${p.includes('cadastros') ? html`<li><a href="#/config">${icon('settings')}Configurações (itens, pessoas...)</a></li>` : ''}
        <li><a href="#/pin">${icon('key')}Trocar meu PIN</a></li>
        <li><button data-logout>${icon('logout')}Sair</button></li>
      </ul>
    </div>
    <p class="xs muted" style="text-align:center;margin-top:16px">Gráfica Santa Clara · São Luís - MA</p>`);
  $('[data-logout]', el).onclick = ctx.logout;
}
