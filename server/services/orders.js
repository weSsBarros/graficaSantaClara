'use strict';

// Pedidos de clientes: do cadastro até a entrega.
//   aberto -> parcial (parte empacotada) -> pronto -> saiu (para entrega) -> entregue
//   (ou cancelado). O empacotamento da Eulir alimenta a quantidade empacotada de cada item.

const { audit, diff } = require('../audit');
const { HttpError, nowIso, localDate, num, str, oneOf, round3, fmtNum, plural } = require('../util');
const { can, isManager } = require('../permissions');
const { getSetting } = require('../db');
const finance = require('./finance');

const STATUS_LABELS = {
  aberto: 'Aberto',
  parcial: 'Empacotando',
  pronto: 'Separado, aguardando o entregador',
  saiu: 'Saiu para entrega',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};
const OPEN_STATUSES = ['aberto', 'parcial', 'pronto', 'saiu'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const canSeePrices = (user) => can(user, 'pedidos') || can(user, 'ver_financeiro');

// Por onde o pedido chegou.
const CHANNELS = ['WhatsApp', 'E-mail', 'Telefone', 'Pessoalmente', 'Outro'];

// ---------- regras dos pedidos (a administração ajusta em Configurações → Sistema) ----------

const HOME_CITY = 'São Luís';
const normCity = (c) => String(c || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\s*[-/,]\s*ma$/, '').trim();
/** Cliente de fora de São Luís? (cidade em branco = São Luís) */
const isOutside = (city) => !!normCity(city) && normCity(city) !== normCity(HOME_CITY);

function orderRules(db) {
  return {
    min_units: Number(getSetting(db, 'min_order_units', 300)) || 0,
    min_value_outside: Number(getSetting(db, 'min_order_value_outside', 0)) || 0,
    home_city: HOME_CITY,
  };
}

/**
 * Confere pedido mínimo (unidades) e valor mínimo para fora de São Luís. Só a Administração pode
 * abrir exceção (enviando ignore_minimum); a exceção fica escrita no registro do pedido.
 */
function checkRules(db, user, clientId, lines, body) {
  const rules = orderRules(db);
  const units = round3(lines.reduce((a, l) => a + l.quantity, 0));
  const total = round3(lines.reduce((a, l) => a + l.quantity * l.unit_price, 0));
  const city = db.prepare('SELECT city FROM clients WHERE id = ?').get(clientId).city;
  const problems = [];
  if (rules.min_units > 0 && units < rules.min_units) {
    problems.push(`O pedido mínimo é de ${fmtNum(rules.min_units)} unidades (este tem ${fmtNum(units)}).`);
  }
  if (rules.min_value_outside > 0 && isOutside(city) && total < rules.min_value_outside) {
    problems.push(`Para fora de ${HOME_CITY} (${city}) o valor mínimo é ${finance.brl(rules.min_value_outside)} (este tem ${finance.brl(total)}).`);
  }
  if (!problems.length) return null;
  if (body.ignore_minimum && isManager(user)) return problems.join(' ');
  throw new HttpError(400, problems.join(' '), { code: 'abaixo_do_minimo', pode_liberar: isManager(user) });
}

function dateOrNull(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (!DATE_RE.test(String(v))) throw new HttpError(400, `${field}: data inválida.`);
  return String(v);
}

// ---------- clientes ----------

function readClient(body) {
  return {
    name: str(body.name, 'o nome do cliente', { required: true, max: 120 }),
    city: str(body.city, 'cidade', { max: 60 }),
    phone: str(body.phone, 'telefone', { max: 40 }),
    email: str(body.email, 'e-mail', { max: 120 }),
    address: str(body.address, 'endereço', { max: 300 }),
    document: str(body.document, 'CPF/CNPJ', { max: 30 }),
    notes: str(body.notes, 'observações', { max: 500 }),
  };
}

function createClient(db, user, body, ctx) {
  const c = readClient(body);
  const now = nowIso();
  try {
    const id = Number(
      db.prepare(
        `INSERT INTO clients (name, city, phone, email, address, document, notes, created_at, updated_at)
         VALUES (@name, @city, @phone, @email, @address, @document, @notes, @now, @now)`
      ).run({ ...c, now }).lastInsertRowid
    );
    audit(db, { actor: user, action: 'cliente_criado', entity: 'client', entityId: id, ip: ctx && ctx.ip, summary: `Cadastrou o cliente ${c.name}.` });
    return id;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe um cliente com esse nome.');
    throw err;
  }
}

function updateClient(db, user, id, body, ctx) {
  const before = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!before) throw new HttpError(404, 'Cliente não encontrado.');
  const c = readClient({ ...before, ...body });
  const active = body.active === undefined ? before.active : body.active ? 1 : 0;
  const changes = diff(before, { ...c, active }, [...Object.keys(c), 'active']);
  if (!Object.keys(changes).length) return;
  try {
    db.prepare(
      `UPDATE clients SET name=@name, city=@city, phone=@phone, email=@email, address=@address, document=@document, notes=@notes,
              active=@active, updated_at=@now WHERE id=@id`
    ).run({ ...c, active, id, now: nowIso() });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe um cliente com esse nome.');
    throw err;
  }
  audit(db, { actor: user, action: 'cliente_alterado', entity: 'client', entityId: id, ip: ctx && ctx.ip, summary: `Alterou o cadastro do cliente ${c.name}.`, details: changes });
}

function listClients(db, { q, all } = {}) {
  const where = all ? [] : ['c.active = 1'];
  const p = {};
  if (q) { where.push('c.name LIKE @q'); p.q = `%${q}%`; }
  return db
    .prepare(
      `SELECT c.*, COUNT(o.id) AS orders, MAX(o.created_at) AS last_order
         FROM clients c LEFT JOIN orders o ON o.client_id = c.id AND o.status <> 'cancelado'
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY c.id ORDER BY c.name`
    )
    .all(p);
}

function resolveClient(db, user, body, ctx) {
  if (body.client_id) {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(body.client_id));
    if (!c) throw new HttpError(400, 'Cliente não encontrado.');
    return c.id;
  }
  const name = str(body.client_name, 'o cliente', { required: true, max: 120 });
  const existing = db.prepare('SELECT id FROM clients WHERE name = ?').get(name);
  if (existing) return existing.id;
  return createClient(db, user, { name, phone: body.client_phone, city: body.client_city }, ctx);
}

// ---------- pedidos ----------

function readLines(db, user, lines, before = []) {
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Adicione pelo menos um produto ao pedido.');
  if (lines.length > 50) throw new HttpError(400, 'Muitos itens em um pedido.');
  const prices = canSeePrices(user);
  return lines.map((l, i) => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(l.item_id));
    if (!item) throw new HttpError(400, `Produto da linha ${i + 1} não encontrado.`);
    const old = l.id ? before.find((b) => b.id === Number(l.id)) : null;
    if (l.id && !old) throw new HttpError(400, 'Item do pedido inválido.');
    if (!old && !item.active) throw new HttpError(400, `O item "${item.name}" está desativado.`);
    const quantity = round3(num(l.quantity, `a quantidade de ${item.name}`, { positive: true, max: 1e9 }));
    if (old && quantity < old.packed) {
      throw new HttpError(400, `${item.name}: já foram empacotadas ${fmtNum(old.packed)}; a quantidade não pode ser menor.`);
    }
    const unitPrice = prices ? round3(num(l.unit_price ?? 0, `o preço de ${item.name}`, { min: 0, max: 1e7 })) : old ? old.unit_price : 0;
    return { id: old ? old.id : null, item, quantity, unit_price: unitPrice, packed: old ? old.packed : 0 };
  });
}

/** Deixa a conta a receber do pedido igual ao valor ainda não recebido. */
function syncReceivable(db, user, orderId, ctx) {
  const o = db.prepare('SELECT o.*, c.name AS client_name FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = ?').get(orderId);
  const entries = db.prepare('SELECT * FROM finance_entries WHERE order_id = ? AND canceled_at IS NULL ORDER BY id').all(orderId);
  const paid = entries.filter((e) => e.paid_at).reduce((a, e) => a + e.amount, 0);
  const open = entries.filter((e) => !e.paid_at);
  const due = o.status === 'cancelado' ? 0 : round3(o.total - paid);
  const reason = o.status === 'cancelado' ? `Pedido #${o.id} cancelado` : `Valor do pedido #${o.id} alterado`;
  if (due <= 0) {
    for (const e of open) finance.cancelEntry(db, user, e.id, reason, ctx, { silentIfCanceled: true });
    return;
  }
  const description = `Pedido #${o.id} — ${o.client_name}`;
  const dueDate = o.due_date || localDate(o.created_at);
  if (!open.length) {
    finance.insertEntry(db, user, {
      kind: 'receita', category_id: finance.categoryId(db, 'receita', 'Vendas'), description, amount: due,
      date: localDate(o.created_at), due_date: dueDate, counterparty: o.client_name, order_id: o.id,
    });
    return;
  }
  const [first, ...rest] = open;
  db.prepare('UPDATE finance_entries SET amount = ?, due_date = ?, description = ?, counterparty = ?, updated_at = ? WHERE id = ?')
    .run(due, dueDate, description, o.client_name, nowIso(), first.id);
  for (const e of rest) finance.cancelEntry(db, user, e.id, reason, ctx, { silentIfCanceled: true });
}

function recomputeStatus(db, orderId) {
  const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  if (!o || ['saiu', 'entregue', 'cancelado'].includes(o.status)) return;
  const lines = db.prepare('SELECT quantity, packed FROM order_items WHERE order_id = ?').all(orderId);
  const all = lines.length && lines.every((l) => l.packed >= l.quantity - 1e-9);
  const any = lines.some((l) => l.packed > 0);
  const status = all ? 'pronto' : any ? 'parcial' : 'aberto';
  if (status !== o.status) db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), orderId);
}

/** Soma (ou desconta, no estorno) folhas empacotadas em um item do pedido. */
function addPacked(db, orderItemId, delta) {
  db.prepare('UPDATE order_items SET packed = max(0, round(packed + ?, 3)) WHERE id = ?').run(delta, orderItemId);
  const { order_id: orderId } = db.prepare('SELECT order_id FROM order_items WHERE id = ?').get(orderItemId);
  recomputeStatus(db, orderId);
  return orderId;
}

function saveLines(db, orderId, lines) {
  const keep = lines.filter((l) => l.id).map((l) => l.id);
  const current = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  for (const c of current) {
    if (keep.includes(c.id)) continue;
    if (c.packed > 0) throw new HttpError(400, 'Não é possível tirar do pedido um produto que já foi empacotado.');
    db.prepare('DELETE FROM order_items WHERE id = ?').run(c.id);
  }
  for (const l of lines) {
    if (l.id) db.prepare('UPDATE order_items SET quantity = ?, unit_price = ? WHERE id = ?').run(l.quantity, l.unit_price, l.id);
    else db.prepare('INSERT INTO order_items (order_id, item_id, quantity, unit_price) VALUES (?, ?, ?, ?)').run(orderId, l.item.id, l.quantity, l.unit_price);
  }
  const total = round3(lines.reduce((a, l) => a + l.quantity * l.unit_price, 0));
  db.prepare('UPDATE orders SET total = ?, updated_at = ? WHERE id = ?').run(total, nowIso(), orderId);
  return total;
}

const linesText = (lines) => lines.map((l) => `${fmtNum(l.quantity)} ${plural(l.item.unit, l.quantity)} de ${l.item.name}`).join(', ');

const readChannel = (v) => (v === undefined || v === null || v === '' ? null : oneOf(v, 'por onde chegou', CHANNELS));
const readInvoice = (v) => str(v, 'número da nota fiscal', { max: 40 });

function createOrder(db, user, body, ctx) {
  const dueDate = dateOrNull(body.due_date, 'data de entrega');
  const notes = str(body.notes, 'observações', { max: 1000 });
  const channel = readChannel(body.channel);
  const invoice = readInvoice(body.invoice_number);
  const id = db.transaction(() => {
    const clientId = resolveClient(db, user, body, ctx);
    const lines = readLines(db, user, body.items);
    const exception = checkRules(db, user, clientId, lines, body);
    const now = nowIso();
    const orderId = Number(
      db.prepare(
        `INSERT INTO orders (client_id, due_date, notes, channel, invoice_number, invoice_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(clientId, dueDate, notes, channel, invoice, invoice ? now : null, user.id, now, now).lastInsertRowid
    );
    const total = saveLines(db, orderId, lines);
    syncReceivable(db, user, orderId, ctx);
    const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(clientId).name;
    audit(db, {
      actor: user, action: 'pedido_criado', entity: 'order', entityId: orderId, ip: ctx && ctx.ip,
      summary: `Pedido #${orderId} de ${client}${channel ? ` (${channel})` : ''}: ${linesText(lines)}` +
        (dueDate ? ` — entrega ${dueDate.split('-').reverse().join('/')}` : '') + (total ? ` — ${finance.brl(total)}` : '') +
        (invoice ? ` — NF ${invoice}` : '') + (exception ? ` — EXCEÇÃO liberada pela administração: ${exception}` : ''),
      details: { client_id: clientId, due_date: dueDate, total, channel, invoice_number: invoice, exception },
    });
    return orderId;
  })();
  return getOrder(db, user, id);
}

function updateOrder(db, user, id, body, ctx) {
  const before = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!before) throw new HttpError(404, 'Pedido não encontrado.');
  if (['entregue', 'cancelado'].includes(before.status)) throw new HttpError(400, 'Pedido entregue ou cancelado não pode ser alterado.');
  const beforeLines = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  db.transaction(() => {
    const data = {
      client_id: body.client_id || body.client_name ? resolveClient(db, user, body, ctx) : before.client_id,
      due_date: body.due_date === undefined ? before.due_date : dateOrNull(body.due_date, 'data de entrega'),
      notes: body.notes === undefined ? before.notes : str(body.notes, 'observações', { max: 1000 }),
      channel: body.channel === undefined ? before.channel : readChannel(body.channel),
      invoice_number: body.invoice_number === undefined ? before.invoice_number : readInvoice(body.invoice_number),
    };
    const lines = body.items ? readLines(db, user, body.items, beforeLines) : null;
    // As regras valem quando muda o que foi pedido ou o cliente (pedidos antigos continuam como estão).
    const exception = lines || data.client_id !== before.client_id
      ? checkRules(db, user, data.client_id, lines || beforeLines, body)
      : null;
    const invoiceAt = data.invoice_number && data.invoice_number !== before.invoice_number ? nowIso() : data.invoice_number ? before.invoice_at : null;
    db.prepare('UPDATE orders SET client_id = ?, due_date = ?, notes = ?, channel = ?, invoice_number = ?, invoice_at = ?, updated_at = ? WHERE id = ?')
      .run(data.client_id, data.due_date, data.notes, data.channel, data.invoice_number, invoiceAt, nowIso(), id);
    let total = before.total;
    if (lines) total = saveLines(db, id, lines);
    recomputeStatus(db, id);
    syncReceivable(db, user, id, ctx);
    audit(db, {
      actor: user, action: 'pedido_alterado', entity: 'order', entityId: id, ip: ctx && ctx.ip,
      summary: `Alterou o pedido #${id}.` + (total !== before.total ? ` Valor: ${finance.brl(before.total)} → ${finance.brl(total)}.` : '') +
        (exception ? ` EXCEÇÃO liberada pela administração: ${exception}` : ''),
      details: { ...diff(before, data, Object.keys(data)), ...(body.items ? { items: body.items } : {}), exception },
    });
  })();
  return getOrder(db, user, id);
}

/** Nota fiscal emitida (pode ser registrada até depois da entrega). */
function setInvoice(db, user, id, body, ctx) {
  const o = db.prepare('SELECT o.*, c.name AS client_name FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = ?').get(id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado.');
  if (o.status === 'cancelado') throw new HttpError(400, 'Pedido cancelado.');
  const invoice = str(body.invoice_number, 'o número da nota fiscal', { required: true, max: 40 });
  db.transaction(() => {
    db.prepare('UPDATE orders SET invoice_number = ?, invoice_at = ?, updated_at = ? WHERE id = ?').run(invoice, nowIso(), nowIso(), id);
    audit(db, {
      actor: user, action: 'pedido_alterado', entity: 'order', entityId: id, ip: ctx && ctx.ip,
      summary: `Nota fiscal ${invoice} do pedido #${id} (${o.client_name})` + (o.invoice_number ? ` (antes: ${o.invoice_number}).` : '.'),
    });
  })();
  return getOrder(db, user, id);
}

function shipOrder(db, user, id, body, ctx) {
  const o = db.prepare('SELECT o.*, c.name AS client_name FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = ?').get(id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado.');
  if (!['aberto', 'parcial', 'pronto'].includes(o.status)) throw new HttpError(400, `Pedido está "${STATUS_LABELS[o.status]}".`);
  const carrier = str(body.carrier, 'quem levou', { max: 120 });
  db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'saiu', shipped_at = ?, shipped_by = ?, carrier = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), user.id, carrier, nowIso(), id);
    audit(db, {
      actor: user, action: 'pedido_saiu', entity: 'order', entityId: id, ip: ctx && ctx.ip,
      summary: `Pedido #${id} (${o.client_name}) saiu para entrega${carrier ? ` com ${carrier}` : ''}.` +
        (o.status !== 'pronto' ? ' Atenção: ainda não estava todo empacotado.' : ''),
    });
  })();
  return getOrder(db, user, id);
}

function deliverOrder(db, user, id, body, ctx) {
  const o = db.prepare('SELECT o.*, c.name AS client_name FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = ?').get(id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado.');
  if (!OPEN_STATUSES.includes(o.status)) throw new HttpError(400, `Pedido está "${STATUS_LABELS[o.status]}".`);
  const receivedBy = str(body.received_by, 'quem recebeu', { max: 120 });
  const notes = str(body.notes, 'observação da entrega', { max: 500 });
  db.transaction(() => {
    db.prepare(
      `UPDATE orders SET status = 'entregue', delivered_at = ?, delivered_by = ?, received_by = ?, delivery_notes = ?, updated_at = ?
        WHERE id = ?`
    ).run(nowIso(), user.id, receivedBy, notes, nowIso(), id);
    audit(db, {
      actor: user, action: 'pedido_entregue', entity: 'order', entityId: id, ip: ctx && ctx.ip,
      summary: `Pedido #${id} entregue a ${o.client_name}${receivedBy ? ` (recebido por ${receivedBy})` : ''}.` +
        (!['pronto', 'saiu'].includes(o.status) ? ' Atenção: entregue sem estar todo empacotado.' : ''),
    });
  })();
  return getOrder(db, user, id);
}

function cancelOrder(db, user, id, body, ctx) {
  const o = db.prepare('SELECT o.*, c.name AS client_name FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = ?').get(id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado.');
  if (['entregue', 'cancelado'].includes(o.status)) throw new HttpError(400, `Pedido já está "${STATUS_LABELS[o.status]}".`);
  const reason = str(body.reason, 'o motivo do cancelamento', { required: true, max: 300 });
  const packed = db.prepare('SELECT COALESCE(SUM(packed),0) AS v FROM order_items WHERE order_id = ?').get(id).v;
  db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'cancelado', canceled_at = ?, canceled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), user.id, reason, nowIso(), id);
    syncReceivable(db, user, id, ctx);
    audit(db, {
      actor: user, action: 'pedido_cancelado', entity: 'order', entityId: id, ip: ctx && ctx.ip,
      summary: `Cancelou o pedido #${id} (${o.client_name}). Motivo: ${reason}` +
        (packed > 0 ? ` — ${fmtNum(packed)} folhas já estavam empacotadas (continuam fora do estoque até um ajuste).` : ''),
    });
  })();
  return getOrder(db, user, id);
}

function decorate(db, user, o, lines) {
  const today = localDate();
  const prices = canSeePrices(user);
  const out = {
    ...o,
    status_label: STATUS_LABELS[o.status],
    outside: isOutside(o.client_city),
    late: OPEN_STATUSES.includes(o.status) && o.due_date && o.due_date < today,
    items: lines.map((l) => ({
      ...l,
      unit_price: prices ? l.unit_price : undefined,
      remaining: round3(Math.max(0, l.quantity - l.packed)),
    })),
    quantity_total: round3(lines.reduce((a, l) => a + l.quantity, 0)),
    packed_total: round3(lines.reduce((a, l) => a + Math.min(l.packed, l.quantity), 0)),
  };
  if (!prices) delete out.total;
  if (canSeePrices(user)) {
    const e = db
      .prepare('SELECT COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN amount END),0) AS paid, COALESCE(SUM(amount),0) AS total FROM finance_entries WHERE order_id = ? AND canceled_at IS NULL')
      .get(o.id);
    out.payment = { paid: round3(e.paid), open: round3(e.total - e.paid), status: o.total <= 0 ? 'sem_valor' : e.paid >= o.total - 0.005 ? 'pago' : e.paid > 0 ? 'parcial' : 'pendente' };
  }
  return out;
}

const ORDER_SELECT = `
  SELECT o.*, c.name AS client_name, c.phone AS client_phone, c.address AS client_address, c.city AS client_city,
         u.name AS created_by_name, ud.name AS delivered_by_name, us.name AS shipped_by_name
    FROM orders o
    JOIN clients c ON c.id = o.client_id
    JOIN users u ON u.id = o.created_by
    LEFT JOIN users ud ON ud.id = o.delivered_by
    LEFT JOIN users us ON us.id = o.shipped_by`;

function linesFor(db, ids) {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT oi.*, i.name AS item_name, i.unit, i.quantity AS stock
         FROM order_items oi JOIN items i ON i.id = oi.item_id
        WHERE oi.order_id IN (${ids.map(() => '?').join(',')}) ORDER BY oi.id`
    )
    .all(...ids);
  const map = new Map(ids.map((id) => [id, []]));
  for (const r of rows) map.get(r.order_id).push(r);
  return map;
}

function getOrder(db, user, id) {
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado.');
  return decorate(db, user, o, linesFor(db, [id]).get(id));
}

function listOrders(db, user, q = {}) {
  const where = [];
  const p = {};
  const today = localDate();
  if (q.status === 'abertos') where.push(`o.status IN ('aberto','parcial')`);
  else if (q.status === 'para_entregar') where.push(`o.status IN ('pronto','saiu')`);
  else if (q.status === 'atrasados') { where.push(`o.status IN ('aberto','parcial','pronto','saiu') AND o.due_date < @today`); p.today = today; }
  else if (q.status === 'em_andamento') where.push(`o.status IN ('aberto','parcial','pronto','saiu')`);
  else if (q.status && STATUS_LABELS[q.status]) { where.push('o.status = @status'); p.status = q.status; }
  if (q.client_id) { where.push('o.client_id = @client_id'); p.client_id = Number(q.client_id); }
  if (q.q) { where.push("(c.name LIKE @q OR CAST(o.id AS TEXT) = @qid)"); p.q = `%${q.q}%`; p.qid = String(q.q).replace('#', ''); }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const open = !q.status || ['abertos', 'para_entregar', 'atrasados', 'em_andamento'].includes(q.status);
  const orderBy = open ? "CASE WHEN o.due_date IS NULL THEN 1 ELSE 0 END, o.due_date, o.id" : 'o.id DESC';
  const rows = db.prepare(`${ORDER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} LIMIT ${limit + 1} OFFSET ${offset}`).all(p);
  const page = rows.slice(0, limit);
  const lines = linesFor(db, page.map((o) => o.id));
  const counts = db
    .prepare(
      `SELECT
         SUM(status IN ('aberto','parcial')) AS abertos,
         SUM(status IN ('pronto','saiu')) AS para_entregar,
         SUM(status IN ('aberto','parcial','pronto','saiu') AND due_date < ?) AS atrasados
       FROM orders`
    )
    .get(today);
  return { orders: page.map((o) => decorate(db, user, o, lines.get(o.id))), has_more: rows.length > limit, counts };
}

/** Pedidos em andamento com itens ainda por empacotar (para a tela de empacotamento). */
function packableOrders(db, user) {
  return listOrders(db, user, { status: 'em_andamento', limit: 200 }).orders.filter((o) => o.items.some((l) => l.remaining > 0));
}

module.exports = {
  STATUS_LABELS, OPEN_STATUSES, CHANNELS, canSeePrices, createClient, updateClient, listClients, orderRules, isOutside,
  createOrder, updateOrder, setInvoice, shipOrder, deliverOrder, cancelOrder, getOrder, listOrders, packableOrders,
  addPacked, recomputeStatus, syncReceivable,
};
