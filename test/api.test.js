'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { seedIfEmpty, INITIAL_PIN } = require('../server/seed');
const { forecastItem } = require('../server/services/forecast');
const { toCsv } = require('../server/csv');

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
const procId = (name) => db.prepare('SELECT id FROM processes WHERE name = ?').get(name).id;

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

test('lista as 5 pessoas na tela de login', async () => {
  const r = await client().get('/api/auth/users');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map((u) => u.name).sort(), ['Eulir', 'Gabrielle', 'Joatan', 'Márcia', 'Natan']);
});

test('sem login a API responde 401', async () => {
  const r = await client().get('/api/items');
  assert.equal(r.status, 401);
});

test('requisições que alteram dados exigem o cabeçalho anti-CSRF', async () => {
  const c = await client().login('Márcia');
  const r = await c.post('/api/ops/entrada', { item_id: itemId('Folha branca'), quantity: 1 }, { csrf: false });
  assert.equal(r.status, 403);
});

test('PIN errado conta tentativas e bloqueia depois de 5', async () => {
  const c = client();
  for (let i = 1; i <= 4; i++) {
    const r = await c.post('/api/auth/login', { user_id: userId('Joatan'), pin: '0000' });
    assert.equal(r.status, 401);
  }
  const blocked = await c.post('/api/auth/login', { user_id: userId('Joatan'), pin: '0000' });
  assert.equal(blocked.status, 429);
  // Mesmo com o PIN certo, fica bloqueado até passar o tempo.
  const still = await c.post('/api/auth/login', { user_id: userId('Joatan'), pin: INITIAL_PIN });
  assert.equal(still.status, 429);
  const logs = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('login_falhou','login_bloqueado')").get().n;
  assert.ok(logs >= 5);
  db.prepare('UPDATE users SET locked_until = NULL WHERE name = ?').run('Joatan');
});

test('entrada em resmas vira folhas e fica no log', async () => {
  const c = await client().login('Gabrielle');
  const r = await c.post('/api/ops/entrada', { item_id: itemId('Folha branca'), quantity: 40, unit: 'pack', supplier: 'Papel Norte' });
  assert.equal(r.status, 201);
  assert.equal(qty('Folha branca'), 20000);
  assert.match(r.data.operation.summary, /20\.000 folhas \(40 resmas\)/);
  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'entrada' ORDER BY id DESC").get();
  assert.equal(log.user_name, 'Gabrielle');
});

test('empacotadora não pode registrar impressão nem entrada', async () => {
  const c = await client().login('Eulir');
  const imp = await c.post('/api/ops/producao', { process_id: procId('Impressão'), input_qty: 100 });
  assert.equal(imp.status, 403);
  const ent = await c.post('/api/ops/entrada', { item_id: itemId('Folha branca'), quantity: 1 });
  assert.equal(ent.status, 403);
});

test('impressão: folha branca sai, folha amarela entra, perda registrada', async () => {
  const c = await client().login('Natan');
  const r = await c.post('/api/ops/producao', { process_id: procId('Impressão'), input_qty: 10, input_unit: 'pack', waste_qty: 30 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(qty('Folha branca'), 15000);
  assert.equal(qty('Folha amarela (impressa)'), 4970);
  assert.equal(r.data.operation.waste_qty, 30);
  assert.equal(r.data.operation.can_undo, true);
});

test('perda maior que o total usado é recusada', async () => {
  const c = await client().login('Natan');
  const r = await c.post('/api/ops/producao', { process_id: procId('Impressão'), input_qty: 10, waste_qty: 11 });
  assert.equal(r.status, 400);
});

test('empacotamento consome pacotes × folhas + perda', async () => {
  const c = await client().login('Eulir');
  const r = await c.post('/api/ops/producao', {
    process_id: procId('Empacotamento'), packages: 10, per_package: 250, waste_qty: 5, client: 'Padaria Sol',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(qty('Folha amarela (impressa)'), 4970 - 2505);
  assert.equal(r.data.operation.output_qty, 2500);
  assert.match(r.data.operation.summary, /cliente: Padaria Sol/);
});

test('retirada que deixa saldo negativo é aceita com aviso', async () => {
  const c = await client().login('Natan');
  const r = await c.post('/api/ops/retirada', { item_id: itemId('Tinta amarela'), quantity: 1, reason: 'Uso na máquina' });
  assert.equal(r.status, 201);
  assert.equal(qty('Tinta amarela'), -1);
  assert.equal(r.data.warnings.length, 1);
  // desfaz para não afetar os próximos testes
  const u = await c.post(`/api/ops/${r.data.operation.id}/estorno`, { reason: 'teste' });
  assert.equal(u.status, 201);
  assert.equal(qty('Tinta amarela'), 0);
});

test('estorno: quem lançou desfaz o próprio; outros não; não estorna duas vezes', async () => {
  const natan = await client().login('Natan');
  const eulir = await client().login('Eulir');
  const r = await natan.post('/api/ops/producao', { process_id: procId('Impressão'), input_qty: 1000 });
  const id = r.data.operation.id;
  assert.equal(qty('Folha branca'), 14000);

  const denied = await eulir.post(`/api/ops/${id}/estorno`, { reason: 'não é meu' });
  assert.equal(denied.status, 403);
  const noReason = await natan.post(`/api/ops/${id}/estorno`, {});
  assert.equal(noReason.status, 400);

  const ok = await natan.post(`/api/ops/${id}/estorno`, { reason: 'digitei errado' });
  assert.equal(ok.status, 201);
  assert.equal(qty('Folha branca'), 15000);
  assert.equal(qty('Folha amarela (impressa)'), 2465);
  const orig = db.prepare('SELECT reversed_by_id FROM operations WHERE id = ?').get(id);
  assert.equal(orig.reversed_by_id, ok.data.operation.id);

  const again = await natan.post(`/api/ops/${id}/estorno`, { reason: 'de novo' });
  assert.equal(again.status, 400);
});

test('depois do prazo, só a administração estorna', async () => {
  const natan = await client().login('Natan');
  const r = await natan.post('/api/ops/producao', { process_id: procId('Impressão'), input_qty: 500 });
  const id = r.data.operation.id;
  db.prepare('UPDATE operations SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3600e3).toISOString(), id);
  const late = await natan.post(`/api/ops/${id}/estorno`, { reason: 'tarde demais' });
  assert.equal(late.status, 403);
  const marcia = await client().login('Márcia');
  const ok = await marcia.post(`/api/ops/${id}/estorno`, { reason: 'corrigindo' });
  assert.equal(ok.status, 201);
  assert.equal(qty('Folha branca'), 15000);
});

test('ajuste de inventário: só administração, registra a diferença', async () => {
  const gabi = await client().login('Gabrielle');
  const denied = await gabi.post('/api/ops/ajuste', { item_id: itemId('Folha branca'), counted: 1 });
  assert.equal(denied.status, 403);
  const marcia = await client().login('Márcia');
  const r = await marcia.post('/api/ops/ajuste', { item_id: itemId('Folha branca'), counted: 14800, note: 'contagem' });
  assert.equal(r.status, 201);
  assert.equal(qty('Folha branca'), 14800);
  assert.equal(r.data.operation.movements[0].delta, -200);
  const same = await marcia.post('/api/ops/ajuste', { item_id: itemId('Folha branca'), counted: 14800 });
  assert.match(same.data.operation.summary, /confere/);
});

test('não deixa lançar com data antiga demais (quem não é administração)', async () => {
  const natan = await client().login('Natan');
  const old = new Date(Date.now() - 10 * 86400e3).toISOString();
  const r = await natan.post('/api/ops/retirada', { item_id: itemId('Tinta amarela'), quantity: 1, reason: 'x', occurred_at: old });
  assert.equal(r.status, 400);
  const future = new Date(Date.now() + 86400e3).toISOString();
  const f = await natan.post('/api/ops/retirada', { item_id: itemId('Tinta amarela'), quantity: 1, reason: 'x', occurred_at: future });
  assert.equal(f.status, 400);
});

test('lançamento de ontem (data informada) entra no dia certo', async () => {
  const natan = await client().login('Natan');
  const yesterday = new Date(Date.now() - 86400e3);
  const local = new Date(yesterday.getTime() - 3 * 3600e3).toISOString().slice(0, 16); // horário de São Luís
  const r = await natan.post('/api/ops/producao', { process_id: procId('Impressão'), input_qty: 800, occurred_at: local });
  assert.equal(r.status, 201);
  assert.ok(Math.abs(Date.parse(r.data.operation.occurred_at) - yesterday.getTime()) < 60e3);
});

test('previsão: média diária, dias restantes, status e sugestão de compra', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const item = { quantity: 10000, min_stock: 5000, lead_time_days: 7, source: 'compra', pack_size: 500 };
  const stats = { consumed: 30000, consumed7: 10500, first: '2026-06-01T00:00:00Z' };
  const f = forecastItem(item, stats, { now, windowDays: 30, coverageDays: 30 });
  assert.equal(f.avg_daily, 1000);
  assert.equal(f.avg_daily_7d, 1500);
  assert.equal(f.days_left, 10);
  assert.equal(f.runout_date, '2026-10-06');
  assert.equal(f.status, 'ok');

  const low = forecastItem({ ...item, quantity: 4000 }, stats, { now, windowDays: 30, coverageDays: 30 });
  assert.equal(low.status, 'baixo');
  // 1000/dia × (7 + 30) + 5000 − 4000 = 38.000, arredondado para resmas de 500
  assert.equal(low.suggested_order, 38000);

  const soon = forecastItem({ ...item, quantity: 6000 }, stats, { now, windowDays: 30, coverageDays: 30 });
  assert.equal(soon.status, 'repor'); // 6 dias < 7 de reposição

  const fresh = forecastItem(item, { consumed: 3000, consumed7: 3000, first: '2026-09-23T12:00:00Z' }, { now, windowDays: 30, coverageDays: 30 });
  assert.equal(fresh.avg_daily, 1000); // só 3 dias de histórico: divide por 3, não por 30

  const none = forecastItem(item, undefined, { now, windowDays: 30, coverageDays: 30 });
  assert.equal(none.days_left, null);
});

test('alerta de estoque baixo é registrado quando o item piora', async () => {
  const marcia = await client().login('Márcia');
  await marcia.post('/api/ops/ajuste', { item_id: itemId('Folha branca'), counted: 9000 });
  const alert = db.prepare("SELECT * FROM audit_log WHERE action = 'alerta' AND entity_id = ? ORDER BY id DESC").get(itemId('Folha branca'));
  assert.ok(alert);
  assert.match(alert.summary, /Folha branca/);
  const items = await marcia.get('/api/items');
  const branca = items.data.find((i) => i.name === 'Folha branca');
  assert.equal(branca.forecast.status, 'baixo');
});

test('painel e histórico do item respondem com séries diárias', async () => {
  const c = await client().login('Joatan');
  const d = await c.get('/api/dashboard?days=7');
  assert.equal(d.status, 200);
  assert.equal(d.data.daily.length, 7);
  assert.ok(d.data.current.printed > 0);
  const h = await c.get(`/api/items/${itemId('Folha branca')}/history?days=30`);
  assert.equal(h.status, 200);
  assert.equal(h.data.series.length, 30);
  assert.equal(h.data.series.at(-1).balance, qty('Folha branca'));
});

test('registro de auditoria e movimentos não podem ser alterados nem apagados', () => {
  assert.throws(() => db.prepare('UPDATE audit_log SET summary = ?').run('x'), /não pode ser alterado/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /não pode ser apagado/);
  assert.throws(() => db.prepare('DELETE FROM movements').run(), /estorno/);
});

test('logs: só quem tem permissão vê; exportação em CSV para Excel', async () => {
  const natan = await client().login('Natan');
  assert.equal((await natan.get('/api/logs')).status, 403);
  const gabi = await client().login('Gabrielle');
  const r = await gabi.get('/api/logs?q=Impressão');
  assert.equal(r.status, 200);
  assert.ok(r.data.logs.length > 0);
  const csv = await gabi.get('/api/logs.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  // (o decodificador do fetch remove o BOM; ele é conferido no toCsv logo abaixo)
  assert.ok(csv.data.replace(/^\uFEFF/, '').startsWith('#;Data/hora;Pessoa'));
  assert.equal(toCsv(['a', 'b'], [[1.5, 'x;y']]), '\uFEFFa;b\r\n1,5;"x;y"\r\n');
  assert.equal(toCsv(['a'], [['=HYPERLINK("x")']]), '\uFEFFa\r\n"\'=HYPERLINK(""x"")"\r\n');
});

test('troca de PIN: recusa PIN fraco e libera o acesso normal', async () => {
  const c = await client().login('Natan');
  const me = await c.get('/api/me');
  assert.equal(me.data.user.must_change_pin, true);
  const weak = await c.post('/api/auth/change-pin', { current_pin: INITIAL_PIN, new_pin: '1234' });
  assert.equal(weak.status, 400);
  const ok = await c.post('/api/auth/change-pin', { current_pin: INITIAL_PIN, new_pin: '4071' });
  assert.equal(ok.status, 200);
  const me2 = await c.get('/api/me');
  assert.equal(me2.data.user.must_change_pin, false);
  await client().login('Natan', '4071');
});

test('não deixa o sistema sem Dono/Administração', async () => {
  const marcia = await client().login('Márcia');
  assert.equal((await marcia.put(`/api/users/${userId('Joatan')}`, { role: 'secretaria' })).status, 200);
  const r = await marcia.put(`/api/users/${userId('Márcia')}`, { role: 'secretaria' });
  assert.equal(r.status, 400);
  await marcia.put(`/api/users/${userId('Joatan')}`, { role: 'dono' });
});

test('cadastro de item com estoque inicial gera lançamento de ajuste', async () => {
  const marcia = await client().login('Márcia');
  const r = await marcia.post('/api/items', {
    name: 'Tinta preta', category: 'tinta', unit: 'litro', min_stock: 2, lead_time_days: 10, initial_quantity: 8,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.quantity, 8);
  const dup = await marcia.post('/api/items', { name: 'tinta PRETA', category: 'tinta', unit: 'litro' });
  assert.equal(dup.status, 409);
  const natan = await client().login('Natan', '4071');
  assert.equal((await natan.post('/api/items', { name: 'X', category: 'outro', unit: 'un' })).status, 403);
});
