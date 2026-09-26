// Configurações (só Dono/Administração): itens, processos, pessoas e sistema.
import {
  html, api, icon, fmtNum, fmtDateTime, plural, parseNum, toast, toastError, promptDialog, confirmDialog, CATEGORY_LABELS, $, $$,
} from '../lib.js';

const TABS = [
  ['itens', 'Itens do estoque'],
  ['processos', 'Processos'],
  ['pessoas', 'Pessoas'],
  ['sistema', 'Sistema'],
];

export async function render(ctx) {
  const { el, me, params } = ctx;
  const tab = params.tab || 'itens';
  ctx.setTitle('Configurações', { back: true });
  if (!me.perms.includes('cadastros')) throw new Error('Só Dono e Administração acessam as configurações.');
  el.innerHTML = String(html`
    <div class="page-title"><h1>Configurações</h1></div>
    <nav class="tabs">${TABS.map(([k, l]) => html`<a href="#/config/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</nav>
    <div data-tab></div>`);
  const box = $('[data-tab]', el);
  const views = { itens: itemsTab, processos: processesTab, pessoas: peopleTab, sistema: systemTab };
  await (views[tab] || itemsTab)(box, ctx);
}

const formData = (form) => Object.fromEntries(new FormData(form));

// ---------- itens ----------

async function itemsTab(box, ctx) {
  const items = await api('/items?all=1');
  const editId = ctx.query.edit;
  if (editId) return itemForm(box, ctx, editId === 'novo' ? null : items.find((i) => String(i.id) === editId));

  box.innerHTML = String(html`
    <div class="row between" style="margin-bottom:12px">
      <p class="muted small">Papéis, tintas e outros materiais controlados.</p>
      <a class="btn" href="#/config/itens?edit=novo">${icon('plus')} Novo item</a>
    </div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Item</th><th>Categoria</th><th>Unidade</th><th class="r">Mínimo</th><th class="r">Reposição</th><th>Situação</th><th></th></tr></thead>
      <tbody>${items.map((i) => html`<tr>
        <td><a href="#/item/${i.id}">${i.name}</a></td>
        <td>${CATEGORY_LABELS[i.category]}${i.source === 'producao' ? ' (produzido)' : ''}</td>
        <td>${i.unit}${i.pack_unit ? ` · ${i.pack_unit} de ${fmtNum(i.pack_size)}` : ''}</td>
        <td class="r">${fmtNum(i.min_stock)}</td>
        <td class="r">${i.source === 'compra' ? `${i.lead_time_days} dias` : '—'}</td>
        <td>${i.active ? 'Ativo' : html`<span class="tag">Desativado</span>`}</td>
        <td><a class="btn ghost sm" href="#/config/itens?edit=${i.id}">${icon('edit')} Editar</a></td></tr>`)}</tbody>
    </table></div></div>`);
}

function itemForm(box, ctx, item) {
  const isNew = !item;
  const v = item || { category: 'papel', source: 'compra', unit: 'folha', min_stock: 0, lead_time_days: 7, active: 1, sort_order: 0 };
  box.innerHTML = String(html`
    <form class="card" data-form style="max-width:720px">
      <h2 style="margin-bottom:16px">${isNew ? 'Novo item' : `Editar: ${item.name}`}</h2>
      <div class="form-grid cols-2">
        <label class="field full"><span>Nome</span><input class="input" name="name" value="${v.name || ''}" maxlength="80" required placeholder="Ex.: Tinta preta"></label>
        <label class="field"><span>Categoria</span><select class="input" name="category">
          ${Object.entries(CATEGORY_LABELS).map(([k, l]) => html`<option value="${k}" ${v.category === k ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label class="field"><span>Origem</span><select class="input" name="source">
          <option value="compra" ${v.source === 'compra' ? 'selected' : ''}>Comprado de fornecedor</option>
          <option value="producao" ${v.source === 'producao' ? 'selected' : ''}>Produzido aqui (ex.: folha impressa)</option></select></label>
        <label class="field"><span>Unidade de controle</span><input class="input" name="unit" value="${v.unit}" list="dl-units" maxlength="20" required>
          <span class="hint">No singular: folha, litro, kg, cartucho...</span></label>
        <div class="form-grid cols-2" style="gap:0 10px">
          <label class="field"><span>Embalagem <span class="muted">(opcional)</span></span><input class="input" name="pack_unit" value="${v.pack_unit || ''}" list="dl-packs" maxlength="20" placeholder="resma"></label>
          <label class="field"><span>Quantas vêm nela</span><input class="input" name="pack_size" value="${v.pack_size ?? ''}" inputmode="decimal" placeholder="500"></label>
        </div>
        <label class="field"><span>Estoque mínimo</span><input class="input" name="min_stock" value="${v.min_stock}" inputmode="decimal" required>
          <span class="hint">Abaixo disso o item fica "Estoque baixo".</span></label>
        <label class="field"><span>Prazo de reposição (dias)</span><input class="input" name="lead_time_days" value="${v.lead_time_days}" inputmode="numeric">
          <span class="hint">Quanto tempo o fornecedor leva para entregar. Usado no alerta "Repor já".</span></label>
        ${isNew ? html`<label class="field"><span>Estoque atual <span class="muted">(opcional)</span></span><input class="input" name="initial_quantity" inputmode="decimal" placeholder="0">
          <span class="hint">Quantidade que existe hoje, na unidade de controle.</span></label>` : ''}
        <label class="field"><span>Ordem na lista</span><input class="input" name="sort_order" value="${v.sort_order}" inputmode="numeric"></label>
        <label class="field full"><span>Observações</span><textarea class="input" name="notes" maxlength="500">${v.notes || ''}</textarea></label>
        ${isNew ? '' : html`<label class="check full"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Item ativo (desmarque para esconder sem apagar o histórico)</label>`}
      </div>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn" type="submit">Salvar</button>
        <a class="btn secondary" href="#/config/itens">Cancelar</a>
      </div>
    </form>
    <datalist id="dl-units">${['folha', 'litro', 'kg', 'unidade', 'cartucho', 'lata', 'rolo', 'pacote', 'metro'].map((u) => html`<option value="${u}">`)}</datalist>
    <datalist id="dl-packs">${['resma', 'caixa', 'pacote', 'fardo', 'galão', 'lata'].map((u) => html`<option value="${u}">`)}</datalist>`);
  const form = $('[data-form]', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    const num = (s) => (s === '' || s === undefined ? undefined : parseNum(s));
    const body = {
      ...d,
      pack_unit: d.pack_unit || null,
      pack_size: d.pack_unit ? num(d.pack_size) : null,
      min_stock: num(d.min_stock) ?? 0,
      lead_time_days: num(d.lead_time_days) ?? 0,
      sort_order: num(d.sort_order) ?? 0,
      initial_quantity: num(d.initial_quantity),
      active: isNew ? true : form.elements.active.checked,
    };
    try {
      await api(isNew ? '/items' : `/items/${item.id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast('Item salvo.');
      await ctx.refreshMe();
      ctx.go('#/config/itens');
    } catch (err) {
      toastError(err);
    }
  };
}

// ---------- processos ----------

async function processesTab(box, ctx) {
  const [procs, items] = await Promise.all([api('/processes'), api('/items?all=1')]);
  const roles = ctx.me.roles;
  const editId = ctx.query.edit;
  const roleLabel = (r) => (roles.find((x) => x.id === r) || { label: r }).label;

  if (editId) {
    const p = editId === 'novo' ? null : procs.find((x) => String(x.id) === editId);
    const v = p || { kind: 'impressao', roles: '', active: 1 };
    const sel = (name, value, allowEmpty) => html`<select class="input" name="${name}">
      ${allowEmpty ? html`<option value="">— nenhum —</option>` : ''}
      ${items.map((i) => html`<option value="${i.id}" ${i.id === value ? 'selected' : ''}>${i.name}</option>`)}</select>`;
    box.innerHTML = String(html`
      <form class="card" data-form style="max-width:640px">
        <h2 style="margin-bottom:16px">${p ? `Editar: ${p.name}` : 'Novo processo'}</h2>
        <label class="field"><span>Nome</span><input class="input" name="name" value="${v.name || ''}" required maxlength="60" placeholder="Ex.: Impressão"></label>
        <label class="field"><span>Tipo</span><select class="input" name="kind">
          <option value="impressao" ${v.kind === 'impressao' ? 'selected' : ''}>Impressão (consome um item e gera outro, com perda)</option>
          <option value="empacotamento" ${v.kind === 'empacotamento' ? 'selected' : ''}>Empacotamento (separa em pacotes por cliente)</option></select></label>
        <label class="field"><span>Item consumido</span>${sel('input_item_id', v.input_item_id, false)}</label>
        <label class="field"><span>Item gerado <span class="muted">(opcional)</span></span>${sel('output_item_id', v.output_item_id, true)}
          <span class="hint">Na impressão: a folha impressa. No empacotamento, se escolher um item (ex.: "Pacotes prontos"), cada pacote entra nele.</span></label>
        <div class="field"><span class="label">Quem pode registrar</span>
          ${roles.filter((r) => !['dono', 'admin'].includes(r.id)).map((r) => html`<label class="check"><input type="checkbox" name="roles" value="${r.id}" ${String(v.roles).split(',').includes(r.id) ? 'checked' : ''}> ${r.label}</label>`)}
          <span class="hint">Dono e Administração sempre podem.</span></div>
        ${p ? html`<label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Processo ativo</label>` : ''}
        <div class="row wrap" style="margin-top:12px"><button class="btn" type="submit">Salvar</button>
          <a class="btn secondary" href="#/config/processos">Cancelar</a></div>
      </form>`);
    const form = $('[data-form]', box);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        name: form.elements.name.value,
        kind: form.elements.kind.value,
        input_item_id: Number(form.elements.input_item_id.value),
        output_item_id: form.elements.output_item_id.value ? Number(form.elements.output_item_id.value) : null,
        roles: $$('input[name=roles]:checked', form).map((x) => x.value),
        active: p ? form.elements.active.checked : true,
      };
      try {
        await api(p ? `/processes/${p.id}` : '/processes', { method: p ? 'PUT' : 'POST', body });
        toast('Processo salvo.');
        await ctx.refreshMe();
        ctx.go('#/config/processos');
      } catch (err) {
        toastError(err);
      }
    };
    return;
  }

  box.innerHTML = String(html`
    <div class="row between" style="margin-bottom:12px">
      <p class="muted small">Etapas de produção que viram botões na tela inicial de quem pode registrá-las.</p>
      <a class="btn" href="#/config/processos?edit=novo">${icon('plus')} Novo processo</a>
    </div>
    <div class="card"><ul class="list">${procs.map((p) => html`<li class="row between wrap">
      <div><b>${p.name}</b> ${p.active ? '' : html`<span class="tag">Desativado</span>`}
        <div class="small muted">${p.kind_label}: ${p.input_name} → ${p.output_name || 'sem item gerado'}</div>
        <div class="small muted">Quem registra: ${p.roles ? p.roles.split(',').map(roleLabel).join(', ') : 'só Dono/Administração'}</div></div>
      <a class="btn ghost sm" href="#/config/processos?edit=${p.id}">${icon('edit')} Editar</a></li>`)}</ul></div>`);
}

// ---------- pessoas ----------

async function peopleTab(box, ctx) {
  const users = await api('/users');
  const roles = ctx.me.roles;
  box.innerHTML = String(html`
    <div class="grid-2">
      <div class="card">
        <h2 style="margin-bottom:8px">Pessoas</h2>
        <ul class="list">${users.map((u) => html`<li>
          <div class="row between wrap">
            <div><b>${u.name}</b> ${u.active ? '' : html`<span class="tag">Desativado</span>`}
              ${u.locked_until && Date.parse(u.locked_until) > Date.now() ? html`<span class="tag">Bloqueado</span>` : ''}
              <div class="small muted">${u.role_label} · último acesso: ${u.last_login ? fmtDateTime(u.last_login) : 'nunca'}${u.must_change_pin ? ' · ainda não criou o PIN' : ''}</div></div>
          </div>
          <div class="row wrap" style="margin-top:8px">
            <select class="input" data-role="${u.id}" style="min-height:36px;width:auto;padding:4px 10px;font-size:.9rem" aria-label="Função de ${u.name}">
              ${roles.map((r) => html`<option value="${r.id}" ${r.id === u.role ? 'selected' : ''}>${r.label}</option>`)}</select>
            <button class="btn secondary sm" data-reset="${u.id}" data-name="${u.name}">${icon('key')} Novo PIN</button>
            ${u.id !== ctx.me.user.id ? html`<button class="btn ${u.active ? 'danger' : 'secondary'} sm" data-toggle="${u.id}" data-active="${u.active}" data-name="${u.name}">${u.active ? 'Desativar' : 'Reativar'}</button>` : ''}
          </div></li>`)}</ul>
      </div>
      <form class="card" data-new>
        <h2 style="margin-bottom:14px">Cadastrar pessoa</h2>
        <label class="field"><span>Nome</span><input class="input" name="name" required maxlength="60"></label>
        <label class="field"><span>Função</span><select class="input" name="role" required>
          <option value="" disabled selected>Escolha a função</option>
          ${roles.map((r) => html`<option value="${r.id}">${r.label}</option>`)}</select></label>
        <label class="field"><span>PIN provisório</span><input class="input" name="pin" inputmode="numeric" maxlength="8" required>
          <span class="hint">A pessoa cria o próprio PIN no primeiro acesso.</span></label>
        <button class="btn" type="submit">${icon('plus')} Cadastrar</button>
      </form>
    </div>
    <div class="card section">
      <h2 style="margin-bottom:8px">O que cada função pode fazer</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Função</th><th>Pode</th></tr></thead>
        <tbody>
          <tr><td>Dono / Administração</td><td>Tudo: lançamentos, contagem de estoque, estornos, cadastros, configurações, backup e registro de atividades.</td></tr>
          <tr><td>Secretaria</td><td>Entradas, retiradas e ver o registro de atividades.</td></tr>
          <tr><td>Impressor</td><td>Impressão, entradas, retiradas (ex.: tinta) e manutenção das máquinas.</td></tr>
          <tr><td>Empacotadora</td><td>Empacotamento e retiradas.</td></tr>
          <tr><td>Todos</td><td>Ver estoque, painel e histórico. Desfazer o próprio lançamento em até ${ctx.me.config.self_undo_minutes} minutos.</td></tr>
        </tbody></table></div>
    </div>`);

  const reload = () => peopleTab(box, ctx);
  $$('[data-role]', box).forEach((s) => {
    s.onchange = async () => {
      try {
        await api(`/users/${s.dataset.role}`, { method: 'PUT', body: { role: s.value } });
        toast('Função alterada.');
        reload();
      } catch (err) {
        toastError(err);
        reload();
      }
    };
  });
  $$('[data-reset]', box).forEach((b) => {
    b.onclick = async () => {
      const pin = await promptDialog({
        title: `Novo PIN para ${b.dataset.name}`,
        body: 'Use quando a pessoa esquecer o PIN. Ela vai criar um PIN novo no próximo acesso.',
        label: 'PIN provisório (4 a 8 números)', inputmode: 'numeric', confirmText: 'Redefinir',
      });
      if (!pin) return;
      try {
        await api(`/users/${b.dataset.reset}/reset-pin`, { method: 'POST', body: { pin } });
        toast(`PIN de ${b.dataset.name} redefinido.`);
        reload();
      } catch (err) { toastError(err); }
    };
  });
  $$('[data-toggle]', box).forEach((b) => {
    b.onclick = async () => {
      const activate = b.dataset.active !== '1';
      if (!activate && !(await confirmDialog({ title: `Desativar ${b.dataset.name}?`, body: 'A pessoa não consegue mais entrar. O histórico dela continua guardado.', confirmText: 'Desativar', danger: true }))) return;
      try {
        await api(`/users/${b.dataset.toggle}`, { method: 'PUT', body: { active: activate } });
        toast(activate ? 'Pessoa reativada.' : 'Pessoa desativada.');
        reload();
      } catch (err) { toastError(err); }
    };
  });
  const form = $('[data-new]', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: formData(form) });
      toast('Pessoa cadastrada.');
      reload();
    } catch (err) { toastError(err); }
  };
}

// ---------- sistema ----------

async function systemTab(box, ctx) {
  const s = await api('/settings');
  const canSys = ctx.me.perms.includes('sistema');
  box.innerHTML = String(html`
    <div class="grid-2">
      <form class="card" data-form>
        <h2 style="margin-bottom:14px">Previsões</h2>
        ${Object.entries(s.settings).map(([k, x]) => html`<label class="field"><span>${x.label}</span>
          <input class="input" name="${k}" value="${x.value}" inputmode="numeric" ${canSys ? '' : 'disabled'}>
          <span class="hint">Entre ${x.min} e ${x.max} ${plural('dia', 2)}.</span></label>`)}
        ${canSys ? html`<button class="btn" type="submit">Salvar</button>` : ''}
      </form>
      <div class="card">
        <h2 style="margin-bottom:10px">Avisos no celular (Telegram)</h2>
        ${s.telegram
          ? html`<p>Ativo. Quando um item entra em alerta, uma mensagem é enviada ao grupo configurado.</p>
              ${canSys ? html`<button class="btn secondary" data-test style="margin-top:12px">Enviar mensagem de teste</button>` : ''}`
          : html`<p class="muted">Desativado. Para receber os alertas de estoque no celular, siga o passo a passo "Avisos pelo Telegram" no arquivo LEIAME/README do sistema.</p>`}
        <h2 style="margin:24px 0 10px">Cópia de segurança</h2>
        <p class="muted small">O sistema guarda automaticamente uma cópia por dia (últimos 30 dias) na pasta <code>data/backups</code>.
          Baixe uma cópia de vez em quando e guarde fora deste computador (pen drive, Google Drive).</p>
        ${canSys ? html`<a class="btn secondary" style="margin-top:12px" href="/api/backup">${icon('download')} Baixar cópia agora</a>` : ''}
      </div>
    </div>`);
  const form = $('[data-form]', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of Object.entries(formData(form))) body[k] = Number(v);
    try {
      await api('/settings', { method: 'PUT', body });
      toast('Configurações salvas.');
    } catch (err) { toastError(err); }
  };
  const test = $('[data-test]', box);
  if (test) {
    test.onclick = async () => {
      try {
        const r = await api('/settings/test-notification', { method: 'POST', body: {} });
        toast(r.sent ? 'Mensagem enviada! Confira o Telegram.' : `Não foi possível enviar: ${r.reason}`, { error: !r.sent });
      } catch (err) { toastError(err); }
    };
  }
}
