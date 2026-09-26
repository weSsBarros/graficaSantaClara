// Configurações (Dono/Administração): itens, pessoas e permissões, avisos e sistema.
import {
  html, api, icon, fmtNum, fmtDateTime, plural, parseNum, toast, toastError, promptDialog, confirmDialog,
  colorDot, CATEGORY_LABELS, hasPerm, $, $$,
} from '../lib.js';
import { scanBarcode } from '../scanner.js';

const TABS = [
  ['itens', 'Itens do estoque'],
  ['pessoas', 'Pessoas e permissões'],
  ['avisos', 'Avisos'],
  ['sistema', 'Sistema'],
];

export async function render(ctx) {
  const { el, me, params } = ctx;
  const tab = params.tab || 'itens';
  ctx.setTitle('Configurações', { back: true });
  if (!hasPerm(me, 'cadastros')) throw new Error('Só Dono e Administração acessam as configurações.');
  el.innerHTML = String(html`
    <div class="page-title"><h1>Configurações</h1></div>
    <nav class="tabs">${TABS.map(([k, l]) => html`<a href="#/config/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</nav>
    <div data-tab></div>`);
  const box = $('[data-tab]', el);
  const views = { itens: itemsTab, pessoas: peopleTab, avisos: notifyTab, sistema: systemTab };
  await (views[tab] || itemsTab)(box, ctx);
}

const formData = (form) => Object.fromEntries(new FormData(form));
const num = (s) => (s === '' || s === undefined || s === null ? undefined : parseNum(s));

// ---------- itens ----------

async function itemsTab(box, ctx) {
  const [items, sugg] = await Promise.all([api('/items?all=1'), api('/suggestions')]);
  const editId = ctx.query.edit;
  if (editId) {
    const item = editId === 'novo' ? null : items.find((i) => String(i.id) === editId);
    const full = item ? await api(`/items/${item.id}`) : null;
    return itemForm(box, ctx, full, items, sugg);
  }
  const alertText = (i) => [i.min_stock > 0 ? `< ${fmtNum(i.min_stock)}` : null, i.alert_days > 0 ? `< ${i.alert_days} dias` : null].filter(Boolean).join(' ou ') || 'só zerado';

  box.innerHTML = String(html`
    <div class="row between wrap" style="margin-bottom:12px">
      <p class="muted small">Papéis, impressos, tintas, chapas e outros materiais. Clique em editar para ajustar detalhes e alertas.</p>
      <a class="btn" href="#/config/itens?edit=novo">${icon('plus')} Novo item</a>
    </div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Item</th><th>Categoria</th><th>Unidade</th><th>Avisar quando</th><th>Situação</th><th></th></tr></thead>
      <tbody>${items.map((i) => html`<tr>
        <td>${colorDot(i)}<a href="#/item/${i.id}">${i.name}</a>${i.barcode ? html` <span class="xs muted" title="Tem código de barras">${icon('scan')}</span>` : ''}</td>
        <td>${CATEGORY_LABELS[i.category] || i.category}</td>
        <td>${i.unit}${i.pack_unit ? ` · ${i.pack_unit} de ${fmtNum(i.pack_size)}` : ''}</td>
        <td>${alertText(i)}${i.notify ? '' : html` <span class="tag">sem envio</span>`}</td>
        <td>${i.active ? 'Ativo' : html`<span class="tag">Desativado</span>`}</td>
        <td><a class="btn ghost sm" href="#/config/itens?edit=${i.id}">${icon('edit')} Editar</a></td></tr>`)}</tbody>
    </table></div></div>`);
}

function itemForm(box, ctx, item, items, sugg) {
  const isNew = !item;
  const v = item || { category: 'papel', source: 'compra', unit: 'folha', min_stock: 0, alert_days: 10, lead_time_days: 7, notify: 1, active: 1, sort_order: 0 };
  const papers = items.filter((i) => i.category === 'papel' && i.source === 'compra');
  const hint = item && item.forecast && item.forecast.settings_hint;
  const uniq = (list) => list.filter((x, i, a) => x && a.indexOf(x) === i);
  box.innerHTML = String(html`
    <form class="card" data-form style="max-width:820px">
      <h2 style="margin-bottom:16px">${isNew ? 'Novo item' : html`Editar: ${colorDot(v)}${item.name}`}</h2>
      <fieldset class="group"><legend>Identificação</legend>
        <div class="form-grid cols-2">
          <label class="field full"><span>Nome</span><input class="input" name="name" value="${v.name || ''}" maxlength="80" required placeholder="Ex.: Oferta 46x66, Tinta vermelha"></label>
          <label class="field"><span>Categoria</span><select class="input" name="category" data-cat>
            ${Object.entries(CATEGORY_LABELS).map(([k, l]) => html`<option value="${k}" ${v.category === k ? 'selected' : ''}>${l}</option>`)}</select></label>
          <label class="field"><span>Origem</span><select class="input" name="source" data-source>
            <option value="compra" ${v.source === 'compra' ? 'selected' : ''}>Comprado de fornecedor</option>
            <option value="producao" ${v.source === 'producao' ? 'selected' : ''}>Produzido aqui (impresso)</option></select></label>
          <label class="field" data-made><span>Feito com (papel usado na impressão)</span>
            <select class="input" name="made_from_item_id"><option value="">—</option>
              ${papers.map((p) => html`<option value="${p.id}" ${p.id === v.made_from_item_id ? 'selected' : ''}>${p.name}</option>`)}</select>
            <span class="hint">Na impressão, o sistema desconta este papel automaticamente.</span></label>
        </div>
      </fieldset>

      <fieldset class="group"><legend>Detalhes</legend>
        <div class="form-grid cols-2">
          <label class="field" data-model><span>Modelo / linha</span><input class="input" name="model" value="${v.model || ''}" list="dl-models" maxlength="60" placeholder="Ex.: Oferta, Aproveite, Splash"></label>
          <label class="field" data-size><span>Formato</span><input class="input" name="size" value="${v.size || ''}" list="dl-sizes" maxlength="30" placeholder="Ex.: 46x66"></label>
          <div class="field" data-color><span class="label">Cor</span>
            <div class="input-group"><input class="input" name="color_name" value="${v.color_name || ''}" maxlength="40" placeholder="Ex.: Amarelo">
              <input type="color" name="color_hex" value="${v.color_hex || '#f5c400'}" style="width:56px;min-height:48px;border:1px solid var(--axis);border-radius:12px;padding:4px;background:var(--surface)" aria-label="Escolher a cor"></div></div>
          <label class="field" data-grammage><span>Gramatura (g/m²)</span><input class="input" name="grammage" value="${v.grammage ?? ''}" inputmode="decimal"></label>
          <label class="field"><span>Marca</span><input class="input" name="brand" value="${v.brand || ''}" list="dl-brands" maxlength="60"></label>
          <label class="field"><span>Referência do fornecedor</span><input class="input" name="code" value="${v.code || ''}" maxlength="60"></label>
          <div class="field"><span class="label">Código de barras</span>
            <div class="input-group"><input class="input" name="barcode" value="${v.barcode || ''}" maxlength="64" inputmode="numeric">
              <button type="button" class="btn secondary" data-scan title="Ler com a câmera">${icon('scan')}<span class="sr-only">Ler com a câmera</span></button></div>
            <span class="hint">Para achar o item lendo a embalagem na hora da entrada.</span></div>
        </div>
      </fieldset>

      <fieldset class="group"><legend>Unidade e estoque</legend>
        <div class="form-grid cols-2">
          <label class="field"><span>Unidade de controle</span><input class="input" name="unit" value="${v.unit}" list="dl-units" maxlength="20" required>
            <span class="hint">No singular: folha, litro, chapa, kg...</span></label>
          <div class="form-grid cols-2" style="gap:0 10px">
            <label class="field"><span>Embalagem <span class="muted">(opcional)</span></span><input class="input" name="pack_unit" value="${v.pack_unit || ''}" list="dl-packs" maxlength="20" placeholder="resma"></label>
            <label class="field"><span>Quantas vêm nela</span><input class="input" name="pack_size" value="${v.pack_size ?? ''}" inputmode="decimal" placeholder="500"></label>
          </div>
          ${isNew ? html`<label class="field"><span>Estoque atual <span class="muted">(opcional)</span></span><input class="input" name="initial_quantity" inputmode="decimal" placeholder="0">
            <span class="hint">Quantidade que existe hoje, na unidade de controle.</span></label>` : ''}
          <label class="field" data-lead><span>Prazo do fornecedor para entregar (dias)</span><input class="input" name="lead_time_days" value="${v.lead_time_days}" inputmode="numeric"></label>
        </div>
      </fieldset>

      <fieldset class="group"><legend>Quando avisar</legend>
        ${hint ? html`<div class="hint-box">${icon('info')} Pelo consumo das últimas semanas, sugerimos: avisar abaixo de <b>${fmtNum(hint.min_stock)} ${plural(v.unit, hint.min_stock)}</b>
          ou quando durar menos de <b>${hint.alert_days} dias</b>. <button type="button" class="btn ghost sm" data-use-hint>Usar sugestão</button></div>`
          : html`<p class="hint" style="margin:0 0 12px">Sem histórico ainda: depois de uma semana de uso o sistema sugere valores com base no consumo.</p>`}
        <div class="form-grid cols-2">
          <label class="field"><span>Avisar quando o estoque durar menos de (dias)</span><input class="input" name="alert_days" value="${v.alert_days}" inputmode="numeric">
            <span class="hint">Calculado pelo consumo médio. 0 = não avisar por dias.</span></label>
          <label class="field"><span>Avisar quando tiver menos de (quantidade)</span><input class="input" name="min_stock" value="${v.min_stock}" inputmode="decimal">
            <span class="hint">Quantidade fixa, na unidade de controle. 0 = não avisar por quantidade.</span></label>
        </div>
        <label class="check"><input type="checkbox" name="notify" ${v.notify ? 'checked' : ''}> Enviar o aviso por WhatsApp / e-mail / Telegram (configure em Avisos)</label>
      </fieldset>

      <div class="form-grid cols-2">
        <label class="field full"><span>Observações</span><textarea class="input" name="notes" maxlength="500">${v.notes || ''}</textarea></label>
        <label class="field"><span>Ordem na lista</span><input class="input" name="sort_order" value="${v.sort_order}" inputmode="numeric"></label>
        ${isNew ? '' : html`<label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Item ativo (desmarque para esconder sem apagar o histórico)</label>`}
      </div>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn" type="submit">Salvar</button>
        <a class="btn secondary" href="#/config/itens">Cancelar</a>
      </div>
    </form>
    <datalist id="dl-units">${['folha', 'litro', 'kg', 'chapa', 'unidade', 'cartucho', 'lata', 'rolo', 'pacote'].map((u) => html`<option value="${u}">`)}</datalist>
    <datalist id="dl-packs">${['resma', 'caixa', 'pacote', 'fardo', 'galão', 'lata'].map((u) => html`<option value="${u}">`)}</datalist>
    <datalist id="dl-models">${uniq(['Oferta', 'Aproveite', 'Splash', ...sugg.models]).map((u) => html`<option value="${u}">`)}</datalist>
    <datalist id="dl-sizes">${uniq(['46x66', '96x64', ...sugg.sizes]).map((u) => html`<option value="${u}">`)}</datalist>
    <datalist id="dl-brands">${sugg.brands.map((u) => html`<option value="${u}">`)}</datalist>`);

  const form = $('[data-form]', box);
  const toggle = () => {
    const cat = form.elements.category.value;
    const src = form.elements.source.value;
    $('[data-made]', box).classList.toggle('hidden', src !== 'producao');
    $('[data-lead]', box).classList.toggle('hidden', src !== 'compra');
    $('[data-color]', box).classList.toggle('hidden', cat !== 'tinta');
    $('[data-grammage]', box).classList.toggle('hidden', !['papel', 'impresso'].includes(cat));
    for (const sel of ['[data-model]', '[data-size]']) $(sel, box).classList.toggle('hidden', ['tinta', 'chapa'].includes(cat));
  };
  $('[data-cat]', box).onchange = () => {
    if (form.elements.category.value === 'impresso') form.elements.source.value = 'producao';
    toggle();
  };
  $('[data-source]', box).onchange = toggle;
  toggle();
  const useHint = $('[data-use-hint]', box);
  if (useHint) {
    useHint.onclick = () => {
      form.elements.min_stock.value = hint.min_stock;
      form.elements.alert_days.value = hint.alert_days;
      toast('Sugestão aplicada. Clique em Salvar.');
    };
  }
  $('[data-scan]', box).onclick = async () => {
    const code = await scanBarcode();
    if (code) form.elements.barcode.value = code;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    const isTinta = d.category === 'tinta';
    const body = {
      ...d,
      pack_unit: d.pack_unit || null,
      pack_size: d.pack_unit ? num(d.pack_size) : null,
      min_stock: num(d.min_stock) ?? 0,
      alert_days: num(d.alert_days) ?? 0,
      lead_time_days: d.source === 'compra' ? num(d.lead_time_days) ?? 0 : 0,
      sort_order: num(d.sort_order) ?? 0,
      grammage: ['papel', 'impresso'].includes(d.category) ? num(d.grammage) ?? null : null,
      color_name: isTinta ? d.color_name || null : null,
      color_hex: isTinta && d.color_name ? d.color_hex : null,
      made_from_item_id: d.source === 'producao' && d.made_from_item_id ? Number(d.made_from_item_id) : null,
      initial_quantity: num(d.initial_quantity),
      notify: form.elements.notify.checked,
      active: isNew ? true : form.elements.active.checked,
      barcode: d.barcode || null,
    };
    try {
      await api(isNew ? '/items' : `/items/${item.id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast('Item salvo.');
      ctx.go('#/config/itens');
    } catch (err) {
      toastError(err);
    }
  };
}

// ---------- pessoas e permissões ----------

async function peopleTab(box, ctx) {
  const [users, rolesData] = await Promise.all([api('/users'), api('/roles')]);
  const roles = ctx.me.roles;
  const editable = rolesData.roles.filter((r) => !rolesData.manager_roles.includes(r.id));
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

    <form class="card section" data-perms>
      <div class="card-head"><h2>O que cada função pode fazer</h2>
        <p class="small muted">Dono e Administração podem tudo, sempre (inclusive contagem de estoque, estornos, cadastros e configurações). Todos podem ver estoque, pedidos, painel e histórico.</p></div>
      <div class="table-wrap"><table class="table matrix">
        <thead><tr><th>Permissão</th>${editable.map((r) => html`<th>${r.label}</th>`)}</tr></thead>
        <tbody>${Object.entries(rolesData.perms).map(([p, label]) => html`<tr><td>${label}</td>
          ${editable.map((r) => html`<td><input type="checkbox" name="${r.id}" value="${p}" ${r.perms.includes(p) ? 'checked' : ''} aria-label="${r.label}: ${label}"></td>`)}</tr>`)}</tbody>
      </table></div>
      <button class="btn" type="submit" style="margin-top:12px">Salvar permissões</button>
    </form>`);

  const reload = () => peopleTab(box, ctx);
  $('[data-perms]', box).onsubmit = async (e) => {
    e.preventDefault();
    const body = { roles: {} };
    for (const r of editable) body.roles[r.id] = $$(`input[name="${r.id}"]:checked`, box).map((x) => x.value);
    try { await api('/roles', { method: 'PUT', body }); toast('Permissões salvas. Valem a partir da próxima tela que cada pessoa abrir.'); } catch (err) { toastError(err); }
  };
  $$('[data-role]', box).forEach((s) => {
    s.onchange = async () => {
      try { await api(`/users/${s.dataset.role}`, { method: 'PUT', body: { role: s.value } }); toast('Função alterada.'); } catch (err) { toastError(err); }
      reload();
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
      try { await api(`/users/${b.dataset.reset}/reset-pin`, { method: 'POST', body: { pin } }); toast(`PIN de ${b.dataset.name} redefinido.`); reload(); } catch (err) { toastError(err); }
    };
  });
  $$('[data-toggle]', box).forEach((b) => {
    b.onclick = async () => {
      const activate = b.dataset.active !== '1';
      if (!activate && !(await confirmDialog({ title: `Desativar ${b.dataset.name}?`, body: 'A pessoa não consegue mais entrar. O histórico dela continua guardado.', confirmText: 'Desativar', danger: true }))) return;
      try { await api(`/users/${b.dataset.toggle}`, { method: 'PUT', body: { active: activate } }); toast(activate ? 'Pessoa reativada.' : 'Pessoa desativada.'); reload(); } catch (err) { toastError(err); }
    };
  });
  const form = $('[data-new]', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/users', { method: 'POST', body: formData(form) }); toast('Pessoa cadastrada.'); reload(); } catch (err) { toastError(err); }
  };
}

// ---------- avisos ----------

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

async function notifyTab(box, ctx) {
  const data = await api('/settings/notify');
  const c = data.config;
  const status = Object.fromEntries(data.channels.map((x) => [x.id, x.ready]));
  const badge = (id) => (status[id] ? html`<span class="badge ok">${icon('ok')}Ativo</span>` : html`<span class="tag">Desligado</span>`);
  const secret = (ch, field, label, ph = '') => html`<label class="field"><span>${label}</span>
    <input class="input" name="${ch}.${field}" type="password" autocomplete="new-password" placeholder="${c[ch][`${field}_saved`] || ph}">
    ${c[ch][`${field}_saved`] ? html`<span class="hint">Deixe em branco para manter o que está salvo.</span>` : ''}</label>`;
  const text = (ch, field, label, ph = '', mode = 'text') => html`<label class="field"><span>${label}</span>
    <input class="input" name="${ch}.${field}" value="${c[ch][field] ?? ''}" placeholder="${ph}" autocomplete="off" inputmode="${mode}"></label>`;
  const enabled = (ch, label) => html`<label class="check"><input type="checkbox" name="${ch}.enabled" ${c[ch].enabled ? 'checked' : ''}> ${label}</label>`;
  const testBtn = (ch) => html`<button type="button" class="btn secondary sm" data-test="${ch}">Enviar teste</button>`;
  const hours = Array.from({ length: 16 }, (_, i) => i + 6);

  box.innerHTML = String(html`
    <form data-form>
      <div class="card">
        <div class="card-head"><h2>O que avisar</h2></div>
        ${Object.entries(data.events).map(([k, label]) => html`<label class="check"><input type="checkbox" name="events.${k}" ${c.events[k] ? 'checked' : ''}> ${label}</label>`)}
        <div class="form-grid cols-2" style="margin-top:12px">
          <label class="field"><span>Relatório semanal: dia</span><select class="input" name="weekly.weekday">
            ${WEEKDAYS.map((d, i) => html`<option value="${i}" ${Number(c.weekly.weekday) === i ? 'selected' : ''}>${d}</option>`)}</select></label>
          <label class="field"><span>Relatório semanal: a partir de</span><select class="input" name="weekly.hour">
            ${hours.map((h) => html`<option value="${h}" ${Number(c.weekly.hour) === h ? 'selected' : ''}>${h}h</option>`)}</select></label>
          <label class="field"><span>Resumo diário a partir de</span><select class="input" name="daily.hour">
            ${hours.map((h) => html`<option value="${h}" ${Number(c.daily.hour) === h ? 'selected' : ''}>${h}h</option>`)}</select></label>
          <label class="check"><input type="checkbox" name="weekly.include_finance" ${c.weekly.include_finance ? 'checked' : ''}> Incluir o financeiro no relatório semanal</label>
        </div>
        <p class="hint">O alerta de estoque sai na hora em que o item entra em alerta (só itens com "enviar aviso" marcado no cadastro).</p>
      </div>

      <div class="card section">
        <div class="card-head"><h2>WhatsApp — Evolution API</h2>${badge('evolution')}</div>
        <p class="small muted" style="margin-bottom:12px">Gratuita e de código aberto, instalada no mesmo servidor do sistema (veja o guia de hospedagem). Use um chip só para a gráfica: é uma conexão não oficial com o WhatsApp.</p>
        ${enabled('evolution', 'Usar a Evolution API')}
        <div class="form-grid cols-2" style="margin-top:8px">
          ${text('evolution', 'url', 'Endereço da API', 'https://whatsapp.seudominio.com.br', 'url')}
          ${text('evolution', 'instance', 'Nome da instância', 'grafica')}
          ${secret('evolution', 'apikey', 'Chave da API (apikey)')}
          ${text('evolution', 'numbers', 'Números que recebem (com DDD)', '98 98888-7777, 98 97777-6666', 'tel')}
        </div>${testBtn('evolution')}
      </div>

      <div class="card section">
        <div class="card-head"><h2>WhatsApp — CallMeBot</h2>${badge('callmebot')}</div>
        <p class="small muted" style="margin-bottom:12px">Gratuito e sem servidor. Cada pessoa manda "I allow callmebot to send me messages" para o número do CallMeBot e recebe uma apikey. É para uso pessoal e às vezes fica lotado.</p>
        ${enabled('callmebot', 'Usar o CallMeBot')}
        <div style="margin-top:8px">${secret('callmebot', 'recipients', 'Destinatários (telefone:apikey, separados por vírgula)', '98988887777:123456, 98977776666:654321')}</div>
        ${testBtn('callmebot')}
      </div>

      <div class="card section">
        <div class="card-head"><h2>E-mail</h2>${badge('email')}</div>
        <p class="small muted" style="margin-bottom:12px">Pode ser um Gmail com "senha de app" (smtp.gmail.com, porta 465) ou um serviço gratuito de envio (ex.: Brevo).</p>
        ${enabled('email', 'Enviar por e-mail')}
        <div class="form-grid cols-2" style="margin-top:8px">
          ${text('email', 'host', 'Servidor SMTP', 'smtp.gmail.com')}
          ${text('email', 'port', 'Porta', '465', 'numeric')}
          ${text('email', 'user', 'Usuário', 'graficasantaclara@gmail.com', 'email')}
          ${secret('email', 'pass', 'Senha (senha de app)')}
          ${text('email', 'from', 'Remetente', 'Gráfica Santa Clara <graficasantaclara@gmail.com>')}
          ${text('email', 'to', 'Quem recebe (separe por vírgula)', 'marcia@..., joatan@...', 'email')}
        </div>
        <label class="check"><input type="checkbox" name="email.secure" ${c.email.secure ? 'checked' : ''}> Conexão segura direta (porta 465)</label>
        ${testBtn('email')}
      </div>

      <div class="card section">
        <div class="card-head"><h2>Telegram</h2>${badge('telegram')}</div>
        <p class="small muted" style="margin-bottom:12px">Gratuito e estável. Crie um bot com o @BotFather e adicione-o a um grupo.</p>
        ${enabled('telegram', 'Usar o Telegram')}
        <div class="form-grid cols-2" style="margin-top:8px">
          ${secret('telegram', 'token', 'Token do bot')}
          ${text('telegram', 'chat_id', 'ID do grupo/conversa', '-1001234567890')}
        </div>${testBtn('telegram')}
      </div>

      <div class="row wrap section"><button class="btn" type="submit">Salvar avisos</button></div>
    </form>

    <div class="card section">
      <div class="card-head"><h2>Prévia do relatório semanal</h2>
        <div class="row"><button class="btn secondary sm" data-preview>Atualizar prévia</button><button class="btn sm" data-send-report>Enviar agora</button></div></div>
      <pre class="report" data-report>Clique em "Atualizar prévia".</pre>
    </div>`);

  const form = $('[data-form]', box);
  const collect = () => {
    const body = {};
    for (const input of form.elements) {
      if (!input.name || !input.name.includes('.')) continue;
      const [ch, field] = input.name.split('.');
      body[ch] = body[ch] || {};
      body[ch][field] = input.type === 'checkbox' ? input.checked : input.value;
    }
    return body;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/settings/notify', { method: 'PUT', body: collect() }); toast('Avisos salvos.'); notifyTab(box, ctx); } catch (err) { toastError(err); }
  };
  $$('[data-test]', box).forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/settings/notify', { method: 'PUT', body: collect() });
        const r = await api('/settings/test-notification', { method: 'POST', body: { channel: b.dataset.test } });
        const res = r.results[0];
        toast(res && res.sent ? 'Mensagem de teste enviada!' : `Não enviou: ${res ? res.reason : 'canal desligado'}`, { error: !(res && res.sent), ms: 8000 });
      } catch (err) { toastError(err); }
    };
  });
  const reportBox = $('[data-report]', box);
  $('[data-preview]', box).onclick = async () => {
    try { const r = await api('/reports/weekly'); reportBox.textContent = r.text + (r.daily ? `\n\n— Resumo diário de hoje —\n${r.daily}` : ''); } catch (err) { toastError(err); }
  };
  $('[data-send-report]', box).onclick = async () => {
    try {
      const r = await api('/reports/weekly/send', { method: 'POST', body: {} });
      toast(r.sent ? 'Relatório enviado.' : 'Nenhum canal de aviso ativo ou o envio falhou (veja o registro de atividades).', { error: !r.sent });
    } catch (err) { toastError(err); }
  };
}

// ---------- sistema ----------

async function systemTab(box) {
  const s = await api('/settings');
  box.innerHTML = String(html`
    <div class="grid-2">
      <form class="card" data-form>
        <h2 style="margin-bottom:14px">Previsões</h2>
        ${Object.entries(s.settings).map(([k, x]) => html`<label class="field"><span>${x.label}</span>
          <input class="input" name="${k}" value="${x.value}" inputmode="numeric">
          <span class="hint">Entre ${x.min} e ${x.max} dias.</span></label>`)}
        <button class="btn" type="submit">Salvar</button>
      </form>
      <div class="card">
        <h2 style="margin-bottom:10px">Cópia de segurança</h2>
        <p class="muted small">O sistema guarda automaticamente uma cópia por dia (últimos 30 dias) na pasta <code>data/backups</code>.
          Baixe uma cópia de vez em quando e guarde fora do servidor (pen drive, Google Drive).</p>
        <a class="btn secondary" style="margin-top:12px" href="/api/backup">${icon('download')} Baixar cópia agora</a>
      </div>
    </div>`);
  const form = $('[data-form]', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of Object.entries(formData(form))) body[k] = Number(v);
    try { await api('/settings', { method: 'PUT', body }); toast('Configurações salvas.'); } catch (err) { toastError(err); }
  };
}
