'use strict';

// Avisos fora do sistema: WhatsApp (Evolution API ou CallMeBot), e-mail (SMTP) e Telegram.
// Tudo é configurado pela tela Configurações → Avisos e fica salvo no banco (settings.notify_config).
// Para o Telegram também valem as variáveis TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.

const nodemailer = require('nodemailer');
const config = require('../config');
const { getSetting, setSetting } = require('../db');

const EVENTS = {
  estoque: 'Estoque em alerta (baixo, acabando, zerado)',
  relatorio_semanal: 'Relatório semanal (produção, pedidos, estoque e financeiro)',
  resumo_diario: 'Resumo diário: contas vencendo e pedidos atrasados',
};

const DEFAULTS = {
  telegram: { enabled: false, token: '', chat_id: '' },
  evolution: { enabled: false, url: '', instance: '', apikey: '', numbers: '' },
  callmebot: { enabled: false, recipients: '' }, // "5598999990000:APIKEY, 5598988880000:APIKEY"
  email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' },
  events: { estoque: true, relatorio_semanal: true, resumo_diario: true },
  weekly: { weekday: 1, hour: 7, include_finance: true }, // segunda-feira, 7h
  daily: { hour: 8 },
};

// Campos que nunca voltam para a tela (só "salvo").
const SECRETS = { telegram: ['token'], evolution: ['apikey'], callmebot: ['recipients'], email: ['pass'] };

function getConfig(db) {
  const saved = getSetting(db, 'notify_config', {}) || {};
  const cfg = {};
  for (const [k, v] of Object.entries(DEFAULTS)) cfg[k] = { ...v, ...(saved[k] || {}) };
  if (!cfg.telegram.token && config.telegram.token) {
    cfg.telegram = { enabled: true, token: config.telegram.token, chat_id: config.telegram.chatId };
  }
  return cfg;
}

/** Configuração para a tela, com os segredos escondidos. */
function publicConfig(db) {
  const cfg = getConfig(db);
  const out = JSON.parse(JSON.stringify(cfg));
  for (const [ch, fields] of Object.entries(SECRETS)) {
    for (const f of fields) {
      const v = String(cfg[ch][f] || '');
      out[ch][f] = '';
      out[ch][`${f}_saved`] = v ? `salvo (termina em ${v.slice(-4)})` : '';
    }
  }
  return { config: out, events: EVENTS };
}

/** Salva o que veio da tela. Segredo em branco = mantém o que já estava salvo. */
function saveConfig(db, input) {
  const cur = getConfig(db);
  const next = {};
  for (const [ch, defs] of Object.entries(DEFAULTS)) {
    next[ch] = { ...cur[ch] };
    const src = input && typeof input[ch] === 'object' && input[ch] ? input[ch] : {};
    for (const [field, def] of Object.entries(defs)) {
      if (src[field] === undefined) continue;
      const secret = (SECRETS[ch] || []).includes(field);
      if (secret && src[field] === '') continue;
      if (typeof def === 'boolean') next[ch][field] = src[field] === true || src[field] === 'true';
      else if (typeof def === 'number') {
        const n = Number(src[field]);
        if (Number.isFinite(n)) next[ch][field] = n;
      } else next[ch][field] = String(src[field]).trim().slice(0, 2000);
    }
    const clear = src.clear;
    if (Array.isArray(clear)) for (const f of clear) if ((SECRETS[ch] || []).includes(f)) next[ch][f] = '';
  }
  setSetting(db, 'notify_config', next);
  return next;
}

/** "(98) 98888-7777" -> "5598988887777". */
function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d;
}

const list = (s) => String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

async function httpJson(url, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 160);
    throw new Error(`HTTP ${res.status}${txt ? `: ${txt}` : ''}`);
  }
  return res;
}

const CHANNELS = {
  telegram: {
    label: 'Telegram',
    ready: (c) => c.enabled && c.token && c.chat_id,
    async send(c, text) {
      await httpJson(`https://api.telegram.org/bot${c.token}/sendMessage`, {
        body: { chat_id: c.chat_id, text, disable_web_page_preview: true },
      });
    },
  },
  evolution: {
    label: 'WhatsApp (Evolution API)',
    ready: (c) => c.enabled && c.url && c.instance && c.apikey && list(c.numbers).length,
    async send(c, text) {
      const base = c.url.replace(/\/+$/, '');
      for (const n of list(c.numbers)) {
        await httpJson(`${base}/message/sendText/${encodeURIComponent(c.instance)}`, {
          headers: { apikey: c.apikey },
          body: { number: normalizePhone(n), text },
        });
      }
    },
  },
  callmebot: {
    label: 'WhatsApp (CallMeBot)',
    ready: (c) => c.enabled && list(c.recipients).length,
    async send(c, text) {
      for (const r of list(c.recipients)) {
        const [phone, apikey] = r.split(':').map((x) => x.trim());
        if (!phone || !apikey) throw new Error(`destinatário mal formatado: use telefone:apikey`);
        const qs = new URLSearchParams({ phone: `+${normalizePhone(phone)}`, text, apikey });
        await httpJson(`https://api.callmebot.com/whatsapp.php?${qs}`, { method: 'GET' });
      }
    },
  },
  email: {
    label: 'E-mail',
    ready: (c) => c.enabled && c.host && c.from && list(c.to).length,
    async send(c, text, subject) {
      const transport = nodemailer.createTransport({
        host: c.host,
        port: Number(c.port) || 587,
        secure: Boolean(c.secure),
        auth: c.user ? { user: c.user, pass: c.pass } : undefined,
        connectionTimeout: 15000,
      });
      await transport.sendMail({ from: c.from, to: list(c.to).join(', '), subject, text });
    },
  },
};

function isConfigured(db) {
  const cfg = getConfig(db);
  return Object.entries(CHANNELS).some(([k, ch]) => ch.ready(cfg[k]));
}

function channelStatus(db) {
  const cfg = getConfig(db);
  return Object.entries(CHANNELS).map(([k, ch]) => ({ id: k, label: ch.label, ready: Boolean(ch.ready(cfg[k])) }));
}

/**
 * Envia por todos os canais ativos (ou só por `only`). Se `event` for informado e estiver
 * desligado nas configurações, não envia. Retorna o resultado de cada canal.
 */
async function send(db, text, { subject = 'Gráfica Santa Clara', event = null, only = null } = {}) {
  const cfg = getConfig(db);
  if (event && cfg.events[event] === false) return [];
  const results = [];
  for (const [k, ch] of Object.entries(CHANNELS)) {
    if (only && k !== only) continue;
    if (!ch.ready(cfg[k])) {
      if (only) results.push({ channel: k, label: ch.label, sent: false, reason: 'canal não configurado ou desligado' });
      continue;
    }
    try {
      await ch.send(cfg[k], text, subject);
      results.push({ channel: k, label: ch.label, sent: true });
    } catch (err) {
      results.push({ channel: k, label: ch.label, sent: false, reason: err.message });
    }
  }
  return results;
}

module.exports = { EVENTS, getConfig, publicConfig, saveConfig, normalizePhone, isConfigured, channelStatus, send };
