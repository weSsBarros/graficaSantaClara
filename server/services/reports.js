'use strict';

// Textos enviados por WhatsApp/e-mail/Telegram: relatório semanal e resumo diário.

const { localDate, localDayStartIso, addDays, fmtNum, fmtQty, fmtItemQty, round3 } = require('../util');
const { itemsWithForecast } = require('./forecast');
const finance = require('./finance');

const d = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Semana anterior completa (segunda a domingo) em relação a `today`. */
function lastWeek(today) {
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = domingo
  const thisMonday = addDays(today, -((wd + 6) % 7));
  return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
}

function weeklyReport(db, { today = localDate(), includeFinance = true } = {}) {
  const { from, to } = lastWeek(today);
  const a = localDayStartIso(from);
  const b = localDayStartIso(addDays(to, 1));
  const lines = [`📊 Gráfica Santa Clara — resumo da semana (${d(from)} a ${d(to)})`, ''];

  const prod = db
    .prepare(
      `SELECT type, SUM(input_qty) AS input, SUM(output_qty) AS output, SUM(waste_qty) AS waste, SUM(packages) AS packages, COUNT(*) AS n
         FROM operations WHERE type IN ('impressao','empacotamento') AND reversed_by_id IS NULL
          AND occurred_at >= ? AND occurred_at < ? GROUP BY type`
    )
    .all(a, b);
  const imp = prod.find((r) => r.type === 'impressao') || {};
  const emp = prod.find((r) => r.type === 'empacotamento') || {};
  lines.push('🖨️ Produção');
  lines.push(`• Impressas: ${fmtNum(imp.output || 0)} folhas` + (imp.input ? ` (perda ${fmtNum((100 * (imp.waste || 0)) / imp.input, 1)}%)` : ''));
  lines.push(`• Empacotadas: ${fmtNum(emp.output || 0)} folhas em ${fmtNum(emp.packages || 0)} pacotes`);
  const byProduct = db
    .prepare(
      `SELECT i.name, SUM(m.delta) AS qty FROM movements m JOIN operations o ON o.id = m.operation_id JOIN items i ON i.id = m.item_id
        WHERE o.type = 'impressao' AND o.reversed_by_id IS NULL AND m.delta > 0 AND o.occurred_at >= ? AND o.occurred_at < ?
        GROUP BY i.id ORDER BY qty DESC LIMIT 6`
    )
    .all(a, b);
  if (byProduct.length) lines.push(`• Por produto: ${byProduct.map((p) => `${p.name} ${fmtNum(p.qty)}`).join(' · ')}`);
  lines.push('');

  const delivered = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'entregue' AND delivered_at >= ? AND delivered_at < ?").get(a, b).n;
  const created = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ?').get(a, b).n;
  const open = db.prepare("SELECT COUNT(*) AS n, SUM(due_date < ?) AS late FROM orders WHERE status IN ('aberto','parcial','pronto','saiu')").get(today);
  lines.push('📦 Pedidos');
  lines.push(`• Novos: ${created} · Entregues: ${delivered}`);
  lines.push(`• Em andamento: ${open.n}${open.late ? ` (⚠️ ${open.late} atrasado${open.late > 1 ? 's' : ''})` : ''}`);
  lines.push('');

  const alerts = itemsWithForecast(db).filter((i) => i.forecast.status !== 'ok');
  lines.push('📋 Estoque');
  if (!alerts.length) lines.push('• Tudo em dia, nenhum item em alerta.');
  for (const i of alerts) {
    let t = `• ${i.name}: ${fmtItemQty(i, i.quantity)} — ${i.forecast.status_label}`;
    if (i.forecast.days_left !== null && i.quantity > 0) t += `, ~${fmtNum(Math.floor(i.forecast.days_left))} dias`;
    if (i.forecast.suggested_order > 0) t += ` (comprar ~${fmtQty(i.forecast.suggested_order, i.unit)})`;
    lines.push(t);
  }

  if (includeFinance) {
    const s = finance.summary(db, { month: today.slice(0, 7) });
    lines.push('');
    lines.push(`💰 Financeiro (${MONTHS[Number(today.slice(5, 7)) - 1]} até agora)`);
    lines.push(`• Receitas: ${finance.brl(s.receitas)} · Despesas: ${finance.brl(s.despesas)} · Resultado: ${finance.brl(s.resultado)}`);
    if (s.open.pagar_7dias.count) lines.push(`• A pagar nos próximos 7 dias: ${finance.brl(s.open.pagar_7dias.total)} (${s.open.pagar_7dias.count})`);
    if (s.open.pagar_vencido.count) lines.push(`• ⚠️ Contas vencidas: ${finance.brl(s.open.pagar_vencido.total)} (${s.open.pagar_vencido.count})`);
    if (s.open.receber_vencido.count) lines.push(`• A receber em atraso: ${finance.brl(s.open.receber_vencido.total)} (${s.open.receber_vencido.count})`);
    if (s.material.per_sheet) lines.push(`• Custo de material por folha impressa: ${finance.brl(round3(s.material.per_sheet))}`);
  }
  return lines.join('\n');
}

/** Resumo diário: contas que vencem hoje/amanhã ou vencidas e pedidos atrasados. Vazio se não houver nada. */
function dailyDigest(db, { today = localDate() } = {}) {
  const tomorrow = addDays(today, 1);
  const bills = db
    .prepare(
      `SELECT description, amount, due_date, kind FROM finance_entries
        WHERE canceled_at IS NULL AND paid_at IS NULL AND kind = 'despesa' AND due_date <= ? ORDER BY due_date`
    )
    .all(tomorrow);
  const late = db
    .prepare(
      `SELECT o.id, o.due_date, c.name FROM orders o JOIN clients c ON c.id = o.client_id
        WHERE o.status IN ('aberto','parcial','pronto','saiu') AND o.due_date <= ? ORDER BY o.due_date`
    )
    .all(today);
  if (!bills.length && !late.length) return '';
  const lines = [`📅 Gráfica Santa Clara — ${d(today)}`, ''];
  if (bills.length) {
    lines.push('💸 Contas a pagar');
    for (const e of bills) {
      const when = e.due_date < today ? `VENCIDA em ${d(e.due_date)}` : e.due_date === today ? 'vence hoje' : 'vence amanhã';
      lines.push(`• ${e.description}: ${finance.brl(e.amount)} — ${when}`);
    }
    lines.push('');
  }
  if (late.length) {
    lines.push('🚚 Pedidos para entregar');
    for (const o of late) lines.push(`• #${o.id} ${o.name} — ${o.due_date < today ? `atrasado (era ${d(o.due_date)})` : 'entrega hoje'}`);
  }
  return lines.join('\n').trim();
}

module.exports = { weeklyReport, dailyDigest, lastWeek };
