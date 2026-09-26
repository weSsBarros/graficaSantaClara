'use strict';

// Envios automáticos: relatório semanal e resumo diário (se algum canal de aviso estiver ativo).

const config = require('./config');
const { getSetting, setSetting } = require('./db');
const { audit } = require('./audit');
const { localDate } = require('./util');
const notify = require('./services/notify');
const reports = require('./services/reports');

function localClock(now) {
  const t = new Date(now.getTime() + config.utcOffsetHours * 3600000);
  return { today: localDate(now), hour: t.getUTCHours(), weekday: t.getUTCDay() };
}

async function deliver(db, text, subject, event) {
  const results = await notify.send(db, text, { subject, event });
  const ok = results.filter((r) => r.sent).map((r) => r.label);
  const bad = results.filter((r) => !r.sent);
  audit(db, {
    action: bad.length && !ok.length ? 'aviso_falhou' : 'aviso_enviado',
    summary: `${subject}: ${ok.length ? `enviado por ${ok.join(', ')}` : 'não enviado'}` +
      (bad.length ? `; falhou: ${bad.map((r) => `${r.label} (${r.reason})`).join('; ')}` : '') + '.',
  });
  return results;
}

async function runSchedules(db, now = new Date()) {
  if (!notify.isConfigured(db)) return [];
  const cfg = notify.getConfig(db);
  const { today, hour, weekday } = localClock(now);
  const sent = [];

  if (cfg.events.relatorio_semanal && weekday === Number(cfg.weekly.weekday) && hour >= Number(cfg.weekly.hour)
      && getSetting(db, 'last_weekly_report', null) !== today) {
    setSetting(db, 'last_weekly_report', today); // marca antes, para não repetir se o envio demorar
    await deliver(db, reports.weeklyReport(db, { today, includeFinance: cfg.weekly.include_finance !== false }), 'Relatório semanal', 'relatorio_semanal');
    sent.push('semanal');
  }

  if (cfg.events.resumo_diario && hour >= Number(cfg.daily.hour) && getSetting(db, 'last_daily_digest', null) !== today) {
    setSetting(db, 'last_daily_digest', today);
    const text = reports.dailyDigest(db, { today });
    if (text) {
      await deliver(db, text, 'Resumo do dia', 'resumo_diario');
      sent.push('diario');
    }
  }
  return sent;
}

module.exports = { runSchedules, deliver, localClock };
