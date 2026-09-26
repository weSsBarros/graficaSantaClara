import { html, api, LOGO, initials, icon, $, $$ } from '../lib.js';

// Tela de entrada: toca no próprio nome e digita o PIN no teclado numérico.
export async function render({ el, onLogin }) {
  const users = await api('/auth/users');
  let selected = null;
  let pin = '';

  const draw = () => {
    if (!selected) {
      el.innerHTML = String(html`
        <div class="login"><div class="login-box">
          <div class="brand">${LOGO}<div><b>Gráfica Santa Clara</b><span>Estoque e produção</span></div></div>
          <h1 style="text-align:center;margin-bottom:18px">Quem é você?</h1>
          <div class="people">
            ${users.map((u) => html`
              <button class="person" data-id="${u.id}">
                <div class="avatar lg">${initials(u.name)}</div><b>${u.name}</b><span>${u.role_label}</span>
              </button>`)}
          </div>
        </div></div>`);
      $$('.person', el).forEach((b) => {
        b.onclick = () => {
          selected = users.find((u) => String(u.id) === b.dataset.id);
          pin = '';
          draw();
        };
      });
      return;
    }
    el.innerHTML = String(html`
      <div class="login"><div class="login-box">
        <button class="btn ghost sm" data-back>${icon('back')} Trocar pessoa</button>
        <div style="text-align:center;margin-top:8px">
          <div class="avatar lg" style="margin:0 auto 10px">${initials(selected.name)}</div>
          <h1>Olá, ${selected.name}</h1>
          <p class="muted">Digite seu PIN</p>
        </div>
        <form data-form autocomplete="off">
          <input class="sr-only" data-pin type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" aria-label="PIN" autocomplete="current-password">
          <div class="pin-dots" aria-hidden="true"></div>
          <div class="error-text" data-error role="alert"></div>
          <div class="pinpad">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => html`<button type="button" data-key="${n}">${n}</button>`)}
            <button type="button" class="fn" data-key="del" aria-label="Apagar">Apagar</button>
            <button type="button" data-key="0">0</button>
            <button type="submit" class="fn" style="background:var(--accent);color:#fff;border-color:var(--accent)">Entrar</button>
          </div>
        </form>
      </div></div>`);

    const input = $('[data-pin]', el);
    const dots = $('.pin-dots', el);
    const error = $('[data-error]', el);
    const update = () => {
      input.value = pin;
      dots.innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    };
    update();
    // No PC dá para digitar direto no teclado.
    if (matchMedia('(pointer: fine)').matches) input.focus();
    input.oninput = () => {
      pin = input.value.replace(/\D/g, '').slice(0, 8);
      update();
    };
    $('[data-back]', el).onclick = () => { selected = null; draw(); };
    $$('[data-key]', el).forEach((b) => {
      b.onclick = () => {
        error.textContent = '';
        if (b.dataset.key === 'del') pin = pin.slice(0, -1);
        else if (pin.length < 8) pin += b.dataset.key;
        update();
      };
    });
    $('[data-form]', el).onsubmit = async (e) => {
      e.preventDefault();
      if (pin.length < 4) { error.textContent = 'O PIN tem pelo menos 4 números.'; return; }
      const btn = $('button[type=submit]', el);
      btn.disabled = true;
      try {
        await api('/auth/login', { method: 'POST', body: { user_id: selected.id, pin } });
        onLogin();
      } catch (err) {
        error.textContent = err.message;
        pin = '';
        update();
        btn.disabled = false;
      }
    };
  };
  draw();
}
