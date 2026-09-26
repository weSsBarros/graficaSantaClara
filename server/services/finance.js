'use strict';

// Financeiro: despesas e receitas (contas a pagar e a receber), por categoria.
// Compras registradas no estoque com valor viram despesas; pedidos com valor viram receitas.

const crypto = require('node:crypto');
const { audit, diff } = require('../audit');
const { HttpError, nowIso, localDate, localDayStartIso, num, str, oneOf, bool, round3 } = require('../util');

const PAYMENT_METHODS = ['Pix', 'Dinheiro', 'Boleto', 'Cartão de débito', 'Cartão de crédito', 'Transferência', 'Cheque', 'Outro'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const brl = (n) => `R$ ${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;

function date(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `Informe ${field}.`);
    return null;
  }
  if (!DATE_RE.test(String(value)) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new HttpError(400, `${field}: data inválida.`);
  }
  return String(value);
}

function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

function categoryId(db, kind, name) {
  let row = db.prepare('SELECT id FROM finance_categories WHERE kind = ? AND name = ?').get(kind, name);
  if (!row) {
    const info = db.prepare('INSERT INTO finance_categories (kind, name) VALUES (?, ?)').run(kind, name);
    row = { id: Number(info.lastInsertRowid) };
  }
  return row.id;
}

/** Categoria de despesa usada quando uma compra de estoque tem valor. */
function purchaseCategoryId(db, item) {
  const byCat = { papel: 'Papel', tinta: 'Tinta', chapa: 'Chapa' };
  return categoryId(db, 'despesa', byCat[item.category] || 'Outros materiais');
}

function getEntry(db, id) {
  const e = db
    .prepare(
      `SELECT f.*, c.name AS category_name, u.name AS created_by_name
         FROM finance_entries f JOIN finance_categories c ON c.id = f.category_id JOIN users u ON u.id = f.created_by
        WHERE f.id = ?`
    )
    .get(id);
  if (!e) throw new HttpError(404, 'Lançamento financeiro não encontrado.');
  return decorate(e);
}

function decorate(e, today = localDate()) {
  let status = 'aberto';
  if (e.canceled_at) status = 'cancelado';
  else if (e.paid_at) status = 'pago';
  else if (e.due_date && e.due_date < today) status = 'vencido';
  return { ...e, status };
}

/** Cria o lançamento (sem transação própria: chame dentro de uma, se precisar). */
function insertEntry(db, user, e) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO finance_entries (kind, category_id, description, amount, date, due_date, paid_at, payment_method,
         counterparty, order_id, operation_id, recurrence_group, notes, created_by, created_at, updated_at)
       VALUES (@kind, @category_id, @description, @amount, @date, @due_date, @paid_at, @payment_method,
         @counterparty, @order_id, @operation_id, @recurrence_group, @notes, @created_by, @now, @now)`
    )
    .run({
      order_id: null, operation_id: null, recurrence_group: null, notes: null, payment_method: null,
      counterparty: null, due_date: null, paid_at: null,
      ...e,
      created_by: user.id,
      now,
    });
  return Number(info.lastInsertRowid);
}

function readEntry(db, body, { partial = false, before = null } = {}) {
  const src = { ...(before || {}), ...body };
  const kind = oneOf(src.kind, 'tipo', ['despesa', 'receita']);
  const cat = db.prepare('SELECT * FROM finance_categories WHERE id = ?').get(Number(src.category_id));
  if (!cat || cat.kind !== kind) throw new HttpError(400, 'Escolha uma categoria válida.');
  const out = {
    kind,
    category_id: cat.id,
    description: str(src.description, 'a descrição', { required: true, max: 200 }),
    amount: round3(num(src.amount, 'o valor', { positive: true, max: 1e9 })),
    date: date(src.date, 'a data', { required: true }),
    due_date: date(src.due_date, 'o vencimento'),
    payment_method: src.payment_method ? oneOf(src.payment_method, 'forma de pagamento', PAYMENT_METHODS) : null,
    counterparty: str(src.counterparty, kind === 'despesa' ? 'fornecedor' : 'cliente', { max: 120 }),
    notes: str(src.notes, 'observações', { max: 500 }),
  };
  if (!partial) out.paid_at = bool(src.paid) ? date(src.paid_at, 'data do pagamento') || localDate() : null;
  return out;
}

function createEntries(db, user, body, ctx) {
  const e = readEntry(db, body);
  const repeat = num(body.repeat_months ?? 1, 'repetir por quantos meses', { integer: true, min: 1, max: 36 });
  const group = repeat > 1 ? crypto.randomUUID() : null;
  const ids = db.transaction(() => {
    const out = [];
    for (let i = 0; i < repeat; i++) {
      out.push(
        insertEntry(db, user, {
          ...e,
          description: repeat > 1 ? `${e.description} (${i + 1}/${repeat})` : e.description,
          date: addMonths(e.date, i),
          due_date: e.due_date ? addMonths(e.due_date, i) : null,
          paid_at: i === 0 ? e.paid_at : null,
          recurrence_group: group,
        })
      );
    }
    audit(db, {
      actor: user, action: 'financeiro_lancado', entity: 'finance', entityId: out[0], ip: ctx && ctx.ip,
      summary: `${e.kind === 'despesa' ? 'Despesa' : 'Receita'} lançada: ${e.description} — ${brl(e.amount)}` +
        (repeat > 1 ? `, repetida por ${repeat} meses` : '') + (e.paid_at ? ' (paga)' : ''),
      details: { ...e, repeat },
    });
    return out;
  })();
  return ids.map((id) => getEntry(db, id));
}

function updateEntry(db, user, id, body, ctx) {
  const before = getEntry(db, id);
  if (before.canceled_at) throw new HttpError(400, 'Lançamento cancelado não pode ser editado.');
  const e = readEntry(db, body, { partial: true, before });
  if (e.kind !== before.kind) throw new HttpError(400, 'Não é possível trocar despesa por receita.');
  const changes = diff(before, e, Object.keys(e));
  if (Object.keys(changes).length) {
    db.transaction(() => {
      db.prepare(
        `UPDATE finance_entries SET category_id=@category_id, description=@description, amount=@amount, date=@date,
                due_date=@due_date, payment_method=@payment_method, counterparty=@counterparty, notes=@notes, updated_at=@now
          WHERE id=@id`
      ).run({ ...e, id, now: nowIso() });
      audit(db, {
        actor: user, action: 'financeiro_alterado', entity: 'finance', entityId: id, ip: ctx && ctx.ip,
        summary: `Alterou o lançamento financeiro #${id} (${e.description}).`, details: changes,
      });
    })();
  }
  return getEntry(db, id);
}

function payEntry(db, user, id, body, ctx) {
  const e = getEntry(db, id);
  if (e.canceled_at) throw new HttpError(400, 'Lançamento cancelado.');
  const paidAt = date(body.paid_at, 'data do pagamento') || localDate();
  const method = body.payment_method ? oneOf(body.payment_method, 'forma de pagamento', PAYMENT_METHODS) : e.payment_method;
  db.transaction(() => {
    db.prepare('UPDATE finance_entries SET paid_at = ?, payment_method = ?, updated_at = ? WHERE id = ?').run(paidAt, method, nowIso(), id);
    audit(db, {
      actor: user, action: 'financeiro_pago', entity: 'finance', entityId: id, ip: ctx && ctx.ip,
      summary: `${e.kind === 'despesa' ? 'Pagamento' : 'Recebimento'} registrado: ${e.description} — ${brl(e.amount)} em ${paidAt.split('-').reverse().join('/')}${method ? ` (${method})` : ''}.`,
    });
  })();
  return getEntry(db, id);
}

function unpayEntry(db, user, id, ctx) {
  const e = getEntry(db, id);
  db.transaction(() => {
    db.prepare('UPDATE finance_entries SET paid_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
    audit(db, {
      actor: user, action: 'financeiro_alterado', entity: 'finance', entityId: id, ip: ctx && ctx.ip,
      summary: `Desmarcou o pagamento de: ${e.description} — ${brl(e.amount)}.`,
    });
  })();
  return getEntry(db, id);
}

function cancelEntry(db, user, id, reason, ctx, { silentIfCanceled = false } = {}) {
  const e = getEntry(db, id);
  if (e.canceled_at) {
    if (silentIfCanceled) return e;
    throw new HttpError(400, 'Este lançamento já está cancelado.');
  }
  db.prepare('UPDATE finance_entries SET canceled_at = ?, canceled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?')
    .run(nowIso(), user.id, reason, nowIso(), id);
  audit(db, {
    actor: user, action: 'financeiro_cancelado', entity: 'finance', entityId: id, ip: ctx && ctx.ip,
    summary: `Cancelou o lançamento financeiro: ${e.description} — ${brl(e.amount)}. Motivo: ${reason}`,
  });
  return getEntry(db, id);
}

function listEntries(db, q = {}) {
  const where = [];
  const p = {};
  const today = localDate();
  if (q.kind) { where.push('f.kind = @kind'); p.kind = String(q.kind); }
  if (q.category_id) { where.push('f.category_id = @cat'); p.cat = Number(q.category_id); }
  if (q.month && MONTH_RE.test(q.month)) { where.push("substr(f.date, 1, 7) = @month"); p.month = q.month; }
  if (q.order_id) { where.push('f.order_id = @order_id'); p.order_id = Number(q.order_id); }
  if (q.q) { where.push("(f.description LIKE @q ESCAPE '\\' OR f.counterparty LIKE @q ESCAPE '\\')"); p.q = `%${String(q.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`; }
  const st = q.status;
  if (st === 'cancelado') where.push('f.canceled_at IS NOT NULL');
  else {
    if (st !== 'todos_com_cancelados') where.push('f.canceled_at IS NULL');
    if (st === 'pago') where.push('f.paid_at IS NOT NULL');
    if (st === 'aberto') where.push('f.paid_at IS NULL');
    if (st === 'vencido') { where.push('f.paid_at IS NULL AND f.due_date < @today'); p.today = today; }
  }
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const order = st === 'aberto' || st === 'vencido' ? 'COALESCE(f.due_date, f.date) ASC, f.id' : 'f.date DESC, f.id DESC';
  const rows = db
    .prepare(
      `SELECT f.*, c.name AS category_name, u.name AS created_by_name
         FROM finance_entries f JOIN finance_categories c ON c.id = f.category_id JOIN users u ON u.id = f.created_by
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`
    )
    .all(p);
  return { entries: rows.slice(0, limit).map((r) => decorate(r, today)), has_more: rows.length > limit };
}

/** Custo médio pago por unidade de cada item (compras com valor dos últimos 180 dias; senão o último custo). */
function averageCosts(db) {
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const rows = db
    .prepare(
      `SELECT m.item_id, SUM(o.total_cost) AS cost, SUM(m.delta) AS qty
         FROM operations o JOIN movements m ON m.operation_id = o.id
        WHERE o.type = 'entrada' AND o.total_cost > 0 AND o.reversed_by_id IS NULL AND o.occurred_at >= ?
        GROUP BY m.item_id`
    )
    .all(since);
  const map = new Map();
  for (const it of db.prepare('SELECT id, last_unit_cost FROM items WHERE last_unit_cost > 0').all()) map.set(it.id, it.last_unit_cost);
  for (const r of rows) if (r.qty > 0) map.set(r.item_id, r.cost / r.qty);
  return map;
}

/** Resumo do mês (competência) + últimos 12 meses + contas em aberto + custo de material por folha. */
function summary(db, { month } = {}) {
  const today = localDate();
  const m = month && MONTH_RE.test(month) ? month : today.slice(0, 7);
  const active = 'f.canceled_at IS NULL';
  const totals = (kind, extra = '', params = []) =>
    db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v, COUNT(*) AS n FROM finance_entries f WHERE ${active} AND kind = ? ${extra}`).get(kind, ...params);

  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const mm = addMonths(`${m}-01`, -i).slice(0, 7);
    monthly.push({
      month: mm,
      receitas: round3(totals('receita', "AND substr(f.date,1,7) = ?", [mm]).v),
      despesas: round3(totals('despesa', "AND substr(f.date,1,7) = ?", [mm]).v),
    });
  }
  const cur = monthly[monthly.length - 1];
  const cash = (kind) => round3(totals(kind, 'AND f.paid_at IS NOT NULL AND substr(f.paid_at,1,7) = ?', [m]).v);

  const byCategory = db
    .prepare(
      `SELECT c.name, f.kind, SUM(f.amount) AS total FROM finance_entries f JOIN finance_categories c ON c.id = f.category_id
        WHERE ${active} AND substr(f.date,1,7) = ? GROUP BY c.id ORDER BY total DESC`
    )
    .all(m)
    .map((r) => ({ ...r, total: round3(r.total) }));

  const openSum = (kind, cond, params = []) =>
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM finance_entries f WHERE ${active} AND kind = ? AND paid_at IS NULL ${cond}`).get(kind, ...params);
  const in7 = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const open = {
    pagar_total: openSum('despesa', ''),
    pagar_vencido: openSum('despesa', 'AND due_date < ?', [today]),
    pagar_7dias: openSum('despesa', 'AND due_date >= ? AND due_date <= ?', [today, in7]),
    receber_total: openSum('receita', ''),
    receber_vencido: openSum('receita', 'AND due_date < ?', [today]),
  };

  // Custo do material consumido na produção do mês ÷ folhas impressas no mês.
  const start = localDayStartIso(`${m}-01`);
  const end = localDayStartIso(addMonths(`${m}-01`, 1));
  const costs = averageCosts(db);
  const consumed = db
    .prepare(
      `SELECT m.item_id, i.name, i.unit, i.category, SUM(-m.delta) AS qty
         FROM movements m JOIN operations o ON o.id = m.operation_id JOIN items i ON i.id = m.item_id
        WHERE m.delta < 0 AND o.type IN ('impressao','retirada') AND o.reversed_by_id IS NULL
          AND i.source = 'compra' AND m.occurred_at >= ? AND m.occurred_at < ?
        GROUP BY m.item_id`
    )
    .all(start, end);
  const printed = db
    .prepare(
      `SELECT COALESCE(SUM(output_qty),0) AS v FROM operations
        WHERE type = 'impressao' AND reversed_by_id IS NULL AND occurred_at >= ? AND occurred_at < ?`
    )
    .get(start, end).v;
  const material = consumed.map((c) => ({
    ...c,
    qty: round3(c.qty),
    unit_cost: costs.has(c.item_id) ? round3(costs.get(c.item_id)) : null,
    total: costs.has(c.item_id) ? round3(c.qty * costs.get(c.item_id)) : null,
  }));
  const materialTotal = round3(material.reduce((a, x) => a + (x.total || 0), 0));

  return {
    month: m,
    receitas: cur.receitas,
    despesas: cur.despesas,
    resultado: round3(cur.receitas - cur.despesas),
    recebido: cash('receita'),
    pago: cash('despesa'),
    monthly,
    by_category: byCategory,
    open: Object.fromEntries(Object.entries(open).map(([k, v]) => [k, { total: round3(v.v), count: v.n }])),
    material: {
      items: material,
      total: materialTotal,
      printed,
      per_sheet: printed > 0 ? materialTotal / printed : null,
      missing_costs: material.filter((x) => x.unit_cost === null).map((x) => x.name),
    },
  };
}

module.exports = {
  PAYMENT_METHODS, brl, addMonths, categoryId, purchaseCategoryId, getEntry, insertEntry, createEntries, updateEntry,
  payEntry, unpayEntry, cancelEntry, listEntries, summary, averageCosts,
};
