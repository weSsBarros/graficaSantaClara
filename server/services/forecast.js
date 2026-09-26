'use strict';

const { getSetting } = require('../db');
const { DAY_MS, localDate, round3 } = require('../util');

// Só estes tipos de lançamento contam como "consumo" para a média.
// Entradas, ajustes de inventário e estornos não entram na conta,
// e lançamentos estornados são ignorados.
const CONSUMPTION_TYPES = "('retirada','impressao','empacotamento')";

const STATUS = {
  zerado: { rank: 3, label: 'Sem estoque' },
  baixo: { rank: 2, label: 'Estoque baixo' },
  repor: { rank: 1, label: 'Repor já' },
  ok: { rank: 0, label: 'OK' },
};

function forecastSettings(db) {
  return {
    windowDays: getSetting(db, 'forecast_window_days', 30),
    coverageDays: getSetting(db, 'purchase_coverage_days', 30),
  };
}

/** Consumo por item nos últimos `windowDays` e nos últimos 7 dias. */
function consumptionStats(db, { windowDays, now = Date.now() }) {
  const params = {
    since: new Date(now - windowDays * DAY_MS).toISOString(),
    since7: new Date(now - 7 * DAY_MS).toISOString(),
    now: new Date(now).toISOString(),
  };
  const rows = db.prepare(
    `SELECT m.item_id,
            SUM(-m.delta) AS consumed,
            SUM(CASE WHEN m.occurred_at >= @since7 THEN -m.delta ELSE 0 END) AS consumed7
       FROM movements m
       JOIN operations o ON o.id = m.operation_id
      WHERE m.delta < 0
        AND o.type IN ${CONSUMPTION_TYPES}
        AND o.reversed_by_id IS NULL
        AND m.occurred_at >= @since AND m.occurred_at <= @now
      GROUP BY m.item_id`
  ).all(params);
  const firsts = db.prepare('SELECT item_id, MIN(occurred_at) AS first FROM movements GROUP BY item_id').all();

  const map = new Map();
  for (const f of firsts) map.set(f.item_id, { consumed: 0, consumed7: 0, first: f.first });
  for (const r of rows) map.set(r.item_id, { ...map.get(r.item_id), ...r });
  return map;
}

function forecastItem(item, stats, { now = Date.now(), windowDays, coverageDays }) {
  const s = stats || {};
  const ageDays = s.first ? (now - Date.parse(s.first)) / DAY_MS : 0;
  // Se o item tem menos histórico que a janela, divide só pelos dias que existem (mínimo 1).
  const effDays = Math.max(1, Math.min(windowDays, ageDays));
  const effDays7 = Math.max(1, Math.min(7, ageDays));
  const avg = (s.consumed || 0) / effDays;
  const avg7 = (s.consumed7 || 0) / effDays7;
  const qty = item.quantity;

  let daysLeft = null; // null = sem consumo registrado, não dá para prever
  if (qty <= 0) daysLeft = 0;
  else if (avg > 0) daysLeft = qty / avg;

  let status = 'ok';
  if (qty <= 0) status = 'zerado';
  else if (item.min_stock > 0 && qty <= item.min_stock) status = 'baixo';
  else if (item.source === 'compra' && daysLeft !== null && daysLeft <= item.lead_time_days) status = 'repor';

  // Sugestão de compra: cobrir o prazo de entrega + `coverageDays` de consumo + o estoque mínimo.
  let suggested = 0;
  if (item.source === 'compra') {
    const target = avg * (item.lead_time_days + coverageDays) + item.min_stock;
    suggested = Math.max(0, target - qty);
    if (suggested > 0 && item.pack_size > 0) suggested = Math.ceil(suggested / item.pack_size) * item.pack_size;
    else suggested = Math.ceil(suggested);
  }

  return {
    avg_daily: round3(avg),
    avg_daily_7d: round3(avg7),
    history_days: round3(Math.min(ageDays, windowDays)),
    days_left: daysLeft === null ? null : Math.round(daysLeft * 10) / 10,
    runout_date: daysLeft === null ? null : localDate(new Date(now + daysLeft * DAY_MS)),
    status,
    status_label: qty < 0 ? 'Saldo negativo' : STATUS[status].label,
    suggested_order: status === 'ok' ? 0 : round3(suggested),
  };
}

/** Todos os itens ativos (ou os ids pedidos) com previsão calculada. */
function itemsWithForecast(db, { ids = null, includeInactive = false, now = Date.now() } = {}) {
  const settings = forecastSettings(db);
  const stats = consumptionStats(db, { windowDays: settings.windowDays, now });
  let items = db
    .prepare(`SELECT * FROM items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, category, name`)
    .all();
  if (ids) items = items.filter((i) => ids.includes(i.id));
  return items.map((item) => ({
    ...item,
    forecast: forecastItem(item, stats.get(item.id), { now, ...settings }),
  }));
}

module.exports = { STATUS, CONSUMPTION_TYPES, forecastSettings, consumptionStats, forecastItem, itemsWithForecast };
