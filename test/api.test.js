'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { openDb, migrate, MIGRATIONS } = require('../server/db');
const { createApp } = require('../server/app');
const { seedIfEmpty, INITIAL_PIN } = require('../server/seed');
const { forecastItem } = require('../server/services/forecast');
const { toCsv } = require('../server/csv');
const { runSchedules } = require('../server/scheduler');

let db;
let server;
let base;

before(async () => {
  db = openDb(':memory:');
  seedIfEmpty(db, { log: () => {} });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

const userId = (name) => db.prepare('SELECT id FROM users WHERE name = ?').get(name).id;
const itemId = (name) => db.prepare('SELECT id FROM items WHERE name = ?').get(name).id;
const qty = (name) => db.prepare('SELECT quantity FROM items WHERE name = ?').get(name).quantity;
const PAPEL = 'Papel branco 46x66';
const OFERTA = 'Oferta 46x66';
const APROVEITE = 'Aproveite 46x66';

/** Cliente HTTP simples que guarda o cookie de sessão. */
function client() {
  let cookie = '';
  const call = async (method, path, body, { csrf = true } = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-Requested-With'] = 'gsc';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}, o) => call('POST', p, b, o),
    put: (p, b = {}) => call('PUT', p, b),
    async login(name, pin = INITIAL_PIN) {
      const r = await call('POST', '/api/auth/login', { user_id: userId(name), pin });
      assert.equal(r.status, 200, `login de ${name}: ${JSON.stringify(r.data)}`);
      return this;
    },
  };
}

const ok = (r, status = 201) => {
  assert.equal(r.status, status, JSON.stringify(r.data));
  return r.data;
};

// ---------- acesso ----------

test('lista as 5 pessoas na tela de login', async () => {
  const r = await client().get('/api/auth/users');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map((u) => u.name).sort(), ['Eulir', 'Gabrielle', 'Joatan', 'Márcia', 'Natan']);
});

test('sem login a API responde 401', async () => {
  assert.equal((await client().get('/api/items')).status, 401);
});

test('requisições que alteram dados exigem o cabeçalho anti-CSRF', async () => {
  const c = await client().login('Márcia');
  const r = await c.post('/api/ops/entrada', { item_id: itemId(PAPEL), quantity: 1 }, { csrf: false });
  assert.equal(r.status, 403);
});

test('PIN errado conta tentativas e bloqueia depois de 5', async () => {
  const c = client();
  for (let i = 1; i <= 4; i++) {
    assert.equal((await c.post('/api/auth/login', { user_id: userId('Joatan'), pin: '0000' })).status, 401);
  }
  assert.equal((await c.post('/api/auth/login', { user_id: userId('Joatan'), pin: '0000' })).status, 429);
  assert.equal((await c.post('/api/auth/login', { user_id: userId('Joatan'), pin: INITIAL_PIN })).status, 429);
  db.prepare('UPDATE users SET locked_until = NULL WHERE name = ?').run('Joatan');
});

// ---------- itens e estoque ----------

test('cadastro inicial: papéis por formato, impressos por modelo, tinta e chapa', () => {
  const items = db.prepare('SELECT name, category, source, made_from_item_id FROM items ORDER BY sort_order').all();
  assert.equal(items.filter((i) => i.category === 'impresso').length, 6);
  const oferta = items.find((i) => i.name === OFERTA);
  assert.equal(oferta.made_from_item_id, itemId(PAPEL));
  assert.ok(items.find((i) => i.name === 'Chapa de impressão'));
});

test('administração ajusta embalagem, alertas e detalhes do item', async () => {
  const c = await client().login('Márcia');
  const r = ok(await c.put(`/api/items/${itemId(PAPEL)}`, {
    pack_unit: 'resma', pack_size: 500, min_stock: 5000, alert_days: 10, lead_time_days: 7, brand: 'Chamex', grammage: 56, barcode: '7891234567895',
  }), 200);
  assert.equal(r.pack_size, 500);
  assert.equal(r.grammage, 56);
  const tinta = ok(await c.put(`/api/items/${itemId('Tinta amarela')}`, { color_name: 'Amarelo ouro', color_hex: '#FFC20E' }), 200);
  assert.equal(tinta.color_hex, '#ffc20e');
  assert.equal((await c.put(`/api/items/${itemId('Tinta amarela')}`, { color_hex: 'amarelo' })).status, 400);
  const byCode = ok(await c.get('/api/items/barcode/7891234567895'), 200);
  assert.equal(byCode.name, PAPEL);
  const log = db.prepare("SELECT summary FROM audit_log WHERE action = 'item_alterado' ORDER BY id DESC LIMIT 1").get();
  assert.match(log.summary, /código da cor/);
});

test('entrada em resmas vira folhas; com valor gera despesa a pagar', async () => {
  const c = await client().login('Márcia');
  const r = ok(await c.post('/api/ops/entrada', {
    item_id: itemId(PAPEL), quantity: 40, unit: 'pack', supplier: 'Papel Norte', total_cost: 3200, paid: false, due_date: '2030-01-10',
  }));
  assert.equal(qty(PAPEL), 20000);
  assert.match(r.operation.summary, /20\.000 folhas \(40 resmas\)/);
  const e = db.prepare('SELECT * FROM finance_entries WHERE operation_id = ?').get(r.operation.id);
  assert.equal(e.kind, 'despesa');
  assert.equal(e.amount, 3200);
  assert.equal(e.paid_at, null);
  assert.equal(e.due_date, '2030-01-10');
  assert.equal(db.prepare('SELECT last_unit_cost FROM items WHERE id = ?').get(itemId(PAPEL)).last_unit_cost, 0.16);
});

test('sem permissão de financeiro não informa valor, mas registra a entrada', async () => {
  const c = await client().login('Gabrielle');
  assert.equal((await c.post('/api/ops/entrada', { item_id: itemId('Tinta amarela'), quantity: 10, total_cost: 400 })).status, 403);
  ok(await c.post('/api/ops/entrada', { item_id: itemId('Tinta amarela'), quantity: 10 }));
  ok(await c.post('/api/ops/entrada', { item_id: itemId('Chapa de impressão'), quantity: 40 }));
  assert.equal(qty('Tinta amarela'), 10);
  const items = ok(await c.get('/api/items'), 200);
  assert.equal(items[0].last_unit_cost, undefined);
});

test('empacotadora não pode registrar impressão nem entrada', async () => {
  const c = await client().login('Eulir');
  assert.equal((await c.post('/api/ops/impressao', { product_id: itemId(OFERTA), input_qty: 100 })).status, 403);
  assert.equal((await c.post('/api/ops/entrada', { item_id: itemId(PAPEL), quantity: 1 })).status, 403);
});

test('impressão: papel sai, produto entra, chapa e tinta descontadas', async () => {
  const c = await client().login('Natan');
  const r = ok(await c.post('/api/ops/impressao', {
    product_id: itemId(OFERTA), input_qty: 10, input_unit: 'pack', waste_qty: 30,
    extras: [{ item_id: itemId('Chapa de impressão'), quantity: 2 }, { item_id: itemId('Tinta amarela'), quantity: 0.5 }],
  }));
  assert.equal(qty(PAPEL), 15000);
  assert.equal(qty(OFERTA), 4970);
  assert.equal(qty('Chapa de impressão'), 38);
  assert.equal(qty('Tinta amarela'), 9.5);
  assert.match(r.operation.summary, /Tinta amarela \(0,5 litro\)/);
  ok(await c.post('/api/ops/impressao', { product_id: itemId(APROVEITE), input_qty: 2000 }));
  assert.equal(qty(APROVEITE), 2000);
});

test('impressão: perda maior que o usado e produto que não é impresso são recusados', async () => {
  const c = await client().login('Natan');
  assert.equal((await c.post('/api/ops/impressao', { product_id: itemId(OFERTA), input_qty: 10, waste_qty: 11 })).status, 400);
  assert.equal((await c.post('/api/ops/impressao', { product_id: itemId(PAPEL), input_qty: 10 })).status, 400);
});

// ---------- pedidos até a entrega ----------

let orderId;

test('secretaria cria pedido com preços; impressor não cria e não vê valores', async () => {
  const gabi = await client().login('Gabrielle');
  const o = ok(await gabi.post('/api/orders', {
    client_name: 'Supermercado Cohama', due_date: '2030-01-05',
    items: [{ item_id: itemId(OFERTA), quantity: 3000, unit_price: 0.4 }, { item_id: itemId(APROVEITE), quantity: 1000, unit_price: 0.5 }],
  }));
  orderId = o.id;
  assert.equal(o.status, 'aberto');
  assert.equal(o.total, 1700);
  const rec = db.prepare("SELECT * FROM finance_entries WHERE order_id = ? AND kind = 'receita'").get(o.id);
  assert.equal(rec.amount, 1700);
  assert.equal(rec.due_date, '2030-01-05');

  const natan = await client().login('Natan');
  assert.equal((await natan.post('/api/orders', { client_name: 'X', items: [{ item_id: itemId(OFERTA), quantity: 1 }] })).status, 403);
  const seen = ok(await natan.get(`/api/orders/${o.id}`), 200);
  assert.equal(seen.total, undefined);
  assert.equal(seen.items[0].unit_price, undefined);
});

test('empacotamento ligado ao pedido atualiza o andamento', async () => {
  const eulir = await client().login('Eulir');
  const packable = ok(await eulir.get('/api/packable-orders'), 200);
  const order = packable.find((o) => o.id === orderId);
  const [lineOferta, lineAprov] = order.items;
  const r = ok(await eulir.post('/api/ops/empacotamento', { order_item_id: lineOferta.id, packages: 10, per_package: 250, waste_qty: 5 }));
  assert.match(r.operation.summary, /pedido #\d+ \(Supermercado Cohama\)/);
  assert.equal(qty(OFERTA), 4970 - 2505);
  let o = ok(await eulir.get(`/api/orders/${orderId}`), 200);
  assert.equal(o.status, 'parcial');
  assert.equal(o.items[0].packed, 2500);

  const more = ok(await eulir.post('/api/ops/empacotamento', { order_item_id: lineOferta.id, packages: 3, per_package: 250 }));
  assert.equal(more.warnings.length, 1); // passou do que faltava
  // desfaz o excesso: o empacotado volta
  ok(await eulir.post(`/api/ops/${more.operation.id}/estorno`, { reason: 'passou do pedido' }));
  o = ok(await eulir.get(`/api/orders/${orderId}`), 200);
  assert.equal(o.items[0].packed, 2500);

  ok(await eulir.post('/api/ops/empacotamento', { order_item_id: lineOferta.id, packages: 2, per_package: 250 }));
  ok(await eulir.post('/api/ops/empacotamento', { order_item_id: lineAprov.id, packages: 4, per_package: 250 }));
  o = ok(await eulir.get(`/api/orders/${orderId}`), 200);
  assert.equal(o.status, 'pronto');
});

test('saída e entrega do pedido (empacotadora tem permissão de entrega)', async () => {
  const eulir = await client().login('Eulir');
  assert.equal(ok(await eulir.post(`/api/orders/${orderId}/ship`, { carrier: 'Moto' }), 200).status, 'saiu');
  const d = ok(await eulir.post(`/api/orders/${orderId}/deliver`, { received_by: 'Sr. João' }), 200);
  assert.equal(d.status, 'entregue');
  assert.equal(d.received_by, 'Sr. João');
  assert.equal((await eulir.post(`/api/orders/${orderId}/deliver`, {})).status, 400);
  const gabi = await client().login('Gabrielle');
  assert.equal((await gabi.put(`/api/orders/${orderId}`, { notes: 'x' })).status, 400);
});

test('pedido alterado e cancelado mantém a conta a receber em dia', async () => {
  const gabi = await client().login('Gabrielle');
  const o = ok(await gabi.post('/api/orders', { client_name: 'Padaria Sol', items: [{ item_id: itemId(OFERTA), quantity: 500, unit_price: 0.5 }] }));
  const edited = ok(await gabi.put(`/api/orders/${o.id}`, { items: [{ id: o.items[0].id, item_id: itemId(OFERTA), quantity: 800, unit_price: 0.5 }] }), 200);
  assert.equal(edited.total, 400);
  assert.equal(db.prepare('SELECT amount FROM finance_entries WHERE order_id = ? AND canceled_at IS NULL').get(o.id).amount, 400);
  assert.equal((await gabi.post(`/api/orders/${o.id}/cancel`, {})).status, 400); // precisa de motivo
  ok(await gabi.post(`/api/orders/${o.id}/cancel`, { reason: 'cliente desistiu' }), 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM finance_entries WHERE order_id = ? AND canceled_at IS NULL').get(o.id).n, 0);
});

// ---------- financeiro ----------

test('financeiro: só com permissão; despesa recorrente, pagamento e resumo do mês', async () => {
  const gabi = await client().login('Gabrielle');
  assert.equal((await gabi.get('/api/finance/summary')).status, 403);
  const m = await client().login('Márcia');
  const cats = ok(await m.get('/api/finance/categories'), 200).categories;
  const energia = cats.find((c) => c.name === 'Energia');
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const created = ok(await m.post('/api/finance/entries', {
    kind: 'despesa', category_id: energia.id, description: 'Conta de luz', amount: 350.9, date: today, due_date: today, repeat_months: 3,
  }));
  assert.equal(created.length, 3);
  assert.match(created[2].description, /\(3\/3\)/);
  const paid = ok(await m.post(`/api/finance/entries/${created[0].id}/pay`, { payment_method: 'Pix' }), 200);
  assert.equal(paid.status, 'pago');
  // recebe o pedido entregue
  const rec = db.prepare("SELECT id FROM finance_entries WHERE order_id = ? AND kind = 'receita'").get(orderId);
  ok(await m.post(`/api/finance/entries/${rec.id}/pay`, {}), 200);
  const order = ok(await m.get(`/api/orders/${orderId}`), 200);
  assert.equal(order.payment.status, 'pago');

  const s = ok(await m.get('/api/finance/summary'), 200);
  assert.ok(s.despesas >= 3200 + 350.9);
  assert.ok(s.receitas >= 1700);
  assert.equal(s.monthly.length, 12);
  assert.ok(s.material.per_sheet > 0); // papel com custo conhecido foi usado na impressão
  assert.equal((await m.post(`/api/finance/entries/${created[1].id}/cancel`, {})).status, 400);
  ok(await m.post(`/api/finance/entries/${created[1].id}/cancel`, { reason: 'duplicada' }), 200);
  assert.equal((await m.get('/api/finance/entries.csv')).status, 200);
});

test('dono acompanha tudo (inclusive o financeiro), mas não lança nem altera nada', async () => {
  const j = await client().login('Joatan');
  const me = ok(await j.get('/api/me'), 200);
  assert.equal(me.manager, false);
  assert.ok(me.perms.includes('ver_financeiro'));
  assert.ok(!me.perms.includes('financeiro'));
  ok(await j.get('/api/finance/summary'), 200);
  ok(await j.get('/api/finance/entries'), 200);
  ok(await j.get('/api/logs'), 200);
  assert.ok(ok(await j.get(`/api/orders/${orderId}`), 200).total > 0); // vê os valores dos pedidos
  assert.ok('last_unit_cost' in ok(await j.get('/api/items'), 200).find((i) => i.name === PAPEL));
  const attempts = [
    ['/api/finance/entries', { kind: 'despesa', category_id: 1, description: 'x', amount: 1, date: '2026-01-01' }],
    ['/api/ops/entrada', { item_id: itemId(PAPEL), quantity: 1 }],
    ['/api/ops/impressao', { product_id: itemId(OFERTA), input_qty: 1 }],
    ['/api/ops/ajuste', { item_id: itemId(PAPEL), counted: 1 }],
    ['/api/orders', { client_name: 'X', items: [{ item_id: itemId(OFERTA), quantity: 1 }] }],
    ['/api/items', { name: 'Z', category: 'outro', unit: 'un' }],
    ['/api/users', { name: 'Z', role: 'secretaria', pin: '4826' }],
  ];
  for (const [path, body] of attempts) assert.equal((await j.post(path, body)).status, 403, path);
  assert.equal((await j.put('/api/roles', { roles: {} })).status, 403);
  assert.equal((await j.put('/api/settings/notify', {})).status, 403);
  assert.equal((await j.get('/api/users')).status, 403);
  const op = db.prepare("SELECT id FROM operations WHERE type = 'impressao' AND reversed_by_id IS NULL ORDER BY id DESC").get();
  assert.equal((await j.post(`/api/ops/${op.id}/estorno`, { reason: 'x' })).status, 403);
});

test('estorno de compra com valor cancela a despesa', async () => {
  const m = await client().login('Márcia');
  const r = ok(await m.post('/api/ops/entrada', { item_id: itemId('Chapa de impressão'), quantity: 10, total_cost: 300, paid: true }));
  ok(await m.post(`/api/ops/${r.operation.id}/estorno`, { reason: 'nota lançada duas vezes' }));
  const e = db.prepare('SELECT canceled_at FROM finance_entries WHERE operation_id = ?').get(r.operation.id);
  assert.ok(e.canceled_at);
});

// ---------- estornos, ajustes, datas ----------

test('retirada que deixa saldo negativo é aceita com aviso', async () => {
  const c = await client().login('Natan');
  const r = ok(await c.post('/api/ops/retirada', { item_id: itemId('Tinta amarela'), quantity: 20, reason: 'Uso na máquina' }));
  assert.equal(r.warnings.length, 1);
  ok(await c.post(`/api/ops/${r.operation.id}/estorno`, { reason: 'teste' }));
  assert.equal(qty('Tinta amarela'), 9.5);
});

test('estorno: quem lançou desfaz o próprio; outros não; não estorna duas vezes', async () => {
  const natan = await client().login('Natan');
  const eulir = await client().login('Eulir');
  const r = ok(await natan.post('/api/ops/impressao', { product_id: itemId(OFERTA), input_qty: 1000 }));
  const id = r.operation.id;
  assert.equal((await eulir.post(`/api/ops/${id}/estorno`, { reason: 'não é meu' })).status, 403);
  assert.equal((await natan.post(`/api/ops/${id}/estorno`, {})).status, 400);
  ok(await natan.post(`/api/ops/${id}/estorno`, { reason: 'digitei errado' }));
  assert.equal((await natan.post(`/api/ops/${id}/estorno`, { reason: 'de novo' })).status, 400);
});

test('depois do prazo, só a administração estorna', async () => {
  const natan = await client().login('Natan');
  const r = ok(await natan.post('/api/ops/impressao', { product_id: itemId(OFERTA), input_qty: 500 }));
  db.prepare('UPDATE operations SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3600e3).toISOString(), r.operation.id);
  assert.equal((await natan.post(`/api/ops/${r.operation.id}/estorno`, { reason: 'tarde' })).status, 403);
  const marcia = await client().login('Márcia');
  ok(await marcia.post(`/api/ops/${r.operation.id}/estorno`, { reason: 'corrigindo' }));
});

test('ajuste de inventário: só administração, registra a diferença', async () => {
  const gabi = await client().login('Gabrielle');
  assert.equal((await gabi.post('/api/ops/ajuste', { item_id: itemId(PAPEL), counted: 1 })).status, 403);
  const marcia = await client().login('Márcia');
  const before = qty(PAPEL);
  const r = ok(await marcia.post('/api/ops/ajuste', { item_id: itemId(PAPEL), counted: before - 200 }));
  assert.equal(r.operation.movements[0].delta, -200);
});

test('datas: nada no futuro nem antigo demais para quem não é administração', async () => {
  const natan = await client().login('Natan');
  const old = new Date(Date.now() - 10 * 86400e3).toISOString();
  assert.equal((await natan.post('/api/ops/retirada', { item_id: itemId('Tinta amarela'), quantity: 1, reason: 'x', occurred_at: old })).status, 400);
  const future = new Date(Date.now() + 86400e3).toISOString();
  assert.equal((await natan.post('/api/ops/retirada', { item_id: itemId('Tinta amarela'), quantity: 1, reason: 'x', occurred_at: future })).status, 400);
  const yesterday = new Date(Date.now() - 86400e3);
  const local = new Date(yesterday.getTime() - 3 * 3600e3).toISOString().slice(0, 16);
  const r = ok(await natan.post('/api/ops/impressao', { product_id: itemId(OFERTA), input_qty: 800, occurred_at: local }));
  assert.ok(Math.abs(Date.parse(r.operation.occurred_at) - yesterday.getTime()) < 60e3);
});

// ---------- previsão e alertas ----------

test('previsão: média, dias restantes, alertas configuráveis e sugestões', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const item = { quantity: 10000, min_stock: 0, alert_days: 7, lead_time_days: 7, source: 'compra', pack_size: 500 };
  const stats = { consumed: 30000, consumed7: 10500, first: '2026-06-01T00:00:00Z' };
  const opts = { now, windowDays: 30, coverageDays: 30 };
  const f = forecastItem(item, stats, opts);
  assert.equal(f.avg_daily, 1000);
  assert.equal(f.avg_daily_7d, 1500);
  assert.equal(f.days_left, 10);
  assert.equal(f.runout_date, '2026-10-06');
  assert.equal(f.status, 'ok');
  assert.deepEqual(f.settings_hint, { min_stock: 10000, alert_days: 12 }); // 1000/dia × (7 + 3), avisar com 7 + 5 dias

  assert.equal(forecastItem({ ...item, quantity: 6000 }, stats, opts).status, 'repor'); // 6 dias < 7
  assert.equal(forecastItem({ ...item, quantity: 6000, alert_days: 0 }, stats, opts).status, 'ok'); // aviso por dias desligado
  const low = forecastItem({ ...item, quantity: 4000, min_stock: 5000, alert_days: 0 }, stats, opts);
  assert.equal(low.status, 'baixo');
  assert.equal(low.suggested_order, 38000); // 1000 × (7 + 30) + 5000 − 4000, em resmas
  const printed = forecastItem({ ...item, source: 'producao', quantity: 3000, alert_days: 5 }, stats, opts);
  assert.equal(printed.status_label, 'Produzir mais');
  assert.equal(forecastItem(item, { consumed: 3000, consumed7: 3000, first: '2026-09-23T12:00:00Z' }, opts).avg_daily, 1000);
  assert.equal(forecastItem(item, undefined, opts).days_left, null);
});

test('alerta é registrado quando o item fica abaixo do limite configurado', async () => {
  const marcia = await client().login('Márcia');
  ok(await marcia.post('/api/ops/ajuste', { item_id: itemId(PAPEL), counted: 4000 }));
  const alert = db.prepare("SELECT * FROM audit_log WHERE action = 'alerta' AND entity_id = ? ORDER BY id DESC").get(itemId(PAPEL));
  assert.ok(alert);
  assert.match(alert.summary, /estoque baixo/);
});

test('painel: produção por produto e pedidos; histórico do item', async () => {
  const c = await client().login('Joatan');
  const d = ok(await c.get('/api/dashboard?days=7'), 200);
  assert.equal(d.daily.length, 7);
  assert.ok(d.by_product.find((p) => p.name === OFERTA).printed > 0);
  assert.ok(d.orders.delivered >= 1);
  const h = ok(await c.get(`/api/items/${itemId(PAPEL)}/history?days=30`), 200);
  assert.equal(h.series.length, 30);
  assert.equal(h.series.at(-1).balance, qty(PAPEL));
});

// ---------- permissões configuráveis ----------

test('administração libera permissões por função (sem dar as exclusivas)', async () => {
  const marcia = await client().login('Márcia');
  const roles = ok(await marcia.get('/api/roles'), 200);
  const imp = roles.roles.find((r) => r.id === 'impressor');
  ok(await marcia.put('/api/roles', { roles: { impressor: [...imp.perms, 'pedidos', 'cadastros'] } }), 200);
  const natan = await client().login('Natan');
  const me = ok(await natan.get('/api/me'), 200);
  assert.ok(me.perms.includes('pedidos'));
  assert.ok(!me.perms.includes('cadastros'));
  ok(await natan.post('/api/orders', { client_name: 'Mercearia', items: [{ item_id: itemId(OFERTA), quantity: 100 }] }));
  ok(await marcia.put('/api/roles', { roles: { impressor: imp.perms } }), 200);
  assert.equal((await natan.post('/api/orders', { client_name: 'Mercearia', items: [{ item_id: itemId(OFERTA), quantity: 1 }] })).status, 403);
});

// ---------- avisos ----------

test('avisos por WhatsApp (Evolution API): configuração, teste e relatório semanal', async () => {
  const received = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, apikey: req.headers.apikey, body: JSON.parse(body) });
      res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"status":"PENDING"}');
    });
  }).listen(0);
  await new Promise((r) => fake.once('listening', r));
  try {
    const m = await client().login('Márcia');
    const saved = ok(await m.put('/api/settings/notify', {
      evolution: { enabled: true, url: `http://127.0.0.1:${fake.address().port}/`, instance: 'grafica', apikey: 'segredo-123', numbers: '(98) 98888-7777' },
      weekly: { weekday: 1, hour: 7 },
    }), 200);
    assert.equal(saved.config.evolution.apikey, ''); // segredo não volta para a tela
    assert.match(saved.config.evolution.apikey_saved, /-123/);
    // salvar de novo sem a chave mantém a chave
    ok(await m.put('/api/settings/notify', { evolution: { enabled: true, apikey: '' } }), 200);

    const t = ok(await m.post('/api/settings/test-notification', { channel: 'evolution' }), 200);
    assert.equal(t.sent, true);
    assert.equal(received[0].url, '/message/sendText/grafica');
    assert.equal(received[0].apikey, 'segredo-123');
    assert.deepEqual(Object.keys(received[0].body).sort(), ['number', 'text']);
    assert.equal(received[0].body.number, '5598988887777');

    const preview = ok(await m.get('/api/reports/weekly'), 200);
    assert.match(preview.text, /Produção/);
    assert.match(preview.text, /Pedidos/);
    assert.match(preview.text, /Financeiro/);

    // Segunda-feira 08:00 em São Luís = 11:00 UTC: sai o relatório semanal, uma vez só.
    const monday = new Date('2030-01-07T11:00:00Z');
    const sent = await runSchedules(db, monday);
    assert.ok(sent.includes('semanal'));
    assert.ok(received.some((r) => /resumo da semana/.test(r.body.text)));
    const again = await runSchedules(db, monday);
    assert.ok(!again.includes('semanal'));
  } finally {
    fake.close();
    const m = await client().login('Márcia');
    await m.put('/api/settings/notify', { evolution: { enabled: false } });
  }
});

// ---------- registros ----------

test('registro de auditoria e movimentos não podem ser alterados nem apagados', () => {
  assert.throws(() => db.prepare('UPDATE audit_log SET summary = ?').run('x'), /não pode ser alterado/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /não pode ser apagado/);
  assert.throws(() => db.prepare('DELETE FROM movements').run(), /estorno/);
});

test('logs: só quem tem permissão vê; exportação em CSV para Excel', async () => {
  const natan = await client().login('Natan');
  assert.equal((await natan.get('/api/logs')).status, 403);
  const gabi = await client().login('Gabrielle');
  const r = ok(await gabi.get('/api/logs?q=Impressão'), 200);
  assert.ok(r.logs.length > 0);
  const csv = await gabi.get('/api/logs.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.data.replace(/^﻿/, '').startsWith('#;Data/hora;Pessoa'));
  assert.equal(toCsv(['a', 'b'], [[1.5, 'x;y']]), '﻿a;b\r\n1,5;"x;y"\r\n');
  assert.equal(toCsv(['a'], [['=HYPERLINK("x")']]), '﻿a\r\n"\'=HYPERLINK(""x"")"\r\n');
});

test('troca de PIN: recusa PIN fraco e libera o acesso normal', async () => {
  const c = await client().login('Eulir');
  assert.equal(ok(await c.get('/api/me'), 200).user.must_change_pin, true);
  assert.equal((await c.post('/api/auth/change-pin', { current_pin: INITIAL_PIN, new_pin: '1234' })).status, 400);
  ok(await c.post('/api/auth/change-pin', { current_pin: INITIAL_PIN, new_pin: '4071' }), 200);
  assert.equal(ok(await c.get('/api/me'), 200).user.must_change_pin, false);
  await client().login('Eulir', '4071');
});

test('não deixa o sistema sem ninguém na Administração', async () => {
  const marcia = await client().login('Márcia');
  ok(await marcia.put(`/api/users/${userId('Joatan')}`, { role: 'secretaria' }), 200);
  assert.equal((await marcia.put(`/api/users/${userId('Márcia')}`, { role: 'secretaria' })).status, 400);
  await marcia.put(`/api/users/${userId('Joatan')}`, { role: 'dono' });
});

test('cadastro de item: estoque inicial, nome e código de barras únicos', async () => {
  const marcia = await client().login('Márcia');
  const r = ok(await marcia.post('/api/items', {
    name: 'Tinta vermelha', category: 'tinta', unit: 'litro', color_name: 'Vermelho', color_hex: '#d62828', alert_days: 10, initial_quantity: 8,
  }));
  assert.equal(r.quantity, 8);
  assert.equal((await marcia.post('/api/items', { name: 'tinta VERMELHA', category: 'tinta', unit: 'litro' })).status, 409);
  assert.equal((await marcia.post('/api/items', { name: 'Outra', category: 'tinta', unit: 'litro', barcode: '7891234567895' })).status, 409);
  assert.equal((await marcia.post('/api/items', { name: 'X', category: 'inexistente', unit: 'un' })).status, 400);
  const eulir = await client().login('Eulir', '4071');
  assert.equal((await eulir.post('/api/items', { name: 'Y', category: 'outro', unit: 'un' })).status, 403);
});

// ---------- migração ----------

test('banco da versão 1 é migrado sem perder dados', () => {
  const old = new Database(':memory:');
  old.exec(MIGRATIONS[0]);
  old.pragma('user_version = 1');
  const now = new Date().toISOString();
  old.prepare("INSERT INTO users (name, role, pin_hash, created_at) VALUES ('Márcia', 'admin', 'x', ?)").run(now);
  const ins = old.prepare('INSERT INTO items (name, category, source, unit, quantity, min_stock, lead_time_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)');
  ins.run('Folha branca', 'papel', 'compra', 'folha', 1000, 7, now, now);
  ins.run('Folha amarela', 'papel', 'producao', 'folha', 500, 0, now, now);
  old.prepare("INSERT INTO processes (name, kind, input_item_id, output_item_id, roles, created_at) VALUES ('Impressão', 'impressao', 1, 2, 'impressor', ?)").run(now);
  old.prepare("INSERT INTO operations (type, user_id, summary, occurred_at, created_at) VALUES ('entrada', 1, 'x', ?, ?)").run(now, now);
  old.prepare('INSERT INTO movements (operation_id, item_id, delta, balance_after, occurred_at, created_at) VALUES (1, 1, 1000, 1000, ?, ?)').run(now, now);
  migrate(old);
  assert.equal(old.pragma('user_version', { simple: true }), MIGRATIONS.length);
  const items = old.prepare('SELECT * FROM items ORDER BY id').all();
  assert.equal(items[0].quantity, 1000);
  assert.equal(items[0].alert_days, 7);
  assert.equal(items[1].category, 'impresso');
  assert.equal(items[1].made_from_item_id, 1);
  assert.equal(old.pragma('foreign_key_check').length, 0);
  assert.equal(old.pragma('foreign_keys', { simple: true }), 1);
  old.close();
});

test('comando de emergência redefine o PIN direto no servidor', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { verifyPin } = require('../server/auth');
  const file = path.join(os.tmpdir(), `gsc-pin-${process.pid}.db`);
  const tmp = openDb(file);
  seedIfEmpty(tmp, { log: () => {} });
  tmp.close();
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'server', 'reset-pin.js'), 'Márcia', '5827'], {
    env: { ...process.env, DB_PATH: file },
  }).toString();
  assert.match(out, /redefinido/);
  const check = openDb(file);
  const u = check.prepare("SELECT * FROM users WHERE name = 'Márcia'").get();
  assert.ok(verifyPin('5827', u.pin_hash));
  assert.equal(u.must_change_pin, 1);
  assert.ok(check.prepare("SELECT 1 FROM audit_log WHERE action = 'pin_redefinido'").get());
  check.close();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) require('node:fs').rmSync(f, { force: true });
});
