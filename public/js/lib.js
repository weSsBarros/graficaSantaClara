// Utilitários do app: HTML seguro, formatação pt-BR, chamadas à API, avisos e diálogos.

// ---------- HTML seguro (tudo que vem de fora é escapado automaticamente) ----------

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Safe(String(s));

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function val(v) {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += val(v) + strings[i + 1]; });
  return new Safe(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- números e datas ----------

const nfCache = new Map();
export function fmtNum(n, max = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (!nfCache.has(max)) nfCache.set(max, new Intl.NumberFormat('pt-BR', { maximumFractionDigits: max }));
  return nfCache.get(max).format(n);
}

/** Médias: sem casas decimais para números grandes (8.067), com até 2 para pequenos (1,07). */
export const fmtAvg = (n) => fmtNum(n, Math.abs(n) >= 100 ? 0 : 2);

export function fmtCompact(n) {
  if (Math.abs(n) < 10000) return fmtNum(n, 1);
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function plural(unit, n) {
  if (!unit) return '';
  if (Math.abs(n) < 2) return unit; // em português: 1 folha, 1,5 litro, 2 folhas
  if (unit.length <= 2 || /[^a-zà-ú]$/i.test(unit)) return unit;
  if (/[aeiouáéíóú]$/i.test(unit)) return `${unit}s`;
  if (/m$/i.test(unit)) return `${unit.slice(0, -1)}ns`;
  if (/[rz]$/i.test(unit)) return `${unit}es`;
  if (/l$/i.test(unit)) return `${unit.slice(0, -1)}is`;
  return unit;
}

export const fmtQty = (n, unit) => `${fmtNum(n)} ${plural(unit, n)}`.trim();

/** "40 resmas" para um item com embalagem; vazio se não tiver. */
export function packText(item, n) {
  const size = item.pack_size ?? item.input_pack_size;
  const unit = item.pack_unit ?? item.input_pack_unit;
  if (!unit || !(size > 0)) return '';
  return fmtQty(Math.round((n / size) * 100) / 100, unit);
}

/** Aceita "1.500", "1500", "2,5", "2.5". */
export function parseNum(s) {
  let t = String(s ?? '').trim().replace(/\s/g, '');
  if (!t) return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  return Number(t);
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtDay(day) {
  if (!day) return '—';
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}
export function fmtDate(iso) {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
export function fmtDateTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return `hoje, ${time}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return `ontem, ${time}`;
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? `${date}, ${time}` : `${date}/${d.getFullYear()}, ${time}`;
}
export function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Valor para <input type=datetime-local>. */
export function localInputValue(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const initials = (name) => String(name || '?').trim().slice(0, 1).toUpperCase();

export const CATEGORY_LABELS = { papel: 'Papel', impresso: 'Cartazes', tinta: 'Tinta', chapa: 'Chapa', embalagem: 'Embalagem', outro: 'Outros' };

const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** R$ 1.234,56 */
export const brl = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : brlFmt.format(n));

/** Bolinha com a cor do item (tintas). */
export function colorDot(item) {
  if (!item.color_hex) return '';
  return html`<i class="swatch" style="background:${item.color_hex}" title="${item.color_name || item.color_hex}"></i>`;
}

/** Etiquetas de modelo/formato/cor para mostrar junto do nome. */
export function itemTags(item) {
  const tags = [item.model, item.size, item.color_name, item.grammage ? `${fmtNum(item.grammage)} g/m²` : null, item.brand].filter(Boolean);
  if (!tags.length) return '';
  return html`<span class="tags">${tags.map((t) => html`<span class="tag">${t}</span>`)}</span>`;
}

export const hasPerm = (me, p) => me.perms.includes(p);

/** Telefone (toca para ligar) e endereço (abre no mapa) do cliente — para quem faz a entrega. */
export function contactLinks(phone, address) {
  const tel = String(phone || '').replace(/[^\d+]/g, '');
  const parts = [
    phone && (tel.length >= 8 ? html`<a href="tel:${tel}">${phone}</a>` : html`${phone}`),
    address && html`<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}" target="_blank" rel="noopener">${address}</a>`,
  ].filter(Boolean);
  return html`${parts.map((x, i) => (i ? html` · ${x}` : x))}`;
}

const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** "2026-09" -> "setembro de 2026" (ou "set/26" no modo curto). */
export function fmtMonth(ym, short = false) {
  const [y, m] = ym.split('-').map(Number);
  return short ? `${MONTH_NAMES[m - 1].slice(0, 3)}/${String(y).slice(2)}` : `${MONTH_NAMES[m - 1]} de ${y}`;
}
/** "2026-09-26" -> "26/09/2026" */
export const fmtDmy = (day) => (day ? day.split('-').reverse().join('/') : '—');

// ---------- API ----------

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-Requested-With': 'gsc' } : { 'X-Requested-With': 'gsc' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Sem conexão com o sistema. Verifique a internet/Wi-Fi e tente de novo.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new CustomEvent('gsc:logout'));
  }
  if (!res.ok) throw new ApiError(data.error || `Erro ${res.status}`, res.status);
  return data;
}

// ---------- avisos e diálogos ----------

export function toast(message, { error = false, ms = 3500 } = {}) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const toastError = (err) => toast(err.message || String(err), { error: true, ms: 6000 });

function openDialog(content, onReady) {
  const dlg = document.getElementById('dialog');
  dlg.innerHTML = String(content);
  return new Promise((resolve) => {
    const done = (value) => {
      dlg.close();
      resolve(value);
    };
    dlg.onclose = () => resolve(undefined);
    dlg.oncancel = () => resolve(undefined);
    onReady(dlg, done);
    dlg.showModal();
  });
}

/** Pergunta de confirmação. Retorna true/false. */
export async function confirmDialog({ title, body = '', confirmText = 'Confirmar', cancelText = 'Voltar', danger = false }) {
  const content = html`
    <div class="dialog-body">
      <h2>${title}</h2>
      <div class="muted">${body}</div>
    </div>
    <div class="dialog-actions">
      <button class="btn secondary" data-no>${cancelText}</button>
      <button class="btn ${danger ? 'danger' : ''}" data-yes>${confirmText}</button>
    </div>`;
  const result = await openDialog(content, (dlg, done) => {
    dlg.querySelector('[data-no]').onclick = () => done(false);
    dlg.querySelector('[data-yes]').onclick = () => done(true);
    setTimeout(() => dlg.querySelector('[data-yes]').focus(), 0);
  });
  return result === true;
}

/** Pede um texto (ex.: motivo do estorno). Retorna o texto ou null. */
export async function promptDialog({ title, body = '', label, placeholder = '', value = '', confirmText = 'Confirmar', danger = false, inputmode = 'text', type = 'text' }) {
  const content = html`
    <form class="dialog-body" data-form>
      <h2>${title}</h2>
      ${body ? html`<p class="muted" style="margin-bottom:14px">${body}</p>` : ''}
      <label class="field"><span>${label}</span>
        <input class="input" name="value" type="${type}" inputmode="${inputmode}" placeholder="${placeholder}" value="${value}" required autocomplete="off">
      </label>
    </form>
    <div class="dialog-actions">
      <button class="btn secondary" data-no type="button">Voltar</button>
      <button class="btn ${danger ? 'danger' : ''}" data-yes type="button">${confirmText}</button>
    </div>`;
  const result = await openDialog(content, (dlg, done) => {
    const input = dlg.querySelector('input');
    const submit = () => {
      if (!input.value.trim()) { input.focus(); return; }
      done(input.value.trim());
    };
    dlg.querySelector('[data-no]').onclick = () => done(null);
    dlg.querySelector('[data-yes]').onclick = submit;
    dlg.querySelector('[data-form]').onsubmit = (e) => { e.preventDefault(); submit(); };
    setTimeout(() => input.focus(), 0);
  });
  return typeof result === 'string' ? result : null;
}

/** Diálogo com campos: devolve os valores do formulário (objeto) ou null se voltar. */
export async function formDialog({ title, body, confirmText = 'Salvar', danger = false }) {
  const content = html`
    <form class="dialog-body" data-form>
      <h2>${title}</h2>
      ${body}
    </form>
    <div class="dialog-actions">
      <button class="btn secondary" data-no type="button">Voltar</button>
      <button class="btn ${danger ? 'danger' : ''}" data-yes type="button">${confirmText}</button>
    </div>`;
  const result = await openDialog(content, (dlg, done) => {
    const form = dlg.querySelector('[data-form]');
    const submit = () => {
      if (!form.reportValidity()) return;
      done(Object.fromEntries(new FormData(form)));
    };
    dlg.querySelector('[data-no]').onclick = () => done(null);
    dlg.querySelector('[data-yes]').onclick = submit;
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    setTimeout(() => { const first = form.querySelector('input,select,textarea'); if (first) first.focus(); }, 0);
  });
  return result && typeof result === 'object' ? result : null;
}

export function spinner() {
  return html`<div class="spinner" role="status" aria-label="Carregando"></div>`;
}

// ---------- ícones (SVG, traço de 2px) ----------

const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  chart: '<path d="M3 21h18"/><rect x="5" y="11" width="3" height="7" rx="1"/><rect x="10.5" y="5" width="3" height="13" rx="1"/><rect x="16" y="13" width="3" height="5" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  package: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9M7.5 5.2l9 4.6"/>',
  in: '<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M4 16v4h16v-4"/>',
  out: '<path d="M12 14V3M7.5 7.5 12 3l4.5 4.5"/><path d="M4 16v4h16v-4"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  count: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 11.5l2 2 4-4M9 17h6"/>',
  log: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',
  settings: '<path d="M4 6h9M18 6h2M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15.5" cy="6" r="2.2"/><circle cx="8.5" cy="12" r="2.2"/><circle cx="17" cy="18" r="2.2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16.5 6.5l3 3"/>',
  logout: '<path d="M15 3h4a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.01"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.5 3.2-5.5 6.5-5.5s5.9 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
  arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  truck: '<path d="M2 6h11v10H2zM13 10h4.5l3.5 3.5V16h-8z"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 9v6M10 9v6M13 9v6M16.5 9v6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
};
const S = {
  ok: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M7.8 12.4l2.8 2.8 5.6-5.6" stroke="#fff"/>',
  repor: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7v5.2l3.2 2" stroke="#1a1a19"/>',
  baixo: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 6.8v8.4M8.4 11.8l3.6 3.6 3.6-3.6" stroke="#fff"/>',
  zerado: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4" stroke="#fff"/>',
};

export function icon(name) {
  const body = P[name] || S[name] || '';
  return raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`);
}

export const LOGO = raw(`<svg class="logo" viewBox="0 0 48 48" aria-hidden="true">
  <rect width="48" height="48" rx="12" fill="#1c5cab"/>
  <rect x="11" y="9" width="22" height="28" rx="2" fill="#fff"/>
  <rect x="15" y="13" width="22" height="28" rx="2" fill="#fab219"/>
  <path d="M19 21h14M19 26h14M19 31h9" stroke="#1a1a19" stroke-width="2" stroke-linecap="round" opacity=".55"/>
</svg>`);

// ---------- status de estoque ----------

export function statusBadge(forecast, quantity) {
  const label = quantity < 0 ? 'Saldo negativo' : forecast.status_label;
  return html`<span class="badge ${forecast.status}">${icon(forecast.status)}${label}</span>`;
}

/** Frase curta sobre quanto tempo o estoque dura. */
export function runoutText(item) {
  const f = item.forecast;
  if (item.quantity <= 0) return 'Sem saldo no sistema';
  if (f.days_left === null) return 'Sem consumo registrado ainda';
  const d = Math.floor(f.days_left);
  const word = item.source === 'producao' ? 'Cobre' : 'Dura';
  if (d < 1) return `${word} menos de 1 dia no ritmo atual`;
  if (d > 365) return `${word} mais de 1 ano no ritmo atual`;
  return `${word} ~${fmtNum(d, 0)} ${d === 1 ? 'dia' : 'dias'} (até ${fmtDay(f.runout_date)})`;
}
