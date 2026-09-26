'use strict';

const config = require('../config');
const { audit } = require('../audit');
const {
  HttpError, DAY_MS, nowIso, localDate, round3, fmtNum, fmtQty, fmtItemQty, plural,
  num, str, bool, parseLocalDateTime, localDayStartIso, addDays,
} = require('../util');
const { can, isManager } = require('../permissions');
const { STATUS, itemsWithForecast } = require('./forecast');
const notify = require('./notify');
const finance = require('./finance');
const orders = require('./orders');

const TYPE_LABELS = {
  entrada: 'Entrada',
  retirada: 'Retirada',
  ajuste: 'Ajuste de inventário',
  impressao: 'Impressão',
  empacotamento: 'Empacotamento',
  estorno: 'Estorno',
};

// Categorias de itens (a lista pode crescer sem mexer no banco).
const CATEGORIES = {
  papel: 'Papel',
  impresso: 'Impressos',
  tinta: 'Tinta',
  chapa: 'Chapa',
  embalagem: 'Embalagem',
  outro: 'Outros',
};

// ---------- auxiliares ----------

function getItem(db, id) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!item) throw new HttpError(404, 'Item não encontrado.');
  return item;
}

function getActiveItem(db, id) {
  const item = getItem(db, id);
  if (!item.active) throw new HttpError(400, `O item "${item.name}" está desativado.`);
  return item;
}

/** Converte a quantidade digitada para a unidade base do item (ex.: resmas -> folhas). */
function toBase(item, qty, unit) {
  if (unit === 'pack') {
    if (!(item.pack_size > 0)) throw new HttpError(400, `"${item.name}" não tem embalagem cadastrada.`);
    return round3(qty * item.pack_size);
  }
  return round3(qty);
}

/** Data/hora em que a coisa aconteceu (padrão: agora). Permite lançar algo esquecido de dias anteriores. */
function resolveOccurredAt(value, user) {
  if (value === undefined || value === null || value === '') return nowIso();
  const iso = parseLocalDateTime(value);
  if (!iso) throw new HttpError(400, 'Data/hora inválida.');
  const t = Date.parse(iso);
  if (t > Date.now() + 5 * 60000) throw new HttpError(400, 'A data não pode estar no futuro.');
  const maxDays = isManager(user) ? 365 : config.maxBackdateDays;
  if (t < Date.now() - maxDays * DAY_MS) {
    throw new HttpError(400, `Só é possível lançar até ${maxDays} dias para trás. Fale com a administração.`);
  }
  return iso;
}

function negativeWarnings(db, moves) {
  const warnings = [];
  const totals = new Map();
  for (const m of moves) totals.set(m.itemId, (totals.get(m.itemId) || 0) + m.delta);
  for (const [itemId, delta] of totals) {
    if (delta >= 0) continue;
    const item = getItem(db, itemId);
    const after = round3(item.quantity + delta);
    if (after < 0) {
      warnings.push(
        `O saldo de ${item.name} ficou negativo (${fmtQty(after, item.unit)}). ` +
          'Provavelmente falta registrar alguma entrada — avise a administração.'
      );
    }
  }
  return warnings;
}

/** Grava o lançamento e seus movimentos. Deve ser chamada dentro de uma transação. */
function writeOperation(db, { type, user, f = {}, moves = [], occurredAt, summary, reversesId = null }) {
  const now = nowIso();
  const occ = occurredAt || now;
  const info = db.prepare(
    `INSERT INTO operations
       (type, user_id, input_qty, output_qty, waste_qty, packages, per_package, client, supplier, reason, note,
        summary, reverses_id, order_id, order_item_id, total_cost, occurred_at, created_at)
     VALUES
       (@type, @user_id, @input_qty, @output_qty, @waste_qty, @packages, @per_package, @client, @supplier, @reason, @note,
        @summary, @reverses_id, @order_id, @order_item_id, @total_cost, @occurred_at, @created_at)`
  ).run({
    type,
    user_id: user.id,
    input_qty: f.input_qty ?? null,
    output_qty: f.output_qty ?? null,
    waste_qty: f.waste_qty ?? null,
    packages: f.packages ?? null,
    per_package: f.per_package ?? null,
    client: f.client ?? null,
    supplier: f.supplier ?? null,
    reason: f.reason ?? null,
    note: f.note ?? null,
    summary,
    reverses_id: reversesId,
    order_id: f.order_id ?? null,
    order_item_id: f.order_item_id ?? null,
    total_cost: f.total_cost ?? null,
    occurred_at: occ,
    created_at: now,
  });
  const opId = Number(info.lastInsertRowid);
  const upd = db.prepare('UPDATE items SET quantity = round(quantity + ?, 3), updated_at = ? WHERE id = ?');
  const get = db.prepare('SELECT quantity FROM items WHERE id = ?');
  const ins = db.prepare(
    'INSERT INTO movements (operation_id, item_id, delta, balance_after, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const m of moves) {
    const delta = round3(m.delta);
    if (delta === 0 && !m.keepZero) continue;
    upd.run(delta, now, m.itemId);
    ins.run(opId, m.itemId, delta, get.get(m.itemId).quantity, occ, now);
  }
  return opId;
}

/** Grava lançamento + log (e o que mais `after` fizer) numa transação só; depois reavalia os alertas. */
function commit(db, user, ctx, op, details, after = null) {
  const id = db.transaction(() => {
    const opId = writeOperation(db, { ...op, user });
    if (after) after(opId);
    audit(db, { actor: user, action: op.type, entity: 'operation', entityId: opId, summary: op.summary, details, ip: ctx && ctx.ip });
    return opId;
  })();
  refreshAlerts(db, [...new Set(op.moves.map((m) => m.itemId))]);
  return id;
}

// ---------- alertas ----------

const fmtDate = (day) => (day ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : '');

function alertMessage(it) {
  const f = it.forecast;
  const qty = fmtItemQty(it, it.quantity);
  let msg;
  if (f.status === 'zerado') msg = `🔴 ${it.name}: SEM ESTOQUE (saldo ${qty}).`;
  else if (f.status === 'baixo') {
    msg = `🟠 ${it.name}: estoque baixo — ${qty} (limite de aviso: ${fmtQty(it.min_stock, it.unit)}).`;
    if (f.days_left !== null) msg += ` Dá para ~${fmtNum(Math.floor(f.days_left))} dias.`;
  } else if (it.source === 'producao') {
    msg = `🟡 ${it.name}: o estoque impresso (${qty}) dá para ~${fmtNum(Math.floor(f.days_left))} dias de empacotamento. Programar impressão.`;
  } else {
    msg = `🟡 ${it.name}: acaba em ~${fmtNum(Math.floor(f.days_left))} dias (${fmtDate(f.runout_date)}).`;
    if (it.lead_time_days) msg += ` O fornecedor leva ${it.lead_time_days} dias para entregar.`;
    msg += ' Hora de comprar.';
  }
  if (f.suggested_order > 0) msg += ` Sugestão de compra: ${fmtItemQty(it, f.suggested_order)}.`;
  return msg;
}

/**
 * Recalcula o status dos itens e, quando algum piora (ex.: ok -> baixo), registra no log
 * e manda aviso pelos canais configurados (só itens com "enviar aviso" marcado).
 */
function refreshAlerts(db, itemIds = null) {
  const items = itemsWithForecast(db, { ids: itemIds });
  const messages = [];
  const setState = db.prepare('UPDATE items SET alert_state = ? WHERE id = ?');
  const hasMovements = db.prepare('SELECT 1 FROM movements WHERE item_id = ? LIMIT 1');
  for (const it of items) {
    const status = it.forecast.status;
    if (status === it.alert_state) continue;
    // Item recém-cadastrado, ainda sem nenhuma contagem/entrada: não gera alerta.
    if (!hasMovements.get(it.id)) continue;
    setState.run(status, it.id);
    const worse = STATUS[status].rank > (STATUS[it.alert_state] ? STATUS[it.alert_state].rank : 0);
    if (worse) {
      const msg = alertMessage(it);
      audit(db, {
        action: 'alerta', entity: 'item', entityId: it.id, summary: msg,
        details: { status, quantity: it.quantity, min_stock: it.min_stock, alert_days: it.alert_days, days_left: it.forecast.days_left },
      });
      if (it.notify) messages.push(msg);
    } else if (status === 'ok') {
      audit(db, { action: 'alerta_resolvido', entity: 'item', entityId: it.id, summary: `Estoque de ${it.name} normalizado: ${fmtItemQty(it, it.quantity)}.` });
    }
  }
  if (messages.length && notify.isConfigured(db)) {
    notify
      .send(db, `⚠️ Gráfica Santa Clara — estoque\n\n${messages.join('\n\n')}`, { event: 'estoque', subject: 'Alerta de estoque' })
      .then((results) => {
        for (const r of results.filter((x) => !x.sent)) {
          try {
            audit(db, { action: 'aviso_falhou', summary: `Aviso de estoque não enviado por ${r.label}: ${r.reason}` });
          } catch { /* banco fechado */ }
        }
      })
      .catch((err) => console.error('[aviso]', err));
  }
  return messages;
}

// ---------- lançamentos ----------

function entrada(db, user, body, ctx) {
  const item = getActiveItem(db, num(body.item_id, 'o item', { integer: true }));
  const qty = toBase(item, num(body.quantity, 'a quantidade', { positive: true, max: 1e9 }), body.unit);
  const supplier = str(body.supplier, 'fornecedor', { max: 120 });
  const note = str(body.note, 'observação', { max: 500 });
  const occurredAt = resolveOccurredAt(body.occurred_at, user);
  const totalCost = num(body.total_cost, 'o valor pago', { required: false, min: 0, max: 1e9 });
  if (totalCost && !can(user, 'financeiro')) throw new HttpError(403, 'Você não tem permissão para informar valores.');
  const paid = bool(body.paid);
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(body.due_date || '') ? body.due_date : null;
  const method = body.payment_method && finance.PAYMENT_METHODS.includes(body.payment_method) ? body.payment_method : null;

  let summary = `Entrada de ${fmtItemQty(item, qty)} de ${item.name}`;
  if (supplier) summary += ` — fornecedor: ${supplier}`;
  const moves = [{ itemId: item.id, delta: qty }];
  const id = commit(
    db, user, ctx,
    { type: 'entrada', f: { input_qty: qty, supplier, note, total_cost: totalCost || null }, moves, occurredAt, summary },
    { item_id: item.id, quantity: qty, supplier, note, occurred_at: occurredAt, total_cost: totalCost || null },
    (opId) => {
      if (!totalCost) return;
      // Compra com valor: guarda o custo unitário e lança a despesa (paga ou a pagar).
      db.prepare('UPDATE items SET last_unit_cost = ? WHERE id = ?').run(round3(totalCost / qty), item.id);
      finance.insertEntry(db, user, {
        kind: 'despesa',
        category_id: finance.purchaseCategoryId(db, item),
        description: `Compra: ${fmtItemQty(item, qty)} de ${item.name}`,
        amount: round3(totalCost),
        date: localDate(occurredAt),
        due_date: paid ? null : dueDate || localDate(occurredAt),
        paid_at: paid ? localDate(occurredAt) : null,
        payment_method: method,
        counterparty: supplier,
        operation_id: opId,
        notes: note,
      });
    }
  );
  return { operation: getOperation(db, id, user), warnings: [] };
}

function retirada(db, user, body, ctx) {
  const item = getActiveItem(db, num(body.item_id, 'o item', { integer: true }));
  const qty = toBase(item, num(body.quantity, 'a quantidade', { positive: true, max: 1e9 }), body.unit);
  const reason = str(body.reason, 'o motivo', { required: true, max: 120 });
  const note = str(body.note, 'observação', { max: 500 });
  const occurredAt = resolveOccurredAt(body.occurred_at, user);
  const summary = `Retirada de ${fmtItemQty(item, qty)} de ${item.name} — motivo: ${reason}`;
  const moves = [{ itemId: item.id, delta: -qty }];
  const warnings = negativeWarnings(db, moves);
  const id = commit(
    db, user, ctx,
    { type: 'retirada', f: { input_qty: qty, reason, note }, moves, occurredAt, summary },
    { item_id: item.id, quantity: qty, reason, note, occurred_at: occurredAt }
  );
  return { operation: getOperation(db, id, user), warnings };
}

function ajuste(db, user, body, ctx) {
  if (!can(user, 'ajuste')) throw new HttpError(403, 'Só a administração pode fazer ajuste de inventário.');
  const item = getActiveItem(db, num(body.item_id, 'o item', { integer: true }));
  const counted = toBase(item, num(body.counted, 'a quantidade contada', { min: 0, max: 1e9 }), body.unit);
  const note = str(body.note, 'observação', { max: 500 });
  const before = item.quantity;
  const delta = round3(counted - before);
  const summary =
    delta === 0
      ? `Contagem de ${item.name} confere com o sistema: ${fmtItemQty(item, counted)}`
      : `Ajuste de inventário de ${item.name}: ${fmtNum(before)} → ${fmtItemQty(item, counted)} ` +
        `(${delta > 0 ? '+' : ''}${fmtNum(delta)})`;
  const moves = [{ itemId: item.id, delta, keepZero: true }];
  const id = commit(
    db, user, ctx,
    { type: 'ajuste', f: { input_qty: counted, note }, moves, summary },
    { item_id: item.id, before, counted, delta, note }
  );
  return { operation: getOperation(db, id, user), warnings: [] };
}

/** Materiais extras gastos na impressão (chapas, tinta...). */
function readExtras(db, extras, exclude) {
  if (extras === undefined || extras === null) return [];
  if (!Array.isArray(extras) || extras.length > 10) throw new HttpError(400, 'Materiais extras inválidos.');
  const seen = new Set();
  return extras
    .filter((e) => e && e.quantity !== '' && e.quantity !== null && e.quantity !== undefined && Number(e.quantity) !== 0)
    .map((e) => {
      const item = getActiveItem(db, num(e.item_id, 'o material', { integer: true }));
      if (exclude.includes(item.id) || seen.has(item.id)) throw new HttpError(400, `"${item.name}" repetido na lista de materiais.`);
      seen.add(item.id);
      return { item, qty: round3(num(e.quantity, `a quantidade de ${item.name}`, { positive: true, max: 1e7 })) };
    });
}

function impressao(db, user, body, ctx) {
  if (!can(user, 'impressao')) throw new HttpError(403, 'Você não tem permissão para registrar impressão.');
  const product = getActiveItem(db, num(body.product_id, 'o produto impresso', { integer: true }));
  if (product.source !== 'producao') throw new HttpError(400, `"${product.name}" não é um produto impresso.`);
  const inputId = body.input_item_id ? num(body.input_item_id, 'o papel', { integer: true }) : product.made_from_item_id;
  if (!inputId) {
    throw new HttpError(400, `Escolha o papel usado (ou cadastre em Configurações → Itens de qual papel o "${product.name}" é feito).`);
  }
  const input = getActiveItem(db, inputId);
  if (input.id === product.id) throw new HttpError(400, 'O papel usado deve ser diferente do produto.');
  const used = toBase(input, num(body.input_qty, 'quantas folhas foram usadas', { positive: true, max: 1e9 }), body.input_unit);
  const waste = round3(num(body.waste_qty, 'a perda', { min: 0, max: 1e9, required: false }) ?? 0);
  if (waste > used) throw new HttpError(400, 'A perda não pode ser maior que o total usado.');
  const extras = readExtras(db, body.extras, [input.id, product.id]);
  const note = str(body.note, 'observação', { max: 500 });
  const occurredAt = resolveOccurredAt(body.occurred_at, user);
  const good = round3(used - waste);

  let summary = `Impressão de ${product.name}: ${fmtItemQty(input, used)} de ${input.name} → ${fmtQty(good, product.unit)} prontas`;
  if (waste) summary += ` (perda de ${fmtQty(waste, input.unit)})`;
  if (extras.length) summary += `; usou ${extras.map((e) => `${e.item.name} (${fmtQty(e.qty, e.item.unit)})`).join(', ')}`;
  const moves = [
    { itemId: input.id, delta: -used },
    { itemId: product.id, delta: good },
    ...extras.map((e) => ({ itemId: e.item.id, delta: -e.qty })),
  ];
  const warnings = negativeWarnings(db, moves);
  const f = { input_qty: used, output_qty: good, waste_qty: waste, note };
  const id = commit(
    db, user, ctx,
    { type: 'impressao', f, moves, occurredAt, summary },
    { product_id: product.id, input_item_id: input.id, ...f, extras: extras.map((e) => ({ item_id: e.item.id, quantity: e.qty })), occurred_at: occurredAt }
  );
  return { operation: getOperation(db, id, user), warnings };
}

function empacotamento(db, user, body, ctx) {
  if (!can(user, 'empacotamento')) throw new HttpError(403, 'Você não tem permissão para registrar empacotamento.');
  let line = null;
  let product;
  if (body.order_item_id) {
    line = db
      .prepare(
        `SELECT oi.*, o.status, c.name AS client_name FROM order_items oi
           JOIN orders o ON o.id = oi.order_id JOIN clients c ON c.id = o.client_id WHERE oi.id = ?`
      )
      .get(num(body.order_item_id, 'o item do pedido', { integer: true }));
    if (!line) throw new HttpError(404, 'Item do pedido não encontrado.');
    if (['entregue', 'cancelado'].includes(line.status)) throw new HttpError(400, `O pedido #${line.order_id} já está ${line.status}.`);
    product = getItem(db, line.item_id);
  } else {
    product = getActiveItem(db, num(body.product_id, 'o produto', { integer: true }));
  }
  const packages = num(body.packages, 'o número de pacotes', { integer: true, positive: true, max: 1e7 });
  const per = num(body.per_package, 'a quantidade por pacote', { positive: true, max: 1e9 });
  const waste = round3(num(body.waste_qty, 'a perda', { min: 0, max: 1e9, required: false }) ?? 0);
  const client = line ? line.client_name : str(body.client, 'cliente', { max: 120 });
  const note = str(body.note, 'observação', { max: 500 });
  const occurredAt = resolveOccurredAt(body.occurred_at, user);
  const packed = round3(packages * per);
  const used = round3(packed + waste);

  let summary =
    `Empacotamento de ${product.name}: ${fmtNum(packages)} ${plural('pacote', packages)} × ${fmtQty(per, product.unit)} = ` +
    `${fmtQty(packed, product.unit)}`;
  if (waste) summary += ` (perda de ${fmtQty(waste, product.unit)})`;
  if (line) summary += ` — pedido #${line.order_id} (${client})`;
  else if (client) summary += ` — cliente: ${client}`;
  const moves = [{ itemId: product.id, delta: -used }];
  const warnings = negativeWarnings(db, moves);
  if (line && packed > line.quantity - line.packed + 1e-9) {
    warnings.push(`Foi empacotado mais do que faltava no pedido #${line.order_id} (faltavam ${fmtQty(Math.max(0, line.quantity - line.packed), product.unit)}).`);
  }
  const f = {
    input_qty: used, output_qty: packed, waste_qty: waste, packages, per_package: per, client, note,
    order_id: line ? line.order_id : null, order_item_id: line ? line.id : null,
  };
  const id = commit(
    db, user, ctx,
    { type: 'empacotamento', f, moves, occurredAt, summary },
    { product_id: product.id, ...f, occurred_at: occurredAt },
    () => { if (line) orders.addPacked(db, line.id, packed); }
  );
  return { operation: getOperation(db, id, user), warnings };
}

function canUndo(user, op) {
  if (op.type === 'estorno' || op.reversed_by_id) return false;
  if (can(user, 'estorno')) return true;
  return op.user_id === user.id && Date.now() - Date.parse(op.created_at) <= config.selfUndoMinutes * 60000;
}

function estorno(db, user, opId, body, ctx) {
  const op = db.prepare('SELECT * FROM operations WHERE id = ?').get(opId);
  if (!op) throw new HttpError(404, 'Lançamento não encontrado.');
  if (op.type === 'estorno') throw new HttpError(400, 'Um estorno não pode ser estornado. Faça um novo lançamento.');
  if (op.reversed_by_id) throw new HttpError(400, 'Este lançamento já foi estornado.');
  if (!canUndo(user, op)) {
    throw new HttpError(
      403,
      `Só a administração pode estornar este lançamento (quem lançou pode desfazer em até ${config.selfUndoMinutes} minutos).`
    );
  }
  const reason = str(body.reason, 'o motivo do estorno', { required: true, max: 300 });
  const moves = db
    .prepare('SELECT item_id, delta FROM movements WHERE operation_id = ?')
    .all(op.id)
    .map((m) => ({ itemId: m.item_id, delta: -m.delta }));
  const summary = `Estorno do lançamento #${op.id} (${op.summary}) — motivo: ${reason}`;
  const warnings = negativeWarnings(db, moves);
  const id = db.transaction(() => {
    // O estorno "acontece" na mesma data do original, para os gráficos ficarem como se ele não existisse.
    const newId = writeOperation(db, {
      type: 'estorno', user, f: { reason, order_id: op.order_id, order_item_id: op.order_item_id }, moves,
      occurredAt: op.occurred_at, summary, reversesId: op.id,
    });
    db.prepare('UPDATE operations SET reversed_by_id = ? WHERE id = ?').run(newId, op.id);
    // Desfaz também o que o lançamento gerou fora do estoque.
    if (op.type === 'empacotamento' && op.order_item_id) orders.addPacked(db, op.order_item_id, -op.output_qty);
    for (const e of db.prepare('SELECT id FROM finance_entries WHERE operation_id = ? AND canceled_at IS NULL').all(op.id)) {
      finance.cancelEntry(db, user, e.id, `Estorno do lançamento #${op.id}: ${reason}`, ctx);
    }
    audit(db, {
      actor: user, action: 'estorno', entity: 'operation', entityId: newId, summary,
      details: { reverses_id: op.id, reason }, ip: ctx && ctx.ip,
    });
    return newId;
  })();
  refreshAlerts(db, [...new Set(moves.map((m) => m.itemId))]);
  return { operation: getOperation(db, id, user), warnings };
}

// ---------- consultas ----------

function attachMovements(db, ops, user) {
  if (!ops.length) return ops;
  const ids = ops.map((o) => o.id);
  const rows = db
    .prepare(
      `SELECT m.operation_id, m.item_id, m.delta, m.balance_after, i.name AS item_name, i.unit
         FROM movements m JOIN items i ON i.id = m.item_id
        WHERE m.operation_id IN (${ids.map(() => '?').join(',')})
        ORDER BY m.id`
    )
    .all(...ids);
  const byOp = new Map(ids.map((id) => [id, []]));
  for (const r of rows) byOp.get(r.operation_id).push(r);
  const showCost = user && can(user, 'financeiro');
  return ops.map((o) => ({
    ...o,
    total_cost: showCost ? o.total_cost : undefined,
    type_label: TYPE_LABELS[o.type],
    movements: byOp.get(o.id),
    can_undo: user ? canUndo(user, o) : false,
  }));
}

const OP_SELECT = `
  SELECT o.*, u.name AS user_name
    FROM operations o
    JOIN users u ON u.id = o.user_id`;

function getOperation(db, id, user) {
  const op = db.prepare(`${OP_SELECT} WHERE o.id = ?`).get(id);
  if (!op) throw new HttpError(404, 'Lançamento não encontrado.');
  return attachMovements(db, [op], user)[0];
}

function listOperations(db, user, q = {}) {
  const where = [];
  const params = {};
  if (q.type) {
    where.push('o.type = @type');
    params.type = String(q.type);
  }
  if (q.user_id) {
    where.push('o.user_id = @user_id');
    params.user_id = Number(q.user_id);
  }
  if (q.item_id) {
    where.push('EXISTS (SELECT 1 FROM movements mm WHERE mm.operation_id = o.id AND mm.item_id = @item_id)');
    params.item_id = Number(q.item_id);
  }
  if (q.order_id) {
    where.push('o.order_id = @order_id');
    params.order_id = Number(q.order_id);
  }
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) {
    where.push('o.occurred_at >= @from');
    params.from = localDayStartIso(q.from);
  }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
    where.push('o.occurred_at < @to');
    params.to = localDayStartIso(addDays(q.to, 1));
  }
  if (q.hide_reversed === '1') where.push("o.reversed_by_id IS NULL AND o.type <> 'estorno'");
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`${OP_SELECT} ${sqlWhere} ORDER BY o.occurred_at DESC, o.id DESC LIMIT ${limit + 1} OFFSET ${offset}`)
    .all(params);
  const hasMore = rows.length > limit;
  return { operations: attachMovements(db, rows.slice(0, limit), user), has_more: hasMore };
}

module.exports = {
  TYPE_LABELS,
  CATEGORIES,
  getItem,
  resolveOccurredAt,
  writeOperation,
  refreshAlerts,
  entrada,
  retirada,
  ajuste,
  impressao,
  empacotamento,
  estorno,
  canUndo,
  getOperation,
  listOperations,
};
