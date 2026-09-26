import { html, api, toast, icon, $ } from '../lib.js';

export async function render(ctx) {
  const { el, me } = ctx;
  const forced = me.user.must_change_pin;
  ctx.setTitle('Trocar meu PIN');
  el.innerHTML = String(html`
    <div class="page-title"><h1>Trocar meu PIN</h1></div>
    <div class="card" style="max-width:480px">
      ${forced ? html`<div class="notice info">${icon('info')}<span>Por segurança, crie agora o seu PIN pessoal. Ele é só seu: não compartilhe com ninguém.</span></div>` : ''}
      <form data-form>
        <label class="field"><span>${forced ? 'PIN que você recebeu' : 'PIN atual'}</span>
          <input class="input" name="current" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" required autocomplete="current-password">
        </label>
        <label class="field"><span>Novo PIN (4 a 8 números)</span>
          <input class="input" name="next" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" required autocomplete="new-password">
          <span class="hint">Evite datas de aniversário e números repetidos (1111) ou em sequência (1234).</span>
        </label>
        <label class="field"><span>Repita o novo PIN</span>
          <input class="input" name="again" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" required autocomplete="new-password">
        </label>
        <button class="btn block" type="submit">Salvar novo PIN</button>
      </form>
    </div>`);
  const form = $('[data-form]', el);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    if (f.get('next') !== f.get('again')) return toast('Os dois PINs novos não são iguais.', { error: true });
    try {
      await api('/auth/change-pin', { method: 'POST', body: { current_pin: f.get('current'), new_pin: f.get('next') } });
      toast('PIN alterado!');
      await ctx.refreshMe();
      ctx.go('#/');
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
}
