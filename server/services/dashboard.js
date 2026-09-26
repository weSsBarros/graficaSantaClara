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
    waste_pct: imp.input_qty ? round3((100 * (imp.waste_qty || 0)) / imp.input_qty) : 0,
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

  // Consumo diário por item (para os gráficos de consumo, ex.: tinta).
  const consRows = db
    .prepare(
      `SELECT date(m.occurred_at, '${off}') AS day, m.item_id, SUM(-m.delta) AS qty
         FROM movements m JOIN operations o ON o.id = m.operation_id
        WHERE m.delta < 0 AND o.type IN ${CONSUMPTION_TYPES} AND o.reversed_by_id IS NULL
          AND m.occurred_at >= ? AND m.occurred_at < ?
        GROUP BY day, m.item_id`
    )
    .all(fromIso, toIso);

  const items = itemsWithForecast(db, { now });
  const consumption = items.map((it) => ({
    item_id: it.id,
    total: round3(consRows.filter((r) => r.item_id === it.id).reduce((a, r) => a + r.qty, 0)),
  }));

  const machine = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(downtime_minutes), 0) AS downtime
         FROM maintenance WHERE occurred_at >= ? AND occurred_at < ?`
    )
    .get(fromIso, toIso);
  const lastMaintenance = db
    .prepare(`SELECT type, machine, description, occurred_at FROM maintenance ORDER BY occurred_at DESC LIMIT 1`)
    .get();

  return {
    period: { days, from: fromDay, to: today },
    current,
    previous,
    daily,
    items,
    consumption,
    alerts: items.filter((i) => i.forecast.status !== 'ok').length,
    maintenance: { ...machine, last: lastMaintenance || null },
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
