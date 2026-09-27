'use strict';

const { localDate, localDayStartIso, addDays, sqlOffset, round3 } = require('../util');
const { CONSUMPTION_TYPES, itemsWithForecast } = require('./forecast');

function dayRange(fromDay, toDay) {
  const days = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) days.push(d);
  return days;
}

function productionTotals(db, fromIso, toIso) {
  const rows = db
    .prepare(
      `SELECT type,
              COUNT(*) AS count,
              SUM(input_qty) AS input_qty,
              SUM(output_qty) AS output_qty,
              SUM(waste_qty) AS waste_qty,
              SUM(packages) AS packages
         FROM operations
        WHERE type IN ('impressao','empacotamento') AND reversed_by_id IS NULL
          AND occurred_at >= ? AND occurred_at < ?
        GROUP BY type`
    )
    .all(fromIso, toIso);
  const get = (t) => rows.find((r) => r.type === t) || {};
  const imp = get('impressao');
  const emp = get('empacotamento');
  return {
    printed: round3(imp.output_qty || 0),
    print_input: round3(imp.input_qty || 0),
    print_waste: round3(imp.waste_qty || 0),
    print_runs: imp.count || 0,
    // perda em relação a tudo o que a impressão rendeu (boas + perdidas), na unidade do produto
    waste_pct: imp.output_qty || imp.waste_qty ? round3((100 * (imp.waste_qty || 0)) / ((imp.output_qty || 0) + (imp.waste_qty || 0))) : 0,
    packed: round3(emp.output_qty || 0),
    packages: emp.packages || 0,
    pack_orders: emp.count || 0,
    pack_waste: round3(emp.waste_qty || 0),
  };
}

/** Painel: produção do período, comparação com o período anterior, série diária e previsão de estoque. */
function dashboard(db, { days = 30, now = Date.now() } = {}) {
  days = Math.min(Math.max(Number(days) || 30, 1), 365);
  const today = localDate(new Date(now));
  const fromDay = addDays(today, -(days - 1));
  const fromIso = localDayStartIso(fromDay);
  const toIso = localDayStartIso(addDays(today, 1));
  const prevFromIso = localDayStartIso(addDays(fromDay, -days));

  const current = productionTotals(db, fromIso, toIso);
  const previous = productionTotals(db, prevFromIso, fromIso);

  const off = sqlOffset();
  const dailyRows = db
    .prepare(
      `SELECT date(occurred_at, '${off}') AS day, type,
              SUM(output_qty) AS output_qty, SUM(waste_qty) AS waste_qty, SUM(packages) AS packages
         FROM operations
        WHERE type IN ('impressao','empacotamento') AND reversed_by_id IS NULL
          AND occurred_at >= ? AND occurred_at < ?
        GROUP BY day, type`
    )
    .all(fromIso, toIso);
  const daily = dayRange(fromDay, today).map((day) => {
    const imp = dailyRows.find((r) => r.day === day && r.type === 'impressao') || {};
    const emp = dailyRows.find((r) => r.day === day && r.type === 'empacotamento') || {};
    return {
      day,
      printed: round3(imp.output_qty || 0),
      waste: round3(imp.waste_qty || 0),
      packed: round3(emp.output_qty || 0),
      packages: emp.packages || 0,
    };
  });

  const items = itemsWithForecast(db, { now });

  // Produção por produto impresso: quanto foi impresso (entrou) e empacotado (saiu) no período.
  const byProduct = db
    .prepare(
      `SELECT i.id, i.name, i.unit,
              SUM(CASE WHEN o.type = 'impressao' AND m.delta > 0 THEN m.delta ELSE 0 END) AS printed,
              SUM(CASE WHEN o.type = 'empacotamento' THEN o.output_qty ELSE 0 END) AS packed
         FROM movements m JOIN operations o ON o.id = m.operation_id JOIN items i ON i.id = m.item_id
        WHERE i.source = 'producao' AND o.type IN ('impressao','empacotamento') AND o.reversed_by_id IS NULL
          AND m.occurred_at >= ? AND m.occurred_at < ?
        GROUP BY i.id ORDER BY printed DESC`
    )
    .all(fromIso, toIso)
    .map((r) => ({ ...r, printed: round3(r.printed), packed: round3(r.packed) }));

  // Pedidos: entregues no período, em andamento e atrasados agora.
  const ordersStats = {
    delivered: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'entregue' AND delivered_at >= ? AND delivered_at < ?").get(fromIso, toIso).n,
    created: db.prepare('SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ?').get(fromIso, toIso).n,
    ...db
      .prepare(
        `SELECT COUNT(*) AS open, COALESCE(SUM(due_date < ?), 0) AS late, COALESCE(SUM(status IN ('pronto','saiu')), 0) AS ready
           FROM orders WHERE status IN ('aberto','parcial','pronto','saiu')`
      )
      .get(today),
  };

  return {
    period: { days, from: fromDay, to: today },
    current,
    previous,
    daily,
    items,
    by_product: byProduct,
    orders: ordersStats,
    alerts: items.filter((i) => i.forecast.status !== 'ok').length,
  };
}

/** Saldo de um item no fim de cada dia (histórico) + projeção até zerar. */
function itemHistory(db, itemId, { days = 60, now = Date.now() } = {}) {
  days = Math.min(Math.max(Number(days) || 60, 7), 365);
  const [item] = itemsWithForecast(db, { ids: [itemId], includeInactive: true, now });
  if (!item) return null;
  const today = localDate(new Date(now));
  const fromDay = addDays(today, -(days - 1));
  const off = sqlOffset();
  const rows = db
    .prepare(
      `SELECT date(occurred_at, '${off}') AS day, SUM(delta) AS delta
         FROM movements WHERE item_id = ? AND occurred_at >= ?
        GROUP BY day`
    )
    .all(itemId, localDayStartIso(fromDay));
  const deltaByDay = new Map(rows.map((r) => [r.day, r.delta]));
  const future = db
    .prepare('SELECT COALESCE(SUM(delta), 0) AS d FROM movements WHERE item_id = ? AND occurred_at >= ?')
    .get(itemId, localDayStartIso(addDays(today, 1))).d;

  // Anda de hoje para trás: saldo no fim do dia D = saldo atual - movimentos depois de D.
  const series = [];
  let balance = round3(item.quantity - future);
  for (let d = today; d >= fromDay; d = addDays(d, -1)) {
    series.unshift({ day: d, balance: round3(balance) });
    balance -= deltaByDay.get(d) || 0;
  }

  const consRows = db
    .prepare(
      `SELECT date(m.occurred_at, '${off}') AS day, SUM(-m.delta) AS qty
         FROM movements m JOIN operations o ON o.id = m.operation_id
        WHERE m.item_id = ? AND m.delta < 0 AND o.type IN ${CONSUMPTION_TYPES} AND o.reversed_by_id IS NULL
          AND m.occurred_at >= ?
        GROUP BY day`
    )
    .all(itemId, localDayStartIso(fromDay));
  const consByDay = new Map(consRows.map((r) => [r.day, r.qty]));
  for (const p of series) p.consumed = round3(consByDay.get(p.day) || 0);

  // Projeção linear com a média atual, até zerar (limite de 120 dias).
  const projection = [];
  const avg = item.forecast.avg_daily;
  if (avg > 0 && item.quantity > 0) {
    const horizon = Math.min(Math.ceil(item.quantity / avg), 120);
    for (let i = 0; i <= horizon; i++) {
      projection.push({ day: addDays(today, i), balance: round3(Math.max(0, item.quantity - avg * i)) });
    }
  }
  return { item, series, projection };
}

module.exports = { dashboard, itemHistory };
