'use strict';

const config = require('../config');

// Avisos fora do sistema. Hoje: Telegram (gratuito). Sem configuração, não faz nada.
// Para ativar: crie um bot com o @BotFather, adicione-o a um grupo com a Márcia/Joatan
// e defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no ambiente.

function isConfigured() {
  return Boolean(config.telegram.token && config.telegram.chatId);
}

async function send(text) {
  if (!isConfigured()) return { sent: false, reason: 'não configurado' };
  const url = `https://api.telegram.org/bot${config.telegram.token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegram.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { sent: false, reason: `Telegram respondeu ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

module.exports = { isConfigured, send };
